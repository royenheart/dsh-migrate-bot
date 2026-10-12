#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { loadConfigFile, parseConfig } from './config/load.ts'
import { loadSecrets } from './secrets.ts'
import { createDshRunner, formatSessionProgress } from './agents/dsh.ts'
import { runSelfTest } from './agents/self-test.ts'
import { createActivities } from './activities/index.ts'
import { checkTree } from './activities/check-tree.ts'
import { maintainerCommits } from './activities/proposal.ts'
import { parseCommand, mayRunCommands } from './commands/parse.ts'
import { runCommand } from './commands/run.ts'
import { renderCommandHelp } from './commands/table.ts'
import { openLogStream, type LogStream } from './deploy/log-stream.ts'
import { declaredRelease } from './domain/release.ts'
import { defaultBranch, excludeIgnoredPaths } from './git/worktree.ts'
import { GitHubClient, repositoryOf, slugOf, type Repository } from './github/client.ts'
import { writeGithubOutput } from './github/output.ts'
import { resolveTarget } from './github/releases.ts'
import { renderStepSummary, statusOf, writeStepSummary } from './github/summary.ts'
import { readPluginName } from './mechanical/run.ts'
import { resolveChannels } from './merge-reports/channels.ts'
import { runReportChannel } from './merge-reports/run.ts'
import { createQuotaQuery } from './quota/query.ts'
import { inline } from './render/text.ts'
import { skillsSource, syncUpgradeSkills } from './skills/upgrade.ts'
import { StateStore } from './state/store.ts'
import { badgeOf } from './workflow/badge.ts'
import { InJobEngine } from './engine.ts'
import { decideStart } from './workflow/start.ts'
import type { MigrateConfig } from './config/schema.ts'
import type { MigrationInput } from './workflow/model.ts'
import type { MigrationView } from './workflow/projection.ts'

const USAGE = `usage: dsh-migrate <command> [options]

commands:
  run                   start a migration to the target release, or skip it
  pull-request-closed   deliver a closed pull request: --number N --merged true|false
  comment               carry out a /dsh-migrate comment: --body --comment-id --author --association --issue
  check                 run every check on the working tree against --target
  status                print the consumer state as JSON
  self-test             start one keyless session of the agent runtime
  print-config          print the validated configuration

options:
  --workdir DIR         the plugin checkout (default: the current directory)
  --config FILE         the configuration (default: .github/dsh-migrate.yml when it exists)
  --target RELEASE      override the configured target release
  --force               run even when the target release was already processed
  --skip-github         do not publish a proposal
`

const OPTIONS = {
  workdir: { type: 'string' },
  config: { type: 'string' },
  target: { type: 'string' },
  force: { type: 'boolean' },
  'skip-github': { type: 'boolean' },
  number: { type: 'string' },
  merged: { type: 'string' },
  body: { type: 'string' },
  'comment-id': { type: 'string' },
  author: { type: 'string' },
  association: { type: 'string' },
  issue: { type: 'string' },
} as const

type Options = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values']

/** Lines go to stdout unbuffered, and to the run log stream when one is open. */
let stream: LogStream | undefined
function log(message: string): void {
  writeSync(1, `${message}\n`)
  stream?.publish(message)
}

interface Runtime {
  workdir: string
  env: NodeJS.ProcessEnv
  config: MigrateConfig
  apiKey: string | undefined
  repository: Repository | undefined
  github: { client: GitHubClient; repository: Repository; defaultBranch: string } | undefined
  store: StateStore
  home: string
  runId: string
  runUrl: string | undefined
}

function loadRuntime(options: Options, env: NodeJS.ProcessEnv): Runtime {
  const workdir = resolve(options.workdir ?? '.')
  const configPath = options.config === undefined ? join(workdir, '.github', 'dsh-migrate.yml') : resolve(workdir, options.config)
  let config: MigrateConfig
  try {
    config = loadConfigFile(configPath)
  } catch (error) {
    if (options.config !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    config = parseConfig({})
  }
  if (options.target !== undefined) config = { ...config, target: options.target }
  const secrets = loadSecrets([workdir, env.DSH_MIGRATE_APP_ROOT ?? workdir], { apiKeyEnv: config.secrets.apiKeyEnv, env })
  const repository = env.GITHUB_REPOSITORY === undefined || env.GITHUB_REPOSITORY === '' ? undefined : repositoryOf(env.GITHUB_REPOSITORY)
  const github = repository === undefined || secrets.githubToken === undefined || options['skip-github'] === true
    ? undefined
    : { client: new GitHubClient(secrets.githubToken, env), repository, defaultBranch: defaultBranch(workdir) }
  const runId = env.GITHUB_RUN_ID === undefined ? `local-${new Date().toISOString().replace(/[:.]/g, '-')}` : `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`
  const runUrl = env.GITHUB_RUN_ID === undefined || repository === undefined
    ? undefined
    : `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${slugOf(repository)}/actions/runs/${env.GITHUB_RUN_ID}`
  return {
    workdir,
    env,
    config,
    apiKey: secrets.apiKey,
    repository,
    github,
    store: new StateStore(workdir, env),
    home: resolve(env.DSH_MIGRATE_HOME ?? join(workdir, '.dsh-migrate')),
    runId,
    runUrl,
  }
}

/**
 * Load or unload the upgrade skills for the next session. Only the agent
 * runtime's own home is managed; without `DSH_HOME` nothing is touched.
 */
function skillsSync(runtime: Runtime): (enabled: boolean) => void {
  return (enabled) => {
    const dshHome = runtime.env.DSH_HOME
    if (dshHome === undefined || dshHome === '') {
      if (enabled) log('upgrade skills: DSH_HOME is not set, so they are not loaded')
      return
    }
    log(syncUpgradeSkills({ dshHome, enabled, source: skillsSource(runtime.env) }))
  }
}

function engineFor(runtime: Runtime): InJobEngine {
  const agent = createDshRunner({
    ...(runtime.env.DSH_HOME === undefined ? {} : { dshHome: runtime.env.DSH_HOME }),
    timeoutMs: runtime.config.timeouts.agentMs,
    onStatus(progress) { log(`dsh: ${formatSessionProgress(progress)}`) },
    onLog(line) { log(line) },
  })
  const activities = createActivities({
    workdir: runtime.workdir,
    config: runtime.config,
    env: runtime.env,
    apiKey: runtime.apiKey,
    agent,
    quota: runtime.apiKey === undefined ? undefined : createQuotaQuery({ provider: runtime.config.agent.provider }),
    github: runtime.github,
    files: runtime.store,
    home: runtime.home,
    runId: runtime.runId,
    runUrl: runtime.runUrl,
    syncSkills: skillsSync(runtime),
    log,
  })
  return new InJobEngine({ store: runtime.store, activities, run: runtime.runId, log })
}

function migrationInput(runtime: Runtime, target: MigrationInput['target'], verified: MigrationInput['target'] | undefined, proposal: MigrationInput['proposal']): MigrationInput {
  const { config } = runtime
  const declared = verified === undefined ? declaredRelease(JSON.parse(readFileSync(join(runtime.workdir, 'package.json'), 'utf8'))) : undefined
  const source = verified !== undefined ? { release: verified, origin: 'verified' as const } : declared === undefined ? undefined : { release: declared, origin: 'declared-peers' as const }
  return {
    target,
    ...(source === undefined ? {} : { source }),
    ...(proposal === undefined ? {} : { proposal }),
    settings: {
      reviewPolicy: config.review.policy,
      maxAttempts: config.repair.maxAttempts,
      e2eFailurePolicy: config.checks.e2e.failurePolicy,
      checks: { boot: config.checks.boot.enabled, web: config.checks.web.enabled, e2e: config.checks.e2e.enabled },
      e2eSubsetFirst: config.checks.e2e.subsetFirst,
      publish: runtime.github !== undefined,
      reportChannels: resolveChannels(config).filter(channel => channel.enabled).map(channel => channel.id),
    },
  }
}

function report(runtime: Runtime, engine: InJobEngine, view: MigrationView | undefined, extra: Record<string, string | undefined> = {}): void {
  const projection = engine.status()
  writeGithubOutput({
    ...(view === undefined ? {} : { status: statusOf(view.state), target_tag: view.target.tag, pull_request_url: view.context.proposal?.pullRequest.url }),
    verified_tag: projection.verified?.tag,
    badge_message: badgeOf(projection).message,
    log_stream_url: stream?.url,
    ...extra,
  }, runtime.env)
  if (view !== undefined) writeStepSummary(renderStepSummary({ view, pluginName: readPluginName(runtime.workdir), logStreamUrl: stream?.url }), runtime.env)
}

async function run(runtime: Runtime, force: boolean): Promise<number> {
  if (runtime.apiKey === undefined) {
    process.stderr.write(`${runtime.config.secrets.apiKeyEnv} is not set; a migration needs it for its agent sessions\n`)
    return 1
  }
  const selfTest = runSelfTest({ bin: runtime.env.DSH_BIN, dshHome: runtime.env.DSH_HOME })
  if (!selfTest.ok) {
    process.stderr.write(`the agent runtime failed its self-test: ${selfTest.detail}\n`)
    writeGithubOutput({ status: 'error' }, runtime.env)
    return 1
  }
  const target = await resolveTarget(runtime.config.target)
  const engine = engineFor(runtime)
  const projection = engine.status()
  const proposal = projection.open?.context.proposal
  const decision = decideStart({
    target,
    projection,
    force,
    maintainerCommits: proposal === undefined || runtime.github === undefined
      ? 0
      : await maintainerCommits(runtime.github.client, runtime.github.repository, proposal.pullRequest.number),
  })
  if (decision.action === 'skip') {
    log(`skipped (${decision.reason}): ${inline(decision.detail, 300)}`)
    report(runtime, engine, undefined, { status: 'skipped', target_tag: target.tag })
    return 0
  }
  excludeIgnoredPaths(runtime.workdir)
  stream = await openLogStream({ config: runtime.config, env: runtime.env, repository: runtime.repository === undefined ? 'unknown' : slugOf(runtime.repository), runId: runtime.runId, log })
  try {
    log(`migrating to ${target.tag}${decision.supersedes === undefined ? '' : `, taking over the proposal of ${decision.supersedes}`}`)
    const view = await engine.start(target.version, migrationInput(runtime, target, projection.verified, decision.proposal), decision.supersedes)
    report(runtime, engine, view)
    return view.state === 'failed' || view.state === 'error' ? 1 : 0
  } finally {
    await stream.close()
  }
}

async function pullRequestClosed(runtime: Runtime, options: Options): Promise<number> {
  const number = Number(options.number)
  if (!Number.isInteger(number) || number <= 0 || (options.merged !== 'true' && options.merged !== 'false')) {
    process.stderr.write('pull-request-closed needs --number N and --merged true|false\n')
    return 2
  }
  const engine = engineFor(runtime)
  const migration = engine.status().migrations.find(view => view.context.proposal?.pullRequest.number === number)
  if (migration === undefined) {
    log(`pull request #${String(number)} is not a proposal of this Action; nothing to do`)
    return 0
  }
  const view = await engine.deliver(migration.id, { type: 'pull-request.closed', number, merged: options.merged === 'true' })
  report(runtime, engine, view)
  return view.state === 'error' ? 1 : 0
}

async function comment(runtime: Runtime, options: Options): Promise<number> {
  const parsed = parseCommand(options.body ?? '')
  if (!parsed.ok && parsed.reason === 'no command') return 0
  const issueNumber = options.issue === undefined ? undefined : Number(options.issue)
  const commentId = options['comment-id']
  if (commentId === undefined || (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber <= 0))) {
    process.stderr.write('comment needs --comment-id and a positive --issue\n')
    return 2
  }
  let reply: string
  if (!mayRunCommands({ authorAssociation: options.association, authorLogin: options.author })) {
    reply = '**`/dsh-migrate` is refused for this account.** Commands are limited to users with write access to this repository.'
  } else if (!parsed.ok) {
    reply = parsed.reason === 'help' ? renderCommandHelp() : parsed.reason
  } else if (!runtime.config.deploy.commands) {
    reply = '**Commands are disabled** by `deploy.commands: false`.'
  } else {
    const engine = engineFor(runtime)
    const agent = createDshRunner({ timeoutMs: runtime.config.timeouts.agentMs, onLog: log })
    const outcome = await runCommand({
      command: parsed.command,
      config: runtime.config,
      env: runtime.env,
      workdir: runtime.workdir,
      repository: runtime.repository,
      github: runtime.github?.client,
      issueNumber,
      commentId,
      log,
      status: () => engine.status(),
      report: async (migration, resend) => await engine.deliver(migration, { type: 'command.report', resend, comment: commentId }),
      reportDryRun: async (migration) => {
        const github = runtime.github
        if (github === undefined) throw new Error('a dry run reads the proposal from GitHub and needs GITHUB_TOKEN')
        const results = []
        for (const channel of migration.context.input.settings.reportChannels) {
          results.push({
            channel,
            result: await runReportChannel(channel, migration, {
              config: runtime.config,
              env: runtime.env,
              repository: github.repository,
              github: github.client,
              files: runtime.store,
              agent,
              apiKey: runtime.apiKey,
              workdir: runtime.workdir,
              syncSkills: skillsSync(runtime),
            }, 'dry-run'),
          })
        }
        return results
      },
      checkTree: async (tree, migration) => await checkTree(
        tree,
        migration?.target ?? await resolveTarget(runtime.config.target),
        { config: runtime.config, cacheDir: join(runtime.home, 'dsh'), runDir: join(runtime.home, 'runs', runtime.runId) },
      ),
      treeDir: join(runtime.home, 'publish-tree'),
    })
    reply = outcome.reply
  }
  log(reply)
  writeGithubOutput({ command_reply: reply }, runtime.env)
  if (runtime.github !== undefined && issueNumber !== undefined) await postReply(runtime.github.client, runtime.github.repository, issueNumber, commentId, reply)
  return 0
}

/** Post the reply once per comment, however many times the comment is delivered. */
async function postReply(github: GitHubClient, repository: Repository, issue: number, commentId: string, reply: string): Promise<void> {
  const marker = `<!-- dsh-migrate:reply-to=${commentId} -->`
  const path = `/repos/${slugOf(repository)}/issues/${String(issue)}/comments`
  const existing = await github.paginate(path, z.object({ body: z.string().nullable().optional() }))
  if (existing.some(entry => entry.body?.includes(marker) === true)) {
    log(`a reply to comment ${commentId} already exists; not posting another`)
    return
  }
  await github.rest('POST', path, z.object({}), { body: `${marker}\n${reply}` })
}

async function check(runtime: Runtime): Promise<number> {
  const target = await resolveTarget(runtime.config.target)
  excludeIgnoredPaths(runtime.workdir)
  const report = await checkTree(runtime.workdir, target, {
    config: runtime.config,
    cacheDir: join(runtime.home, 'dsh'),
    runDir: join(runtime.home, 'runs', runtime.runId),
  })
  for (const result of report.results) log(`${result.check}: ${result.outcome}${result.outcome === 'fail' ? ` (${inline(result.fingerprint, 200)})` : ''}`)
  log(`checks against ${target.tag}: ${report.ok ? 'pass' : `fail: ${report.detail}`}`)
  writeGithubOutput({ status: report.ok ? 'compatible' : 'failed', target_tag: target.tag }, runtime.env)
  return report.ok ? 0 : 1
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true })
  const command = positionals[0]
  const env = process.env
  switch (command) {
    case 'self-test': {
      const result = runSelfTest({ bin: env.DSH_BIN, dshHome: env.DSH_HOME })
      log(`self-test: ${result.ok ? 'pass' : 'fail'}: ${result.detail}`)
      return result.ok ? 0 : 1
    }
    case 'print-config':
      log(JSON.stringify(loadRuntime(values, env).config, null, 2))
      return 0
    case 'status':
      log(JSON.stringify(engineFor(loadRuntime(values, env)).status(), null, 2))
      return 0
    case 'run':
      return await run(loadRuntime(values, env), values.force === true)
    case 'pull-request-closed':
      return await pullRequestClosed(loadRuntime(values, env), values)
    case 'comment':
      return await comment(loadRuntime(values, env), values)
    case 'check':
      return await check(loadRuntime(values, env))
    default:
      process.stderr.write(USAGE)
      return 2
  }
}

void main(process.argv).then((code) => {
  process.exitCode = code
}, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
