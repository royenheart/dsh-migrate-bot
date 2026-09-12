#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfigFile, parseConfig } from './config/load.ts'
import { loadSecrets } from './secrets.ts'
import { runMechanical } from './mechanical/run.ts'
import { ensureMigrateGitExclude, isWorktreeDirty, worktreeDiff } from './git/worktree.ts'
import { resolveDshVersion } from './watch/dsh-version.ts'
import { decideWatch, describeWatchDecision } from './watch/gate.ts'
import { applyRunToSeenState, readSeenState, STATE_BRANCH } from './watch/seen.ts'
import { badgeFromSeenState } from './watch/badge.ts'
import { publishedPullRequest, reconcilePendingState, writeStateBranch } from './watch/sync.ts'
import { runFeedback } from './feedback/run.ts'
import { skillsSource, syncUpgradeSkills, upgradeSkillsEnabled } from './skills/upgrade.ts'
import { createReportStore } from './reports/store.ts'
import { createDshRunner, formatSessionProgress } from './agents/dsh.ts'
import { createGithubPublisher } from './github/publish.ts'
import { writeGithubOutput } from './github/output.ts'
import { runPipeline } from './pipeline/orchestrator.ts'
import type { VerificationResult } from './pipeline/types.ts'
import { bootProbe, type BootProbeResult } from './verify/boot.ts'
import { attribute, resolveBaseline } from './verify/baseline.ts'
import { ensureDsh } from './verify/dsh-install.ts'
import { hasClientSurface, webSmoke } from './verify/web.ts'
import { detectE2EFramework, INDEX_FILE, readIndex, renderAuthoringBrief, syncE2EBranch } from './e2e/branch.ts'
import { runE2E } from './e2e/run.ts'
import { detectBaseBranch } from './github/publish.ts'
import { renderStepSummary, writeStepSummary } from './github/summary.ts'
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

function persistFailed(result: { ok: false; reason: string; detail: string }): number {
  const message = `failed to persist dsh state on ${STATE_BRANCH}: ${result.reason}: ${result.detail}`
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stderr.write(`${message}\n`)
    return 1
  }
  logLine(message)
  return 0
}

function persistState(workdir: string, seen: ReturnType<typeof readSeenState>, message: string): number {
  const persisted = writeStateBranch(workdir, seen, message)
  if (!persisted.ok) return persistFailed(persisted)
  if (persisted.commit !== 'unchanged') {
    const badge = badgeFromSeenState(seen)
    logLine(`recorded state on ${STATE_BRANCH} (${persisted.commit.slice(0, 7)}): badge ${badge.message}`)
  }
  return 0
}

async function refreshBadge(argv: readonly string[]): Promise<number> {
  const workdir = resolve(argValue(argv, '--workdir') ?? process.cwd())
  const appRoot = resolve(process.env.DSH_MIGRATE_APP_ROOT ?? resolve(here, '../..'))
  const secrets = loadSecrets([workdir, appRoot, process.cwd()])
  const previous = readSeenState(workdir)
  const seen = await reconcilePendingState(workdir, previous, secrets.githubToken, logLine)
  const code = persistState(workdir, seen, 'dsh-migrate: refresh badge')
  const badge = badgeFromSeenState(seen)
  writeGithubOutput({
    status: 'skipped',
    skipped_review: 'true',
    verified_tag: seen?.verified?.tag,
    badge_message: badge.message,
    previous_tag: seen?.tag,
  })
  logLine(JSON.stringify({ status: 'refresh-badge', seen, badge }, null, 2))
  return code
}

/**
 * Report one merged migrate pull request to the channels a user enabled.
 *
 * The recorded state is read *before* the merge is reconciled: the pending row
 * is what names the pull request and the tag the migration targeted, and
 * reconciliation is what removes it.
 */
async function feedback(argv: readonly string[]): Promise<number> {
  const workdir = resolve(argValue(argv, '--workdir') ?? process.cwd())
  const appRoot = resolve(process.env.DSH_MIGRATE_APP_ROOT ?? resolve(here, '../..'))
  const configPath = resolveConfigPath(argv, workdir)
  const config = configPath === undefined || !existsSync(configPath)
    ? parseConfig({})
    : loadConfigFile(configPath)
  const apiKeyEnv = argValue(argv, '--api-key-env') ?? config.secrets.apiKeyEnv
  const secrets = loadSecrets([workdir, appRoot, process.cwd()], { apiKeyEnv })
  const recorded = readSeenState(workdir)
  const explicit = argValue(argv, '--pull-request')
  const requested = explicit === undefined ? undefined : Number(explicit)
  if (explicit !== undefined && (!Number.isInteger(requested) || (requested ?? 0) <= 0)) {
    process.stderr.write('--pull-request must be a positive integer\n')
    return 2
  }

  const agent = createDshRunner({
    ...(process.env.DSH_HOME === undefined ? {} : { dshHome: process.env.DSH_HOME }),
    timeoutMs: config.timeouts.agentMs,
    onStatus(progress) { logLine(`dsh: ${formatSessionProgress(progress)}`) },
    onLog(line) { logLine(line) },
  })

  const result = await runFeedback({
    workdir,
    config,
    env: process.env,
    log: logLine,
    seen: recorded,
    ...(requested === undefined ? {} : { pullRequest: requested }),
    ...(secrets.apiKey === undefined ? {} : { apiKey: secrets.apiKey }),
    agent,
  })

  writeGithubOutput({
    status: result.ran ? 'feedback' : 'skipped',
    skipped_review: 'true',
    verified_tag: recorded?.verified?.tag,
    feedback_status: result.outcomes
      .map(outcome => `${outcome.channel}: ${outcome.status}${outcome.status === 'delivered' ? '' : ` (${outcome.reason})`}`)
      .join('\n'),
  })
  logLine(JSON.stringify({
    status: 'feedback',
    ran: result.ran,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    outcomes: result.outcomes,
  }, null, 2))
  // A skipped channel is a normal outcome, and a delivery failure is reported to
  // the maintainers who enabled the channel rather than by failing their run.
  return 0
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
  if (command === 'refresh-badge') {
    return refreshBadge(argv)
  }
  if (command === 'feedback') {
    return feedback(argv)
  }
  if (command !== 'run') {
    process.stderr.write('usage: dsh-migrate run|check-config|refresh-badge|feedback [--workdir DIR] [--config FILE] [--dsh-version VER] [--api-key-env NAME] [--quota-limit N] [--pull-request N] [--mechanical-only] [--skip-github] [--force]\n')
    return 2
  }

  const workdir = resolve(argValue(argv, '--workdir') ?? process.cwd())
  const appRoot = resolve(process.env.DSH_MIGRATE_APP_ROOT ?? resolve(here, '../..'))
  const configPath = resolveConfigPath(argv, workdir)
  const config = configPath === undefined || !existsSync(configPath)
    ? parseConfig({})
    : loadConfigFile(configPath)
  const requested = argValue(argv, '--dsh-version') ?? config.dshVersion
  const apiKeyEnv = argValue(argv, '--api-key-env') ?? config.secrets.apiKeyEnv
  const secrets = loadSecrets([workdir, appRoot, process.cwd()], { apiKeyEnv })
  // Authenticate the releases call: unauthenticated it shares a 60/hour
  // per-IP bucket with every other job on the runner, which returns 403.
  const target = await resolveDshVersion(requested, { token: secrets.githubToken })
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

  const loaded = mechanicalOnly ? undefined : readSeenState(workdir)
  const previous = mechanicalOnly
    ? undefined
    : await reconcilePendingState(workdir, loaded, secrets.githubToken, logLine)
  if (!mechanicalOnly && config.watch.enabled && previous !== loaded) {
    const code = persistState(workdir, previous, 'dsh-migrate: refresh badge')
    if (code !== 0) return code
  }
  const decision = decideWatch({
    watchEnabled: config.watch.enabled,
    force,
    mechanicalOnly,
    current: target,
    previous,
  })
  logLine(describeWatchDecision(decision, target))
  if (decision.action === 'skip') {
    const badge = badgeFromSeenState(previous)
    writeGithubOutput({
      status: 'skipped',
      skipped_review: 'true',
      target_tag: target.tag,
      previous_tag: decision.previous.tag,
      verified_tag: previous?.verified?.tag,
      badge_message: badge.message,
    })
    logLine(JSON.stringify({
      status: 'skipped',
      target,
      previous,
      badge,
    }, null, 2))
    return 0
  }

  const runId = `${target.version}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const runDir = resolve(process.env.DSH_MIGRATE_HOME ?? resolve(workdir, '.dsh-migrate'), 'runs', runId)
  mkdirSync(runDir, { recursive: true })
  ensureMigrateGitExclude(workdir)

  if (mechanicalOnly) {
    const mechanical = runMechanical(workdir, config, {
      dshVersion: target.version,
      timeoutMs: config.timeouts.commandMs,
    })
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

  // The community upgrade knowledge is loaded only for a user who enabled the
  // channel that reports back to it. Off, the skill root is left without it, so
  // a run that does not want that knowledge cannot be influenced by it.
  const skills = syncUpgradeSkills({
    dshHome: process.env.DSH_HOME,
    enabled: upgradeSkillsEnabled(config),
    source: skillsSource(process.env),
    log: logLine,
  })
  logLine(`stage: skills — ${skills.detail}`)

  const migrateHome = resolve(process.env.DSH_MIGRATE_HOME ?? resolve(workdir, '.dsh-migrate'))
  logLine(`stage: harness checkout ${target.tag}`)
  const harnessResult = checkoutHarness({
    tag: target.tag,
    dest: resolve(migrateHome, 'harness'),
    timeoutMs: config.timeouts.checkoutMs,
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

  const dshCache = resolve(migrateHome, 'dsh')
  const probeEnv = { timeoutMs: config.verify.boot.timeoutMs }

  /** V2: boot the tree under one harness version through a scratch profile. */
  const probeAt = async (tag: string): Promise<BootProbeResult> => {
    const installed = ensureDsh(tag.replace(/^dsh-v/, ''), dshCache, { timeoutMs: config.timeouts.commandMs })
    if (!installed.ok || installed.bin === undefined) {
      return { outcome: 'fail', signature: `probe unavailable: ${installed.detail}`, detail: installed.detail }
    }
    return await bootProbe({ workdir, bin: installed.bin, dshTag: tag, ...probeEnv })
  }

  // Baseline first: it never gates the run, it decides attribution and how far
  // back the agent has to look.
  const baselineRef = resolveBaseline(previous, workdir)
  let baselineProbe: BootProbeResult | undefined
  if (config.verify.boot.enabled && baselineRef.tag !== undefined) {
    logLine(`stage: baseline probe ${baselineRef.tag} (${baselineRef.source})`)
    baselineProbe = await probeAt(baselineRef.tag)
    logLine(`baseline probe: ${baselineProbe.outcome} (${baselineProbe.signature})`)
  } else if (config.verify.boot.enabled) {
    logLine('baseline probe skipped: no recorded tag and no declared harness version')
  }

  const agentSession = createDshRunner({
    ...(process.env.DSH_HOME === undefined ? {} : { dshHome: process.env.DSH_HOME }),
    reportDir: runDir,
    timeoutMs: config.timeouts.agentMs,
    onStatus(progress) {
      logLine(`dsh: ${formatSessionProgress(progress)}`)
    },
    onLog(line) { logLine(line) },
  })

  let lastE2EFailure: string[] = []
  const worktreeRoot = resolve(runDir, 'e2e-worktree')

  let result
  try {
    result = await runPipeline({
      config,
      workdir,
      target,
      store: createReportStore(runDir),
      apiKey,
      runMechanical: () => runMechanical(workdir, config, {
        dshVersion: target.version,
        timeoutMs: config.timeouts.commandMs,
      }),
      isDirty: () => isWorktreeDirty(workdir),
      diff: () => worktreeDiff(workdir),
      agent: agentSession,
      quota,
      ...(harness === undefined ? {} : { harness }),
      ...(skipGithub || githubToken === undefined
        ? {}
        : { github: createGithubPublisher(githubToken) }),
      ...(config.verify.boot.enabled
        ? {
          probeTarget: async (): Promise<VerificationResult> => {
            const probe = await probeAt(target.tag)
            return {
              ok: probe.outcome === 'pass',
              layer: 'boot',
              signature: probe.signature,
              detail: probe.detail,
            }
          },
        }
        : {}),
      ...(config.verify.web.enabled
        ? {
          probeWeb: async (): Promise<VerificationResult> => {
            if (!hasClientSurface(workdir)) {
              return { ok: true, layer: 'web', signature: 'web: no client surface', detail: '', skipped: 'the plugin declares no dsh.client surface' }
            }
            const installed = ensureDsh(target.version, dshCache, { timeoutMs: config.timeouts.commandMs })
            if (!installed.ok || installed.bin === undefined) {
              return { ok: true, layer: 'web', signature: 'web: probe unavailable', detail: installed.detail, skipped: 'no dsh binary for the web smoke' }
            }
            const smoke = await webSmoke({
              workdir,
              bin: installed.bin,
              timeoutMs: config.verify.web.timeoutMs,
              dshTag: target.tag,
            })
            return {
              ok: smoke.ok,
              layer: 'web',
              signature: smoke.signature,
              detail: smoke.detail,
              ...(smoke.skipped === undefined ? {} : { skipped: smoke.skipped }),
            }
          },
        }
        : {}),
      ...(config.e2e.enabled
        ? {
          runE2E: async (mode: 'subset' | 'full'): Promise<VerificationResult> => {
            const run = runE2E({
              workdir,
              branch: config.e2e.branch,
              mode: config.e2e.subsetFirst ? mode : 'full',
              failing: lastE2EFailure,
              worktreeDir: worktreeRoot,
              timeoutMs: config.timeouts.commandMs,
            })
            lastE2EFailure = run.failedTests
            return {
              ok: run.ok,
              layer: 'e2e',
              signature: run.signature,
              detail: run.detail,
              ...(run.skipped === undefined ? {} : { skipped: run.skipped }),
            }
          },
          syncE2E: async () => {
            const staging = resolve(runDir, 'e2e-draft')
            mkdirSync(staging, { recursive: true })
            const framework = detectE2EFramework(workdir)
            const pluginPkg = resolve(workdir, 'package.json')
            const pluginNameForBrief = existsSync(pluginPkg)
              ? String((JSON.parse(readFileSync(pluginPkg, 'utf8')) as { name?: unknown }).name ?? 'plugin')
              : 'plugin'
            const brief = renderAuthoringBrief({
              workdir,
              suiteDir: config.e2e.dir,
              framework,
              dshTag: target.tag,
              pluginName: pluginNameForBrief,
              stagingDir: staging,
            })
            await agentSession.run({
              kind: 'e2e',
              prompt: brief,
              workdir,
              dsh: config.dsh,
              apiKey,
            })
            const index = readIndex(resolve(staging, INDEX_FILE))
            if (index === undefined) {
              return { ok: false, pushed: false, reason: 'no-index', detail: 'the agent staged no index.json' }
            }
            const defaultBranch = detectBaseBranch(workdir)
            return syncE2EBranch({
              workdir,
              branch: config.e2e.branch,
              baseRef: config.e2e.baseRef === 'migration' ? `origin/${defaultBranch}` : config.e2e.baseRef,
              defaultBranch,
              forceRebase: config.e2e.forceRebase,
              stagingDir: staging,
              worktreeDir: resolve(runDir, 'e2e-branch'),
              index,
              message: `test(e2e): cover ${target.tag} (${index.features.length} features)`,
            })
          },
        }
        : {}),
      ...(baselineProbe === undefined
        ? {}
        : { attribution: attribute(baselineProbe, await probeAt(target.tag), baselineRef.source) }),
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

  // The run page is where a human actually looks: render the verdict, the
  // baseline attribution and the failing layer there.
  const pluginPkgPath = resolve(workdir, 'package.json')
  const pluginLabel = existsSync(pluginPkgPath)
    ? String((JSON.parse(readFileSync(pluginPkgPath, 'utf8')) as { name?: unknown }).name ?? 'plugin')
    : 'plugin'
  const summary = renderStepSummary({
    status: result.status,
    target,
    pluginName: pluginLabel,
    result,
    ...(result.published.issueUrl === undefined ? {} : { issueUrl: result.published.issueUrl }),
    ...(result.published.pullRequestUrl === undefined ? {} : { pullRequestUrl: result.published.pullRequestUrl }),
    runDir,
  })
  if (!writeStepSummary(summary)) logLine(summary)

  let seen = previous
  if (config.watch.enabled) {
    const pullRequest = publishedPullRequest(result.published)
    const next = applyRunToSeenState(previous, {
      target,
      status: result.status,
      ...(pullRequest === undefined ? {} : { pullRequest }),
    })
    const seedUnverified = result.status === 'failed' && previous === undefined
    const recordRun = result.status !== 'failed' && next !== undefined
    if (seedUnverified || recordRun) {
      const code = persistState(
        workdir,
        seedUnverified ? undefined : next,
        seedUnverified ? 'dsh-migrate: refresh badge' : `dsh-migrate: record ${target.tag}`,
      )
      if (code !== 0) return code
      if (recordRun) seen = next
    }
  }

  const badge = badgeFromSeenState(seen)
  writeGithubOutput({
    status: result.status,
    run_dir: result.runDir,
    mechanical_ok: result.mechanical.ok ? 'true' : 'false',
    skipped_review: result.skippedReview ? 'true' : 'false',
    issue_url: result.published.issueUrl,
    pull_request_url: result.published.pullRequestUrl,
    target_tag: target.tag,
    verified_tag: seen?.verified?.tag,
    badge_message: badge.message,
  })

  logLine(JSON.stringify({
    status: result.status,
    runDir: result.runDir,
    skills: { status: skills.status, loaded: skills.skills },
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
