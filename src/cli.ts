#!/usr/bin/env node
import { existsSync, mkdirSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfigFile, parseConfig } from './config/load.ts'
import { loadSecrets } from './secrets.ts'
import { runMechanical } from './mechanical/run.ts'
import { ensureMigrateGitExclude, isWorktreeDirty, worktreeDiff } from './git/worktree.ts'
import { resolveDshVersion } from './watch/dsh-version.ts'
import { decideWatch, describeWatchDecision } from './watch/gate.ts'
import { persistSeenState, readSeenState, STATE_BRANCH } from './watch/seen.ts'
import { createReportStore } from './reports/store.ts'
import { createDshRunner, formatSessionProgress } from './agents/dsh.ts'
import { createGithubPublisher } from './github/publish.ts'
import { writeGithubOutput } from './github/output.ts'
import { runPipeline } from './pipeline/orchestrator.ts'
import { checkoutHarness } from './harness/checkout.ts'
import { createQuotaQuery } from './quota/query.ts'
import { isQuotaError } from './quota/errors.ts'

const here = dirname(fileURLToPath(import.meta.url))

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

/** Line-buffered writes so GHA / docker logs show progress before the next agent step. */
function logLine(message: string): void {
  writeSync(1, `${message}\n`)
}

function resolveConfigPath(argv: readonly string[], workdir: string): string | undefined {
  const explicit = argValue(argv, '--config')
  if (explicit !== undefined) return resolve(workdir, explicit)
  const fallback = resolve(workdir, '.github/dsh-migrate.yml')
  return existsSync(fallback) ? fallback : undefined
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[2] ?? 'run'
  if (command === 'check-config') {
    const workdir = resolve(argValue(argv, '--workdir') ?? process.cwd())
    const configPath = resolveConfigPath(argv, workdir)
    const config = configPath === undefined || !existsSync(configPath)
      ? parseConfig({})
      : loadConfigFile(configPath)
    logLine(JSON.stringify(config, null, 2))
    return 0
  }
  if (command !== 'run') {
    process.stderr.write('usage: dsh-migrate run|check-config [--workdir DIR] [--config FILE] [--dsh-version VER] [--api-key-env NAME] [--quota-limit N] [--mechanical-only] [--skip-github] [--force]\n')
    return 2
  }

  const workdir = resolve(argValue(argv, '--workdir') ?? process.cwd())
  const appRoot = resolve(process.env.DSH_MIGRATE_APP_ROOT ?? resolve(here, '../..'))
  const configPath = resolveConfigPath(argv, workdir)
  const config = configPath === undefined || !existsSync(configPath)
    ? parseConfig({})
    : loadConfigFile(configPath)
  const requested = argValue(argv, '--dsh-version') ?? config.dshVersion
  const target = await resolveDshVersion(requested)
  const apiKeyEnv = argValue(argv, '--api-key-env') ?? config.secrets.apiKeyEnv
  const secrets = loadSecrets([workdir, appRoot, process.cwd()], { apiKeyEnv })
  const mechanicalOnly = hasFlag(argv, '--mechanical-only')
  const skipGithub = hasFlag(argv, '--skip-github') || mechanicalOnly
  const force = hasFlag(argv, '--force')
  const quotaLimitRaw = argValue(argv, '--quota-limit')
  if (quotaLimitRaw !== undefined) {
    const parsed = Number(quotaLimitRaw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      process.stderr.write('--quota-limit must be a number > 0\n')
      return 2
    }
    config.quota.limit = parsed
  }

  const previous = mechanicalOnly ? undefined : readSeenState(workdir)
  const decision = decideWatch({
    watchEnabled: config.watch.enabled,
    force,
    mechanicalOnly,
    current: target,
    previous,
  })
  logLine(describeWatchDecision(decision, target))
  if (decision.action === 'skip') {
    writeGithubOutput({
      status: 'skipped',
      skipped_review: 'true',
      target_tag: target.tag,
      previous_tag: decision.previous.tag,
    })
    logLine(JSON.stringify({
      status: 'skipped',
      target,
      previous: decision.previous,
    }, null, 2))
    return 0
  }

  const runId = `${target.version}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const runDir = resolve(process.env.DSH_MIGRATE_HOME ?? resolve(workdir, '.dsh-migrate'), 'runs', runId)
  mkdirSync(runDir, { recursive: true })
  ensureMigrateGitExclude(workdir)

  if (mechanicalOnly) {
    const mechanical = runMechanical(workdir, config)
    createReportStore(runDir).write('mechanical', mechanical.errors || mechanical.log)
    writeGithubOutput({
      status: mechanical.ok ? 'compatible' : 'failed',
      run_dir: runDir,
      mechanical_ok: mechanical.ok ? 'true' : 'false',
      skipped_review: 'true',
    })
    logLine(JSON.stringify({
      status: mechanical.ok ? 'compatible' : 'failed',
      target,
      runDir,
      mechanicalOk: mechanical.ok,
      errors: mechanical.errors,
    }, null, 2))
    return mechanical.ok ? 0 : 1
  }

  const apiKey = secrets.apiKey
  if (apiKey === undefined) {
    process.stderr.write(`${apiKeyEnv} is required (env or .secrets.local.json). Use --mechanical-only to skip the agent.\n`)
    return 1
  }

  const githubToken = secrets.githubToken
  if (!skipGithub && githubToken === undefined) {
    process.stderr.write('GITHUB_TOKEN missing; Issue/PR will be skipped. Pass --skip-github to silence this.\n')
  }

  const migrateHome = resolve(process.env.DSH_MIGRATE_HOME ?? resolve(workdir, '.dsh-migrate'))
  logLine(`stage: harness checkout ${target.tag}`)
  const harnessResult = checkoutHarness({
    tag: target.tag,
    dest: resolve(migrateHome, 'harness'),
  })
  if (!harnessResult.ok) {
    logLine(`harness checkout skipped: ${harnessResult.detail}`)
  } else {
    logLine(`harness source at ${harnessResult.path}`)
  }
  const harness = harnessResult.ok
    ? { path: harnessResult.path, tag: target.tag }
    : undefined

  const quotaQuery = createQuotaQuery({ provider: config.dsh.provider })
  const quota = {
    query: () => quotaQuery.query({ apiKey }),
  }

  let result
  try {
    result = await runPipeline({
      config,
      workdir,
      target,
      store: createReportStore(runDir),
      apiKey,
      runMechanical: () => runMechanical(workdir, config),
      isDirty: () => isWorktreeDirty(workdir),
      diff: () => worktreeDiff(workdir),
      agent: createDshRunner({
        ...(process.env.DSH_HOME === undefined ? {} : { dshHome: process.env.DSH_HOME }),
        reportDir: runDir,
        onStatus(progress) {
          logLine(`dsh: ${formatSessionProgress(progress)}`)
        },
        onLog(line) { logLine(line) },
      }),
      quota,
      ...(harness === undefined ? {} : { harness }),
      ...(skipGithub || githubToken === undefined
        ? {}
        : { github: createGithubPublisher(githubToken) }),
    }, {
      info(message) { logLine(message) },
    })
  } catch (error) {
    if (isQuotaError(error)) {
      process.stderr.write(`${error.message}\n`)
      writeGithubOutput({
        status: 'failed',
        run_dir: runDir,
        mechanical_ok: 'false',
        skipped_review: 'false',
        target_tag: target.tag,
      })
      return 1
    }
    throw error
  }

  if (result.status !== 'failed' && config.watch.enabled) {
    const persisted = persistSeenState(workdir, target)
    if (!persisted.ok) {
      const message = `failed to persist dsh state on ${STATE_BRANCH}: ${persisted.reason}: ${persisted.detail}`
      if (process.env.GITHUB_ACTIONS === 'true') {
        process.stderr.write(`${message}\n`)
        return 1
      }
      logLine(message)
    } else {
      logLine(`recorded ${target.tag} on ${STATE_BRANCH} (${persisted.commit.slice(0, 7)})`)
    }
  }

  writeGithubOutput({
    status: result.status,
    run_dir: result.runDir,
    mechanical_ok: result.mechanical.ok ? 'true' : 'false',
    skipped_review: result.skippedReview ? 'true' : 'false',
    issue_url: result.published.issueUrl,
    pull_request_url: result.published.pullRequestUrl,
    target_tag: target.tag,
  })

  logLine(JSON.stringify({
    status: result.status,
    runDir: result.runDir,
    skippedReview: result.skippedReview,
    fixAttempts: result.fixAttempts,
    mechanicalOk: result.mechanical.ok,
    published: result.published,
  }, null, 2))
  return result.status === 'failed' ? 1 : 0
}

void main(process.argv).then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
  process.exitCode = 1
})
