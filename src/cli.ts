#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfigFile, parseConfig } from './config/load.ts'
import { loadSecrets } from './secrets.ts'
import { readPluginName, runMechanical } from './mechanical/run.ts'
import { inline } from './render/text.ts'
import { ensureMigrateGitExclude, isWorktreeDirty, worktreeDiff } from './git/worktree.ts'
import { resolveDshVersion } from './watch/dsh-version.ts'
import { decideOpenPullRequest, decideWatch, describeWatchDecision } from './watch/gate.ts'
import { applyRunToSeenState, readSeenState, readStateFile, STATE_BRANCH, STATE_FILE } from './watch/seen.ts'
import { badgeFromSeenState } from './watch/badge.ts'
import { publishedPullRequest, reconcilePendingState, retryLostRace, writeStateBranch } from './watch/sync.ts'
import { runFeedback } from './feedback/run.ts'
import { parseCommand, mayRunCommands } from './commands/parse.ts'
import { feedbackFlags, runFlags } from './commands/flags.ts'
import {
  MERGE_VERB,
  mergeCommandLedgers,
  mergeReportKey,
  parseCommandLedger,
  withCommandRecord,
  type CommandRecord,
} from './commands/idempotency.ts'
import { runCommand, type CommandOutcome } from './commands/run.ts'
import { renderCommandHelp } from './commands/table.ts'
import { postIssueComment } from './github/comment.ts'
import { resolveRepo } from './github/pr.ts'
import { openLiveView } from './deploy/live.ts'
import type { FeedbackOutcome } from './feedback/types.ts'
import { skillsSource, syncUpgradeSkills, upgradeSkillsEnabled } from './skills/upgrade.ts'
import { createReportStore } from './reports/store.ts'
import { createDshRunner, formatSessionProgress } from './agents/dsh.ts'
import { createGateRunner } from './verify/gates.ts'
import { createGithubPublisher } from './github/publish.ts'
import { finishRun } from './pipeline/finish.ts'
import { writeGithubOutput } from './github/output.ts'
import { runPipeline } from './pipeline/orchestrator.ts'
import type { PipelineResult } from './pipeline/types.ts'
import type { VerificationResult } from './pipeline/types.ts'
import { bootProbe, type BootProbeResult } from './verify/boot.ts'
import { attribute, resolveBaseline } from './verify/baseline.ts'
import { ensureDsh } from './verify/dsh-install.ts'
import { hasClientSurface, webSmoke, webSmoke as runWebSmoke } from './verify/web.ts'
import { detectE2EFramework, INDEX_FILE, readIndex, renderAuthoringBrief, syncE2EBranch } from './e2e/branch.ts'
import { runE2E } from './e2e/run.ts'
import { detectBaseBranch } from './github/publish.ts'
import { writeStepSummary } from './github/summary.ts'
import { checkoutHarness } from './harness/checkout.ts'
import { createQuotaQuery } from './quota/query.ts'
import { isQuotaError } from './quota/errors.ts'

const here = dirname(fileURLToPath(import.meta.url))

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

/**
 * The run's own log, which is also what a live view streams when one is open.
 * Routing the view through the existing log means every stage line, progress
 * payload and warning reaches it without a second call site to keep in sync.
 */
let liveView: { publish(message: string): void } | undefined

/** Line-buffered writes so GHA / docker logs show progress before the next agent step. */
function logLine(message: string): void {
  writeSync(1, `${message}\n`)
  liveView?.publish(message)
}

function resolveConfigPath(argv: readonly string[], workdir: string): string | undefined {
  const explicit = argValue(argv, '--config')
  if (explicit !== undefined) return resolve(workdir, explicit)
  const fallback = resolve(workdir, '.github/dsh-migrate.yml')
  return existsSync(fallback) ? fallback : undefined
}

/** The publisher's comment call, or nothing when it has none. */
function publisherComment(
  token: string,
): ((issueNumber: number, body: string, workdir: string) => Promise<void>) | undefined {
  return createGithubPublisher(token).commentIssue
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

/**
 * Say what a badge-only write costs.
 *
 * `persistStateBranch` replaces the branch tree with exactly the files it is
 * given, so writing only `badge.json` deletes `seen.json` — the watch cursor and
 * every command the Action remembers. That is right when there is no state to
 * write, and it must not happen without a word when there is one that could not
 * be read: a maintainer whose state was just reset cannot otherwise tell why
 * every command started running twice.
 * @param workdir - the checkout holding the state branch.
 */
function warnAboutDroppedState(workdir: string): void {
  const raw = readStateFile(workdir, STATE_FILE)
  if (raw === undefined || raw.trim() === '') return
  let commands = 0
  try {
    commands = parseCommandLedger((JSON.parse(raw) as { commands?: unknown }).commands).length
  } catch {
    commands = 0
  }
  logLine(
    `${STATE_FILE} on ${STATE_BRANCH} could not be read as state; writing the badge drops it`
    + ` and the ${String(commands)} command record(s) it holds`,
  )
}

function persistState(workdir: string, seen: ReturnType<typeof readSeenState>, message?: string): number {
  if (seen === undefined) warnAboutDroppedState(workdir)
  // The branch has more than one writer, and this one replaces the whole file.
  // The commands a command invocation recorded since this state was read are not
  // this writer's to drop, so they are re-read and carried over, once per
  // attempt, and a push that loses a race is retried on the fresh tip.
  const persisted = retryLostRace(() => {
    const current = readSeenState(workdir)
    if (seen === undefined || current === undefined) return writeStateBranch(workdir, seen, message)
    // Both ledgers survive: neither this writer's read nor the other's decides
    // what the record of the other's work is.
    const commands = mergeCommandLedgers(seen.commands ?? [], current.commands ?? [])
    return writeStateBranch(
      workdir,
      { ...seen, ...(commands.length === 0 ? {} : { commands }) },
      message,
    )
  }, {
    attempts: LEDGER_WRITE_ATTEMPTS,
    log: message_ => { logLine(message_) },
  })
  if (!persisted.ok) return persistFailed(persisted)
  if (persisted.commit !== 'unchanged') {
    const badge = badgeFromSeenState(seen)
    // The badge carries the tag the state branch recorded: one line of it, like
    // every other value that comes back out of that file.
    logLine(`recorded state on ${STATE_BRANCH} (${persisted.commit.slice(0, 7)}): badge ${inline(badge.message, 80)}`)
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

/** One channel outcome as a single readable line. */
function describeOutcome(outcome: FeedbackOutcome): string {
  // The fields are a channel's own text or a model's draft, and this becomes a
  // step output: one line each.
  switch (outcome.status) {
    case 'delivered':
      return outcome.url === undefined ? '' : ` ${inline(outcome.url, 300)}`
    case 'dry-run':
      return ` (would send ${outcome.method}: "${inline(outcome.title, 200)}")`
    default:
      return ` (${inline(outcome.reason, 300)})`
  }
}

/**
 * Answer a `/dsh-migrate` command from a comment.
 *
 * The reply goes back on the thread it came from, because that is the only
 * record a user sees. Authorization is decided from the comment's author
 * association and never from its text, and a comment that is not a command at
 * all is ignored rather than answered.
 */
async function commentCommand(argv: readonly string[]): Promise<number> {
  const workdir = resolve(argValue(argv, '--workdir') ?? process.cwd())
  const appRoot = resolve(process.env.DSH_MIGRATE_APP_ROOT ?? resolve(here, '../..'))
  const configPath = resolveConfigPath(argv, workdir)
  const config = configPath === undefined || !existsSync(configPath)
    ? parseConfig({})
    : loadConfigFile(configPath)
  const apiKeyEnv = argValue(argv, '--api-key-env') ?? config.secrets.apiKeyEnv
  const secrets = loadSecrets([workdir, appRoot, process.cwd()], { apiKeyEnv })
  const body = argValue(argv, '--comment-body') ?? ''
  const parsed = parseCommand(body)

  const positive = (name: string): number | undefined | 'invalid' => {
    const raw = argValue(argv, name)
    if (raw === undefined) return undefined
    const value = Number(raw)
    return Number.isInteger(value) && value > 0 ? value : 'invalid'
  }
  const issueNumberValue = positive('--issue-number')
  const pullRequestValue = positive('--pull-request')
  const issueNumber = typeof issueNumberValue === 'number' ? issueNumberValue : undefined
  const explicitPullRequest = typeof pullRequestValue === 'number' ? pullRequestValue : undefined

  const reply = async (text: string, code = 0, repeat = false): Promise<number> => {
    writeGithubOutput({ command_reply: text, command_repeat: repeat ? 'true' : 'false' })
    logLine(text)
    if (secrets.githubToken !== undefined && issueNumber !== undefined) {
      // Posting is best effort like everything else here: the answer already
      // exists in the log and in the output, and a repository that refuses the
      // comment is not a reason to fail a run over a failed reply.
      try {
        const posted = await postIssueComment({
          token: secrets.githubToken,
          workdir,
          issueNumber,
          body: text,
        })
        if (!posted.ok) process.stderr.write(`could not answer on the thread: ${posted.reason}\n`)
      } catch (error) {
        process.stderr.write(
          `could not answer on the thread: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }
    return code
  }

  if (!parsed.ok && parsed.reason === 'no command') {
    logLine('no /dsh-migrate command in this comment; nothing to do')
    return 0
  }
  if (issueNumberValue === 'invalid' || pullRequestValue === 'invalid') {
    const which = issueNumberValue === 'invalid' ? '--issue-number' : '--pull-request'
    return await reply(`**\`${which}\` must be a positive integer.**`, 2)
  }
  // No self-login is passed: on an `issue_comment` event `GITHUB_ACTOR` IS the
  // commenter, so comparing against it refused every real command. A bot is
  // refused by its `[bot]` login suffix, which is what the check is for.
  if (!mayRunCommands({
    authorAssociation: argValue(argv, '--comment-author-association'),
    authorLogin: argValue(argv, '--comment-author'),
  })) {
    return await reply(
      `**\`/dsh-migrate\` is refused for this account.** Commands are limited to users with write access to this repository.`,
    )
  }
  if (!parsed.ok) {
    return await reply(parsed.reason === 'help' ? renderCommandHelp() : parsed.reason)
  }
  // Every comment verb, not only the ones that need a target: `status` reads the
  // target now, and an operator who turned the command surface off does not
  // expect a comment to reach a service of theirs.
  if (!config.deploy.commands) {
    return await reply('**Commands are disabled** by `deploy.commands: false` in this repository\'s configuration.')
  }

  const agent = createDshRunner({
    ...(process.env.DSH_HOME === undefined ? {} : { dshHome: process.env.DSH_HOME }),
    timeoutMs: config.timeouts.agentMs,
    onStatus(progress) { logLine(`dsh: ${formatSessionProgress(progress)}`) },
    onLog(line) { logLine(line) },
  })
  const recorded = readSeenState(workdir)
  // A `publish` may push to the branch, so the tree it applies has to pass the
  // same gate stack the pipeline runs. The tag the gates verify against is the
  // one already recorded — the harness the repository is actually on — and the
  // cache is the same one the pipeline installs into. A repository whose state
  // records no tag yet has to resolve one, which happens only if a gate layer
  // runs, so no other verb pays for the release lookup.
  // The pull request being published is the migration one: the harness it is
  // being migrated *to* is `pending.tag`, not the harness of the last merged
  // migration, which is the version the change is leaving.
  const recordedTag = recorded?.pending?.tag ?? recorded?.tag ?? recorded?.verified?.tag
  const migrateHome = process.env.DSH_MIGRATE_HOME ?? resolve(workdir, '.dsh-migrate')
  const gateRunner = createGateRunner({
    config,
    dshTag: recordedTag
      ?? (async () => (await resolveDshVersion(config.dshVersion, { token: secrets.githubToken })).tag),
    dshCache: resolve(migrateHome, 'dsh'),
    log: logLine,
    // The whole stack, including the suite: a publish claims to be verified the
    // way any other change is, and "the layers this invocation happens to have"
    // is not that.
    e2e: (tree: string): VerificationResult => {
      const run = runE2E({
        workdir: tree,
        branch: config.e2e.branch,
        mode: 'full',
        failing: [],
        worktreeDir: resolve(migrateHome, 'publish-e2e'),
        timeoutMs: config.timeouts.commandMs,
      })
      return {
        ok: run.ok,
        layer: 'e2e',
        signature: run.signature,
        detail: run.detail,
        ...(run.skipped === undefined ? {} : { skipped: run.skipped }),
      }
    },
    web: async (tree: string, tag: string): Promise<VerificationResult> => {
      if (!hasClientSurface(tree)) {
        return { ok: true, layer: 'web', signature: 'web: no client surface', detail: '', skipped: 'the plugin declares no dsh.client surface' }
      }
      // The tag the runner resolved, not the config string: installing
      // `@deepseek-ai/dsh@latest` while the report names `dsh-v0.1.9` would be a
      // verification nobody performed.
      const installed = ensureDsh(tag.replace(/^dsh-v/, ''), resolve(migrateHome, 'dsh'), {
        timeoutMs: config.timeouts.commandMs,
      })
      if (!installed.ok || installed.bin === undefined) {
        return { ok: false, layer: 'web', signature: 'web: probe unavailable', detail: installed.detail }
      }
      const smoke = await runWebSmoke({
        workdir: tree,
        bin: installed.bin,
        timeoutMs: config.verify.web.timeoutMs,
        dshTag: tag,
      })
      return {
        ok: smoke.ok,
        layer: 'web',
        signature: smoke.signature,
        detail: smoke.detail,
        ...(smoke.skipped === undefined ? {} : { skipped: smoke.skipped }),
      }
    },
  })
  // The executor promises never to throw — every refusal is a reply — and the
  // thread still gets an answer if that promise is ever broken by a bug.
  let outcome: CommandOutcome
  try {
    outcome = await runCommand({
      command: parsed.command,
      config,
      env: process.env,
      workdir,
      seen: recorded,
      ...(explicitPullRequest === undefined || !Number.isInteger(explicitPullRequest)
        ? {}
        : { pullRequest: explicitPullRequest }),
      ...(argValue(argv, '--comment-id') === undefined ? {} : { commentId: argValue(argv, '--comment-id') }),
      log: logLine,
      gates: gateRunner,
      treeDir: resolve(migrateHome, 'publish-tree'),
      ...(secrets.apiKey === undefined
        ? {}
        : {
          feedback: async ({ dryRun, resend }: { dryRun: boolean; resend: boolean }) => await runFeedback({
            workdir,
            config,
            env: process.env,
            log: logLine,
            seen: recorded,
            apiKey: secrets.apiKey as string,
            agent,
            dryRun,
            resend,
            // An explicit command is the manual override: it exists so a user can
            // report a run whose pull request has not merged.
            requireMerged: false,
            ...(explicitPullRequest === undefined || !Number.isInteger(explicitPullRequest)
              ? {}
              : { pullRequest: explicitPullRequest }),
          }),
        }),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return await reply(`**The command could not be carried out:** ${detail}`)
  }

  const unrepeatable = recordCommand(workdir, recorded, outcome.record)
  return await reply(outcome.reply + unrepeatable, 0, outcome.repeat === true)
}

/**
 * Write down that a command has been carried out, so a redelivery of it is a
 * repeat instead of a second effect.
 *
 * The state is read again here rather than reused from before the command ran:
 * a command can take minutes, a scheduled run can have written the branch in the
 * meantime, and writing back a cursor read before that would either lose the
 * newer one or be rejected as a non-fast-forward.
 *
 * A push that loses a race is retried rather than given up on, because the state
 * branch has more than one writer: the scheduled run, the badge job on a merge,
 * and this. `persistStateBranch` builds its commit on the freshly fetched tip, so
 * a rejection means somebody pushed between this read and this write — which is
 * exactly what a fresh read fixes.
 *
 * The caller gets a warning to append to the reply rather than an exception,
 * because a command that already happened is not undone by failing to note it.
 * The warning exists because the record is what makes a redelivery harmless: if
 * it could not be written, the reply is the only place that can say so.
 * @param workdir - the checkout whose state branch holds the ledger.
 * @param recorded - the state as it was read before the command ran.
 * @param record - the entry to append, absent when the command had no effect.
 */
function recordCommand(
  workdir: string,
  recorded: ReturnType<typeof readSeenState>,
  record: CommandRecord | undefined,
): string {
  if (record === undefined) return ''
  const persisted = retryLostRace(() => {
    const current = readSeenState(workdir) ?? recorded
    // A write that would change nothing is not a write: `writeStateBranch`
    // compares the serialized state and reports the commit as unchanged, which is
    // what happens when another delivery recorded this command first.
    const ledger = withCommandRecord(current?.commands ?? [], record)
    const next = current === undefined ? undefined : { ...current, commands: ledger }
    if (next === undefined) {
      return {
        ok: false,
        reason: 'no-state',
        detail: `${STATE_BRANCH} has no ${STATE_FILE} to append to yet`,
      }
    }
    return writeStateBranch(workdir, next, `dsh-migrate: record command ${record.verb}`)
  }, {
    // Only a lost race is retried, so a missing branch is not: `retryLostRace`
    // gives up on everything that will not have healed.
    attempts: LEDGER_WRITE_ATTEMPTS,
    log: message => { logLine(`command ${record.verb}: ${message}`) },
  })
  if (persisted.ok) return ''
  logLine(`command ${record.verb}: could not record it on ${STATE_BRANCH}: ${persisted.reason}: ${inline(persisted.detail, 300)}`)
  return [
    '',
    '',
    `_This was not recorded on \`${STATE_BRANCH}\` (${persisted.reason}), so a redelivery of this same command would run again._`,
  ].join('\n')
}

/** How many times a lost race for the state branch is retried before giving up. */
const LEDGER_WRITE_ATTEMPTS = 3

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

  const { dryRun, resend, legacyForce } = feedbackFlags(argv)
  if (legacyForce) {
    // `force` used to mean "resend" here. A workflow that still sets it gets a
    // line in the log rather than a silent change of behaviour.
    logLine('feedback: --force no longer resends; use feedback_resend (--resend) to report a merge again')
  }
  // The merge event fires once, but a re-run of the workflow that handled it
  // runs this stage again, and reporting the same merge twice is the one thing a
  // channel must never do. The stage reads the record itself, per channel:
  // channels that already took this merge's report are skipped and say so, and a
  // channel that was skipped or failed is asked again, which is what a re-run is
  // for. What is *not* retryable is a channel that already delivered: sending it
  // the same merge twice is the mistake with no undo, and `--resend` is the way
  // to mean it.
  const result = await runFeedback({
    workdir,
    config,
    env: process.env,
    log: logLine,
    seen: recorded,
    dryRun,
    // `--resend` is the explicit way to report the same merge to a channel
    // again, for a channel whose configuration or prompt changed since.
    resend,
    ...(requested === undefined ? {} : { pullRequest: requested }),
    ...(secrets.apiKey === undefined ? {} : { apiKey: secrets.apiKey }),
    agent,
  })

  writeGithubOutput({
    status: result.ran ? 'feedback' : 'skipped',
    skipped_review: 'true',
    verified_tag: recorded?.verified?.tag,
    feedback_status: result.outcomes
      .map(outcome => `${outcome.channel}: ${outcome.status}${describeOutcome(outcome)}`)
      .join('\n'),
  })
  logLine(JSON.stringify({
    status: 'feedback',
    ran: result.ran,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    outcomes: result.outcomes,
  }, null, 2))
  // What went out is what a re-run must not repeat, so the record names the
  // channels rather than only the merge. Nothing is recorded when nothing was
  // delivered, so a merge whose every channel was skipped or failed is retried
  // by the next attempt at it.
  const delivered = result.outcomes
    .filter(outcome => outcome.status === 'delivered')
    .map(outcome => outcome.channel)
  const mergeKey = feedbackMergeKey(workdir, requested ?? recorded?.pending?.pr)
  if (mergeKey !== undefined && delivered.length > 0) {
    const unrepeatable = recordCommand(workdir, recorded, {
      key: mergeKey,
      verb: MERGE_VERB,
      at: new Date().toISOString(),
      channels: delivered,
    })
    // The warning is already in the log; there is no thread to put it on, and a
    // report that went out is not undone by failing to note that it did.
    if (unrepeatable !== '') logLine('feedback: this merge may be reported again to the same channels on a re-run')
  }
  // A skipped channel is a normal outcome, and a delivery failure is reported to
  // the maintainers who enabled the channel rather than by failing their run.
  return 0
}

/**
 * The ledger key for the automatic path, which reports a merge rather than a
 * comment. The stage reads the same record by the same key, so the two spellings
 * cannot drift.
 * @param workdir - the checkout the command acts on.
 * @param pullRequest - the pull request whose merge is being reported.
 */
function feedbackMergeKey(workdir: string, pullRequest: number | undefined): string | undefined {
  if (pullRequest === undefined) return undefined
  let repository: { owner: string; repo: string }
  try {
    repository = resolveRepo(workdir, process.env)
  } catch {
    return undefined
  }
  return mergeReportKey(`${repository.owner}/${repository.repo}`, pullRequest)
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
  if (command === 'command') {
    return commentCommand(argv)
  }
  if (command !== 'run') {
    process.stderr.write('usage: dsh-migrate run|check-config|refresh-badge|feedback|command [--workdir DIR] [--config FILE] [--dsh-version VER] [--api-key-env NAME] [--quota-limit N] [--pull-request N] [--dry-run] [--comment-body TEXT] [--comment-id ID] [--comment-author LOGIN] [--comment-author-association ASSOC] [--issue-number N] [--mechanical-only] [--skip-github] [--force] [--allow-second-pr] [--resend]\n')
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
  const { mechanicalOnly, skipGithub, force, allowSecond } = runFlags(argv)
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

  // One migrate pull request at a time; the rule and its override are the gate's.
  const open = decideOpenPullRequest({
    previous,
    allowSecond,
    mechanicalOnly,
  })
  if (open.action === 'skip') {
    logLine(open.reason)
    writeGithubOutput({
      status: 'skipped',
      skipped_review: 'true',
      target_tag: target.tag,
      previous_tag: previous?.tag,
      verified_tag: previous?.verified?.tag,
    })
    logLine(JSON.stringify({
      status: 'skipped',
      reason: open.reason,
      pending: open.pending,
      target,
      previous,
    }, null, 2))
    return 0
  }
  if (open.note !== undefined) logLine(open.note)

  const runId = `${target.version}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const view = await openLiveView({ config, env: process.env, workdir, runId, log: logLine })
  liveView = view
  if (view.url !== undefined) writeGithubOutput({ live_view_url: view.url })
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
    await view.close()
    return mechanical.ok ? 0 : 1
  }

  const apiKey = secrets.apiKey
  if (apiKey === undefined) {
    const reason = `${apiKeyEnv} is required (env or .secrets.local.json). Use --mechanical-only to skip the agent.`
    process.stderr.write(`${reason}\n`)
    // The run page is already open and its URL has been handed out: a viewer
    // must not be left with a page that never ends and no reason why.
    liveView?.publish(`dsh-migrate: ${reason}`)
    await view.close()
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
  logLine(`stage: skills — ${inline(skills.detail, 300)}`)

  const migrateHome = resolve(process.env.DSH_MIGRATE_HOME ?? resolve(workdir, '.dsh-migrate'))
  logLine(`stage: harness checkout ${inline(target.tag, 80)}`)
  const harnessResult = checkoutHarness({
    tag: target.tag,
    dest: resolve(migrateHome, 'harness'),
    timeoutMs: config.timeouts.checkoutMs,
  })
  if (!harnessResult.ok) {
    // git's own text, in the language the runner is set to, and several lines of
    // it: one line here, because this goes to stdout.
    logLine(`harness checkout skipped: ${inline(harnessResult.detail ?? 'no reason given', 300)}`)
  } else {
    logLine(`harness source at ${inline(harnessResult.path, 300)}`)
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
    // The recorded tag is read out of the state branch: one line of it, because
    // this goes to stdout where the runner parses workflow commands.
    logLine(`stage: baseline probe ${inline(baselineRef.tag, 80)} (${inline(baselineRef.source, 40)})`)
    baselineProbe = await probeAt(baselineRef.tag)
    logLine(`baseline probe: ${baselineProbe.outcome} (${inline(baselineProbe.signature, 200)})`)
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
            const pluginNameForBrief = readPluginName(workdir)
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
              tag: target.tag,
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
      liveView?.publish(`dsh-migrate: ${error.message}`)
      await view.close()
      process.stderr.write(`${error.message}\n`)
      writeGithubOutput({
        status: 'failed',
        run_dir: runDir,
        mechanical_ok: 'false',
        skipped_review: 'false',
        target_tag: target.tag,
      })
      await view.close()
      return 1
    }
    await view.close()
    throw error
  }

  // The run page is where a human actually looks: render the verdict, the
  // baseline attribution and the failing layer there. The name the report calls
  // the plugin by is read the same way the pipeline reads it, so a package.json
  // the migration left behind cannot make this fail or forge a line.
  const pluginLabel = readPluginName(workdir)
  // The run page is where a human actually looks, and the thread is where they
  // are: both are said in one place, which is also the one place a test can
  // reach without an agent session.
  await finishRun({
    view,
    result,
    target,
    pluginName: pluginLabel,
    runDir,
    workdir,
    token: skipGithub ? undefined : githubToken,
    writeSummary: writeStepSummary,
    comment: githubToken === undefined || skipGithub ? undefined : publisherComment(githubToken),
    log: logLine,
  })

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
        // The record's subject is the state writer's to name: it is the one place
        // that knows the tag it is recording.
        seedUnverified ? 'dsh-migrate: refresh badge' : undefined,
      )
      if (code !== 0) {
        await view.close()
        return code
      }
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
  await view.close()
  return result.status === 'failed' ? 1 : 0
}

void main(process.argv).then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
  process.exitCode = 1
})
