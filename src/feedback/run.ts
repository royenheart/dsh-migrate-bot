import { BUILTIN_CHANNELS, BUILTIN_CHANNEL_IDS } from './channels.ts'
import { channelPrompt } from './prompts.ts'
import { collectEvidence } from './evidence.ts'
import { renderEvidence } from './render.ts'
import { deliver } from './deliver.ts'
import { inline } from '../render/text.ts'
import { parseDedupePayload, parseFeedbackPayload, type DedupeDecision } from './parse.ts'
import { fetchPullRequestDetail, resolveRepo } from '../github/pr.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { MigrateConfig } from '../config/schema.ts'
import { commandRecorded, mergeReportKey, type CommandRecord } from '../commands/idempotency.ts'
import type { SeenState } from '../watch/seen.ts'
import type { FeedbackOutcome, FeedbackResult, ResolvedChannel } from './types.ts'

/**
 * The feedback stage.
 *
 * It runs after a migrate pull request is **merged**, never when one is opened.
 * Opening a pull request proves only that the Action had an opinion; the merge
 * is the maintainer's verdict on that opinion, and only the verdict is worth
 * forwarding to anyone else. A run therefore collects three things — the merge,
 * the human comments around it, and whatever the maintainer edited on the branch
 * first — and hands them to one session per enabled channel.
 *
 * Every channel is off by default and every channel needs its own token, because
 * none of the three targets is the plugin repository the workflow's
 * `GITHUB_TOKEN` is minted for. A channel that is on without a token, without a
 * draft to classify, or without a merge to report on is skipped with a reason in
 * the log; nothing in this stage can fail the run.
 */

export interface FeedbackRunInput {
  workdir: string
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  log: (message: string) => void
  /** State as recorded before this run reconciled the merge. */
  seen?: SeenState | undefined
  /** Pull request to report on; defaults to the recorded pending one. */
  pullRequest?: number | undefined
  /** DeepSeek API key; without it no session can run. */
  apiKey?: string | undefined
  /** Runner for one channel session. Omitted when no session may be started. */
  agent?: AgentRunner | undefined
  /**
   * Produce each channel's payload and deliver nothing.
   *
   * A dry run still runs the sessions, because the thing a user wants to
   * review is the text that would be sent and only a session produces it. It
   * therefore costs what a send costs; what it saves is the mistake.
   */
  dryRun?: boolean | undefined
  /**
   * Whether a merge is required to report at all.
   *
   * True for the automatic path, which runs on a merge event: a pull request
   * that was closed unmerged proves nothing and sends nothing. False for an
   * explicit command, which exists precisely so a user can report a run whose
   * pull request is still open — that is the difference between the automatic
   * default and the manual override.
   */
  requireMerged?: boolean | undefined
  /**
   * Report to a channel this merge was already reported to.
   *
   * Off by default: a re-run of the merge workflow exists to reach the channels
   * that were skipped or failed the first time, and a duplicate in somebody
   * else's repository is the one mistake this stage cannot take back. On, for a
   * channel whose configuration or prompt changed since it last received one.
   */
  resend?: boolean | undefined
  fetchImpl?: typeof fetch | undefined
  now?: (() => Date) | undefined
}

/**
 * Fold config over the built-in table: a built-in keeps every field it ships
 * unless the user overrode it, and a user-named channel must already carry the
 * three fields nothing can default for it.
 * @param config - the parsed configuration.
 */
export function resolveChannels(config: MigrateConfig): ResolvedChannel[] {
  const ids = [
    ...BUILTIN_CHANNEL_IDS,
    ...Object.keys(config.feedback.channels).filter(id => !(id in BUILTIN_CHANNELS)),
  ]
  const channels: ResolvedChannel[] = []
  for (const id of ids) {
    const entry = config.feedback.channels[id]
    if (entry === undefined) continue
    const builtin = BUILTIN_CHANNELS[id]
    const repo = entry.repo ?? builtin?.repo
    const method = entry.method ?? builtin?.method
    if (repo === undefined || method === undefined) continue
    channels.push({
      id,
      repo,
      method,
      tokenEnv: entry.tokenEnv ?? builtin?.tokenEnv ?? '',
      kind: builtin?.kind ?? 'analysis',
      labels: entry.labels ?? builtin?.labels ?? [],
      discussionCategory: entry.discussionCategory ?? builtin?.discussionCategory ?? 'ideas',
      prompt: entry.prompt,
      builtin: builtin !== undefined,
    })
  }
  return channels
}

/** Turn a merged pull request's number into the one the state recorded, if missing. */
function resolvePullRequestNumber(input: FeedbackRunInput): number | undefined {
  if (input.pullRequest !== undefined) return input.pullRequest
  const pending = input.seen?.pending
  if (pending !== undefined) return pending.pr
  return undefined
}

/**
 * Run the feedback stage for one merged migrate pull request.
 * @param input - workdir, config, environment, and the injectable runner.
 */
export async function runFeedback(input: FeedbackRunInput): Promise<FeedbackResult> {
  const outcomes: FeedbackOutcome[] = []
  const channels = resolveChannels(input.config)
  const report = (outcome: FeedbackOutcome): void => {
    outcomes.push(outcome)
    input.log(`feedback[${outcome.channel}]: ${outcome.status}${describe(outcome)}`)
  }

  const settle = (reason: string): FeedbackResult => {
    for (const channel of channels) {
      if (!enabledChannel(channel, input.config)) {
        report({ channel: channel.id, status: 'skipped', reason: 'disabled in config' })
      } else {
        report({ channel: channel.id, status: 'skipped', reason })
      }
    }
    input.log(`feedback: ${inline(reason, 300)}`)
    return { ran: false, reason, outcomes }
  }

  if (!input.config.feedback.enabled) return settle('feedback is disabled (feedback.enabled: false)')

  const number = resolvePullRequestNumber(input)
  if (number === undefined) return settle('no migrate pull request recorded; nothing to report on')

  const readToken = input.env.GITHUB_TOKEN
  if (readToken === undefined || readToken === '') {
    return settle('GITHUB_TOKEN is required to read the merged pull request')
  }

  let detail
  try {
    detail = await fetchPullRequestDetail({
      token: readToken,
      ...repositoryOf(input.workdir),
      number,
      fetchImpl: input.fetchImpl ?? fetch,
    })
  } catch (error) {
    return settle(`could not read pull request #${String(number)}: ${message(error)}`)
  }
  if (detail === undefined) return settle(`pull request #${String(number)} does not exist`)
  if (detail.state !== 'merged') {
    if (input.requireMerged !== false) {
      return settle(`pull request #${String(number)} is ${detail.state}, not merged; the maintainer did not accept this migration`)
    }
    if (detail.state !== 'open') {
      // A closed or missing pull request proves nothing, so the manual override
      // does not reach it: the override exists so a user can report a run whose
      // pull request is still under review, not so a rejected one can be sent.
      return settle(`pull request #${String(number)} is ${detail.state}; the manual override reports an open pull request, not a closed one`)
    }
    input.log(`feedback: reporting open pull request #${String(number)} on request, which the maintainer has not merged`)
  }

  let evidence
  try {
    evidence = await collectEvidence({
      workdir: input.workdir,
      seen: input.seen,
      token: readToken,
      pullRequest: detail,
      fetchImpl: input.fetchImpl ?? fetch,
    })
  } catch (error) {
    return settle(`could not collect evidence: ${message(error)}`)
  }
  input.log(
    `feedback: pull request #${String(number)} merged; `
    + `${String(evidence.comments.length)} comment(s), `
    + `${String(evidence.maintainerChanges.files.length)} maintainer-edited file(s), `
    + `${String(evidence.reports.patchReports.length)} patch report(s)`,
  )

  // What this merge has already reached. The record names the merge rather than
  // the delivery, so it is the same record on every attempt at reporting it.
  const reported = channelReport(detail.number, input)
  if (reported?.channels !== undefined && reported.channels.length > 0) {
    // The record is read out of the state branch, and this line is written to
    // stdout where the runner parses workflow commands: one line of each field.
    input.log(
      `feedback: this merge was already reported at ${inline(reported.at, 40)}`
      + ` to ${reported.channels.map(channel => inline(channel, 40)).join(', ')}`,
    )
  }

  for (const channel of channels) {
    if (!enabledChannel(channel, input.config)) {
      report({ channel: channel.id, status: 'skipped', reason: 'disabled in config' })
      continue
    }
    if (reported?.channels?.includes(channel.id) === true) {
      report({
        channel: channel.id,
        status: 'skipped',
        reason: `this merge was already reported to it at ${reported.at}; \`--resend\` reports it again`,
      })
      continue
    }
    const token = channel.tokenEnv === '' ? undefined : input.env[channel.tokenEnv]
    if (token === undefined || token === '') {
      report({
        channel: channel.id,
        status: 'skipped',
        reason: `enabled but ${channel.tokenEnv === '' ? 'no token is configured' : `${channel.tokenEnv} is not set`}`
          + ` (a token that may write to ${channel.repo} is required; GITHUB_TOKEN cannot)`,
      })
      continue
    }
    if (input.agent === undefined) {
      report({ channel: channel.id, status: 'skipped', reason: 'no agent runner is available for this invocation' })
      continue
    }
    if (input.apiKey === undefined) {
      report({ channel: channel.id, status: 'skipped', reason: 'no DeepSeek API key is configured' })
      continue
    }
    if (channel.kind === 'dedupe' && evidence.reports.patchReports.every(entry => entry.kind === 'existing')) {
      report({ channel: channel.id, status: 'skipped', reason: 'no discussion draft: every patch report already cites an official thread' })
      continue
    }
    try {
      const outcome = await runChannel({
        channel,
        evidence,
        token,
        apiKey: input.apiKey,
        agent: input.agent,
        workdir: input.workdir,
        config: input.config,
        dryRun: input.dryRun === true,
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
        ...(input.now === undefined ? {} : { now: input.now }),
      })
      report(outcome)
    } catch (error) {
      report({ channel: channel.id, status: 'failed', reason: message(error) })
    }
  }

  return { ran: true, outcomes }
}

function enabledChannel(channel: ResolvedChannel, config: MigrateConfig): boolean {
  return config.feedback.channels[channel.id]?.enabled === true
}

/**
 * One outcome, as the log line that carries it.
 *
 * Every field here is text this Action did not write: a channel's answer names a
 * URL and a detail, and a draft's title came out of a model reading somebody
 * else's plugin. The line is written to stdout, where the runner parses workflow
 * commands, so each is collapsed before it is interpolated.
 */
function describe(outcome: FeedbackOutcome): string {
  switch (outcome.status) {
    case 'delivered':
      return ` → ${outcome.method}${outcome.url === undefined ? '' : ` ${inline(outcome.url, 300)}`}`
        + (outcome.detail === undefined ? '' : ` (${inline(outcome.detail, 300)})`)
    case 'held':
      return ` — ${inline(outcome.reason, 300)}`
    case 'dry-run':
      return ` — would send ${outcome.method}: \"${inline(outcome.title, 200)}\"`
    case 'skipped':
      return ` — ${inline(outcome.reason, 300)}`
    case 'failed':
      return ` — ${inline(outcome.reason, 300)}`
    default: {
      const exhaustive: never = outcome
      return String(exhaustive)
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The plugin repository, read from the git remote like the rest of the Action. */
function repositoryOf(workdir: string): { owner: string; repo: string } {
  return resolveRepo(workdir)
}

/**
 * What this merge has already been reported to, from the recorded ledger.
 *
 * A merge whose report reached a channel must not reach it again on a re-run,
 * and only the record can say which channels those were.
 * @param pullRequest - the merged pull request.
 * @param input - the run, for the recorded state and the `resend` override.
 */
function channelReport(pullRequest: number, input: FeedbackRunInput): CommandRecord | undefined {
  if (input.resend === true) return undefined
  let repository: string
  try {
    const resolved = repositoryOf(input.workdir)
    repository = `${resolved.owner}/${resolved.repo}`
  } catch {
    // Without a repository there is no key to look up, and guessing one would
    // silently suppress a report.
    return undefined
  }
  return commandRecorded(input.seen?.commands ?? [], mergeReportKey(repository, pullRequest))
}

async function runChannel(input: {
  channel: ResolvedChannel
  evidence: Awaited<ReturnType<typeof collectEvidence>>
  token: string
  apiKey: string
  agent: AgentRunner
  workdir: string
  config: MigrateConfig
  dryRun: boolean
  fetchImpl?: typeof fetch
  now?: () => Date
}): Promise<FeedbackOutcome> {
  const dedupe = input.channel.kind === 'dedupe'
  const evidence = renderEvidence(input.evidence, { includeCandidates: dedupe })
  const prompt = channelPrompt(input.channel, evidence)
  const session = await input.agent.run({
    kind: 'feedback',
    prompt,
    workdir: input.workdir,
    dsh: input.config.dsh,
    apiKey: input.apiKey,
  })

  const branch = `dsh-migrate-feedback/${input.channel.id}-${(input.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')}`
  const target = {
    repo: input.channel.repo,
    method: input.channel.method,
    labels: input.channel.labels,
    category: input.channel.discussionCategory,
    channel: input.channel.id,
  }
  const delivery = {
    token: input.token,
    target,
    branch,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  }

  if (!dedupe) {
    const parsed = parseFeedbackPayload(session.report)
    if (!parsed.ok) return { channel: input.channel.id, status: 'failed', reason: parsed.reason }
    if (input.dryRun) {
      return {
        channel: input.channel.id,
        status: 'dry-run',
        method: input.channel.method,
        title: parsed.value.title,
        bodyPreview: parsed.value.body.slice(0, 1_200),
      }
    }
    const delivered = await deliver({ ...delivery, payload: parsed.value })
    return {
      channel: input.channel.id,
      status: 'delivered',
      method: input.channel.method,
      ...(delivered.url === undefined ? {} : { url: delivered.url }),
    }
  }

  const parsed = parseDedupePayload(session.report)
  if (!parsed.ok) return { channel: input.channel.id, status: 'failed', reason: parsed.reason }
  if (input.dryRun) {
    const drafts = input.evidence.reports.patchReports.filter(report => report.kind === 'draft')
    const decided = parsed.value
      .map(decision => `${decision.slug}: ${decision.post ? 'would post' : `would hold — ${decision.reason}`}`)
      .join('; ')
    return {
      channel: input.channel.id,
      status: 'dry-run',
      method: input.channel.method,
      title: `${String(drafts.length)} draft(s) classified`,
      bodyPreview: decided,
    }
  }
  return await deliverDrafts({ ...delivery, decisions: parsed.value, evidence: input.evidence })
}

/**
 * Post the drafts the classifier cleared, one topic per draft.
 *
 * A held draft is not an error: the whole point of the check is that the
 * request may already exist, and reporting which thread covers it is the useful
 * half of the answer.
 */
async function deliverDrafts(input: {
  token: string
  target: Parameters<typeof deliver>[0]['target']
  branch: string
  decisions: DedupeDecision[]
  evidence: Awaited<ReturnType<typeof collectEvidence>>
  fetchImpl?: typeof fetch
}): Promise<FeedbackOutcome> {
  const drafts = input.evidence.reports.patchReports.filter(report => report.kind === 'draft')
  const held: string[] = []
  const posted: string[] = []
  for (const draft of drafts) {
    const decision = input.decisions.find(entry => entry.slug === draft.slug)
    if (decision === undefined) {
      held.push(`${draft.slug}: the classifier returned no decision`)
      continue
    }
    if (!decision.post) {
      const because = decision.existing.length === 0
        ? decision.reason
        : `${decision.reason} (${decision.existing.map(entry => entry.url).join(', ')})`
      held.push(`${draft.slug}: ${because}`)
      continue
    }
    const delivered = await deliver({
      token: input.token,
      target: input.target,
      payload: { title: draft.title, body: draft.body, files: [] },
      branch: `${input.branch}-${draft.slug}`,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    })
    posted.push(`${draft.slug}${delivered.url === undefined ? '' : ` ${delivered.url}`}`)
  }
  const channel = input.target.channel
  if (posted.length === 0) {
    return { channel, status: 'held', reason: held.join('; ') || 'no draft was cleared to post' }
  }
  return {
    channel,
    status: 'delivered',
    method: input.target.method,
    url: posted.map(entry => entry.split(' ').slice(1).join(' ')).filter(url => url !== '').join(', ') || undefined,
    ...(held.length === 0 ? {} : { detail: `held: ${held.join('; ')}` }),
  }
}
