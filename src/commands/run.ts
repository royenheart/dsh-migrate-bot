import {
  createDeployClient,
  parseFrozenRevision,
  parsePreviewState,
  type DeployTarget,
  type PreviewKey,
} from '../deploy/client.ts'
import {
  applyHandback,
  invalidBranch,
  invalidCommit,
  invalidRevision,
  type HandbackResult,
} from '../deploy/handback.ts'
import { renderGateReport, type GateReport, type GateStep } from '../verify/gates.ts'
import { ensureMigrateGitExclude } from '../git/worktree.ts'
import { externalUrl, inline } from '../render/text.ts'
import { fetchPullRequestDetail, resolveRepo } from '../github/pr.ts'
import { resolve } from 'node:path'
import { commandHasEffect, renderCommandHelp } from './table.ts'
import {
  commandKey,
  commandRecorded,
  repeatReply,
  type CommandIdentity,
  type CommandRecord,
} from './idempotency.ts'
import { resolveChannels } from '../feedback/run.ts'
import type { ParsedCommand } from './parse.ts'
import type { FeedbackResult } from '../feedback/types.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { SeenState } from '../watch/seen.ts'

/**
 * Execute one parsed command.
 *
 * The executor never throws and always produces the reply that goes back on the
 * thread it came from: a command that cannot run is answered with why, because
 * the answer is the audit trail and silence would read as a bot that is broken.
 */

export interface CommandRunInput {
  command: ParsedCommand
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  workdir: string
  /** Recorded state, as the state branch holds it. */
  seen?: SeenState | undefined
  /** The pull request the command is about, when the caller knows it. */
  pullRequest?: number | undefined
  /** The comment the command came from, which is what makes a redelivery a repeat. */
  commentId?: string | undefined
  log: (message: string) => void
  /** Runs the feedback stage; injected so the verb table stays free of it. */
  feedback?: ((options: { dryRun: boolean; resend: boolean }) => Promise<FeedbackResult>) | undefined
  /**
   * Runs the gate stack in a tree a publish applied.
   *
   * Injected for the same reason as the feedback stage, and for one more: a
   * publish that pushed without being able to verify would be a second path to
   * the branch, which is the thing the whole design refuses.
   */
  gates?: ((tree: string) => Promise<GateReport>) | undefined
  /** Where a publish's temporary worktree goes. */
  treeDir?: string | undefined
  fetchImpl?: typeof fetch | undefined
}

export interface CommandOutcome {
  ok: boolean
  /** Markdown that answers the command on the thread. */
  reply: string
  /**
   * This delivery was a repeat of one already carried out.
   *
   * Reported separately from the reply because a workflow cannot read prose: a
   * suppressed command is a different outcome from an executed one, and a step
   * summary that cannot say which happened is not an audit trail.
   */
  repeat?: true
  /**
   * The ledger entry the caller must persist, present only when the command
   * acted and succeeded.
   *
   * Returned rather than written here because the state branch is reached
   * through git and the caller owns the checkout. Absent means "record
   * nothing": a read-only verb has nothing to suppress, and a failed one must
   * stay retryable by re-running the workflow.
   */
  record?: CommandRecord
}

/** The deploy target from config and environment, or why there is none. */
export function resolveDeployTarget(
  config: MigrateConfig,
  env: NodeJS.ProcessEnv,
): DeployTarget | { reason: string } {
  if (!config.deploy.enabled) return { reason: 'no deploy target is configured (`deploy.enabled` is false)' }
  if (config.deploy.endpoint === undefined) return { reason: '`deploy.enabled` is true but `deploy.endpoint` is unset' }
  const token = env[config.deploy.tokenEnv]
  if (token === undefined || token === '') {
    return { reason: `\`${config.deploy.tokenEnv}\` is not set, so the deploy target cannot be reached` }
  }
  return { endpoint: config.deploy.endpoint, token }
}

/**
 * Run one command and produce its reply.
 * @param input - the parsed command and everything it may need.
 */
export async function runCommand(input: CommandRunInput): Promise<CommandOutcome> {
  const { spec, flags } = input.command
  // One predicate decides both halves of layer 1: what a repeat is checked
  // against, and what a success is written down as. Two separate rules would
  // eventually disagree, and the disagreement would be either a command that is
  // recorded but never suppressed or one that is suppressed without a record.
  const effectful = commandHasEffect(spec, flags)
  // Resolved once and used for both the key and the preview call, so a command
  // cannot be keyed against one repository and sent to another. The environment
  // comes first: `GITHUB_REPOSITORY` is what the workflow is running for, and a
  // transient failure to read the remote must not change a command's identity.
  const repository = resolveRepoOrUndefined(input.workdir, input.env)
  const key = commandKey(commandIdentityOf(input, repository, spec.verb, flags))
  const record = (channels?: readonly string[]): Pick<CommandOutcome, 'record'> => ({
    record: {
      key,
      verb: spec.verb,
      at: new Date().toISOString(),
      ...(channels === undefined || channels.length === 0 ? {} : { channels: [...channels] }),
    },
  })
  if (effectful) {
    const already = commandRecorded(input.seen?.commands ?? [], key)
    if (already !== undefined) {
      // Answered, not repeated. Nothing was sent, so there is nothing new to
      // record either, and the record from the first delivery stands.
      input.log(`command ${spec.verb}: repeat of a command already carried out (${key})`)
      return { ok: true, reply: repeatReply(already), repeat: true }
    }
  }
  input.log(`command ${spec.verb}: idempotency key ${key}`)

  const target = resolveDeployTarget(input.config, input.env)

  if (spec.verb === 'status') return await statusCommand(input, target, repository)
  if (spec.verb === 'feedback') {
    const { delivered, ...outcome } = await feedbackCommand(
      input,
      flags.includes('--dry-run'),
      // `--resend` reports a merge to a channel that already received it, for a
      // channel whose configuration or prompt has changed since.
      flags.includes('--resend'),
    )
    // A send that reached no channel changed nothing outside this run, so it is
    // not recorded and a redelivery of the same comment retries it. The record
    // tracks what changed, not what was attempted.
    return effectful && delivered.length > 0 ? { ...outcome, ...record(delivered) } : outcome
  }

  if ('reason' in target) {
    return { ok: false, reply: `**\`${spec.verb}\` cannot run:** ${target.reason}` }
  }
  if (input.command.spec.needsTarget && !input.config.deploy.preview.enabled) {
    return {
      ok: false,
      reply: `**\`${spec.verb}\` cannot run:** previews are off (\`deploy.preview.enabled\` is false).`,
    }
  }
  const preview = previewKeyOf(input, repository)
  if (preview === undefined) {
    return {
      ok: false,
      reply: `**\`${spec.verb}\` cannot run:** no pull request number was given, so there is no preview to act on. Map \`pull_request\` to the comment's issue number in the workflow and the command will name one.`,
    }
  }
  const client = createDeployClient(target, input.fetchImpl, key)
  if (spec.verb === 'publish') return await publishCommand(input, client, preview, record, effectful)
  // The target resolves the pull request's current head itself: this
  // invocation may be a comment handler with no checkout of that branch, and a
  // sha guessed here would be the wrong commit to rebuild from.
  // An explicit switch rather than a chain: a verb the table grows later must
  // fail loudly here instead of quietly doing whatever the last arm does.
  const result = spec.verb === 'redeploy'
    ? await client.redeploy(preview)
    : spec.verb === 'destroy'
      ? await client.destroy(preview)
      : spec.verb === 'extend'
        // The target enforces the limit, so it is given the numbers to enforce:
        // what this command asks for, and the ceiling it may not pass.
        ? await client.extend(preview, {
          days: input.config.deploy.preview.extendDays,
          maxTtlDays: input.config.deploy.preview.ttlDays,
        })
        : undefined
  if (result === undefined) {
    return {
      ok: false,
      reply: `**\`${spec.verb}\` cannot run:** this Action has no handler for it on a deploy target.`,
    }
  }

  // The reason is a target's own text — a transport error's message — and this
  // line is written to stdout: one line of it, like the reply below.
  input.log(`command ${spec.verb}: ${inline(result.ok ? result.detail : result.reason, 300)}`)
  if (!result.ok) {
    return { ok: false, reply: `**\`${spec.verb}\` failed:** ${inline(result.reason, 300)}` }
  }
  // A target that answered from the key it was given has already done this once;
  // saying "accepted" without that would read as a second rebuild.
  const replayed = result.replayed === true
    ? '\n\nThe target recognised this command as one it had already carried out, so it answered with the result it gave then instead of doing the work again.'
    : ''
  // Honest wording matters more than encouraging wording here: this Action is
  // not what runs the gates on a publish. The target owns the change, and the
  // pipeline runs only if the target hands the diff back to it.
  const asked = spec.verb === 'extend'
    ? ` It asked for ${String(input.config.deploy.preview.extendDays)} day(s), with ${String(input.config.deploy.preview.ttlDays)} as the ceiling; the target decides what it grants.`
    : ''
  // A target that answered from the key it was given has already done this once,
  // and that is what the thread has to hear — for every verb, including the ones
  // with extra sentences of their own.
  const head = result.replayed === true
    ? `**\`${spec.verb}\` already done.**${replayed}`
    : `**\`${spec.verb}\` accepted.**`
  return {
    ok: true,
    reply: `${head}${asked}`,
    ...(effectful ? record() : {}),
    ...(result.replayed === true ? { repeat: true as const } : {}),
  }
}

function resolveRepoOrUndefined(
  workdir: string,
  env: NodeJS.ProcessEnv,
): { owner: string; repo: string } | undefined {
  try {
    // `parseGithubRepo` prefers `GITHUB_REPOSITORY`, so a run with no usable
    // remote and one with a remote resolve to the same repository.
    return resolveRepo(workdir, env)
  } catch {
    return undefined
  }
}

/**
 * Where a command came from, which is what its key is derived from.
 *
 * The repository and the pull request are read from the checkout and the
 * recorded state rather than from the comment, because a comment is text a user
 * wrote and this identity decides whether an effect happens.
 * @param input - the command and its environment.
 * @param repository - the repository, resolved from the environment first.
 * @param verb - the verb being keyed.
 * @param flags - the flags it was written with.
 */
function commandIdentityOf(
  input: CommandRunInput,
  repository: { owner: string; repo: string } | undefined,
  verb: string,
  flags: readonly string[],
): CommandIdentity {
  // Only what the delivery carries: the pull request the caller named, never
  // the one the state branch records, which a scheduled run rewrites.
  const issueNumber = input.pullRequest
  return {
    repository: repository === undefined ? 'unknown' : `${repository.owner}/${repository.repo}`,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    verb,
    flags,
    ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
    ...(input.env.GITHUB_RUN_ID === undefined ? {} : { runId: input.env.GITHUB_RUN_ID }),
  }
}

function previewKeyOf(
  input: CommandRunInput,
  repository: { owner: string; repo: string } | undefined,
): PreviewKey | undefined {
  if (input.pullRequest === undefined) return undefined
  if (repository === undefined) return undefined
  return { repository: `${repository.owner}/${repository.repo}`, pullRequest: input.pullRequest }
}

/**
 * `status`: everything this Action knows, including what the target knows.
 *
 * It is the one verb that reports rather than acts, so it reports the whole
 * picture: the recorded state, the channels, the commands already carried out,
 * and — because a user asking about a preview is asking about the target's
 * instance, not this Action's record of a request — the preview's own state.
 * An unreachable target is a line in the answer, never a failed command.
 * @param input - the command and everything it may need.
 * @param target - the deploy target, or why there is none.
 * @param repository - the checkout's repository, already resolved.
 */
async function statusCommand(
  input: CommandRunInput,
  target: DeployTarget | { reason: string },
  repository: { owner: string; repo: string } | undefined,
): Promise<CommandOutcome> {
  const seen = input.seen
  const lines: string[] = ['**Migration state**', '']
  lines.push(`- Recorded tag: ${seen?.tag === undefined ? '—' : `\`${inline(seen.tag, 80)}\``}`)
  lines.push(`- Verified tag: ${seen?.verified?.tag === undefined ? '—' : `\`${inline(seen.verified.tag, 80)}\``}`)
  lines.push(`- Pending pull request: ${seen?.pending === undefined ? 'none' : `#${String(seen.pending.pr)}`}`)
  lines.push('', '**Feedback channels**', '')
  // Resolved, not raw: a built-in channel takes its token name from the shipped
  // default, and reading the config entry alone would report every built-in as
  // having no token name at all.
  const channels = resolveChannels(input.config)
  for (const channel of channels) {
    const entry = input.config.feedback.channels[channel.id]
    const enabled = input.config.feedback.enabled && entry?.enabled === true
    if (!enabled) {
      lines.push(`- \`${channel.id}\`: off`)
      continue
    }
    const hasToken = channel.tokenEnv !== '' && (input.env[channel.tokenEnv] ?? '') !== ''
    lines.push(
      `- \`${channel.id}\`: on${hasToken ? '' : `, but \`${channel.tokenEnv === '' ? '(no tokenEnv)' : channel.tokenEnv}\` is not set`}`,
    )
  }
  if (input.config.deploy.enabled) {
    lines.push('', '**Deploy target**', '', `- \`${input.config.deploy.endpoint ?? '(unset)'}\``)
    lines.push(...await previewLines(input, target, repository))
  }
  lines.push(...ledgerLines(seen?.commands))
  lines.push('', `<details><summary>Commands</summary>`, '', renderCommandHelp(), '', '</details>')
  return { ok: true, reply: lines.join('\n') }
}

/**
 * What the target says about the preview, which is the half this Action cannot
 * know: it asked for a rebuild, not for the result.
 */
async function previewLines(
  input: CommandRunInput,
  target: DeployTarget | { reason: string },
  repository: { owner: string; repo: string } | undefined,
): Promise<string[]> {
  if ('reason' in target) return [`- Preview: not asked for (${target.reason})`]
  const preview = previewKeyOf(input, repository)
  if (preview === undefined) {
    return [input.pullRequest === undefined
      ? '- Preview: not asked for (no pull request number was given, so there is no preview to name)'
      : "- Preview: not asked for (this checkout's repository could not be resolved, so there is no preview to name)"]
  }
  const result = await createDeployClient(target, input.fetchImpl).status(preview)
  if (!result.ok) return [`- Preview: the target could not be asked (${inline(result.reason, 300)})`]
  const state = parsePreviewState(result.body)
  if (state.state === undefined && state.url === undefined && state.headSha === undefined) {
    return ['- Preview: the target recorded no instance for this pull request']
  }
  const parts = [inline(state.state ?? 'recorded')]
  if (state.headSha !== undefined) parts.push(`built from \`${inline(state.headSha.slice(0, 8), 40)}\``)
  if (state.expiresAt !== undefined) parts.push(`until ${inline(state.expiresAt, 40)}`)
  if (state.extendedDays !== undefined) {
    parts.push(`the last extend bought ${String(state.extendedDays)} day(s)`)
  }
  const lines = [`- Preview: ${parts.join(', ')}`]
  // A URL is not text: it is what a human clicks, and one that carries a
  // credential would republish a secret in a comment. [The live view] owns the
  // rule for a page a target names; this renders the same kind of value the same
  // way.
  //
  // [The live view]: ../../docs/design/preview-and-live-view.md#5-access-control
  const page = state.url === undefined ? undefined : externalUrl(state.url, 300)
  if (page !== undefined) lines.push(`  - \`${page}\``)
  else if (state.url !== undefined) lines.push('  - the target named a page this Action will not link')
  const safe = state.safeUrl === undefined ? undefined : externalUrl(state.safeUrl, 300)
  if (safe !== undefined) lines.push(`  - safe entry: \`${safe}\``)
  else if (state.safeUrl !== undefined) lines.push('  - the target named a safe entry this Action will not link')
  if (state.revision !== undefined) lines.push(`  - frozen revision: \`${inline(state.revision, 200)}\``)
  return lines
}

/**
 * The commands this Action has already carried out, newest first.
 *
 * The record exists so a redelivery is answered rather than repeated, and a
 * maintainer who cannot see it cannot tell a suppressed command from a lost one.
 * Every field is collapsed before it is rendered, because the ledger is read
 * back out of the state branch: a key, a verb, a time and a channel name are
 * data from a file this run did not write.
 */
function ledgerLines(commands: readonly CommandRecord[] | undefined): string[] {
  if (commands === undefined || commands.length === 0) return []
  const newest = [...commands].reverse().slice(0, LEDGER_STATUS_ROWS)
  const showing = commands.length > newest.length ? `, showing the newest ${String(newest.length)}` : ''
  const lines = ['', `**Commands already carried out** (${String(commands.length)} recorded${showing})`, '']
  for (const record of newest) {
    const from = inline(commandOrigin(record.key), 60)
    const reached = record.channels === undefined || record.channels.length === 0
      ? ''
      : ` — reached ${record.channels.map(channel => inline(channel, 40)).join(', ')}`
    const at = record.at === '' ? 'an unrecorded time' : inline(record.at, 40)
    lines.push(`- \`${inline(record.verb, 40)}\` at ${at} (${from})${reached}`)
  }
  return lines
}

/** How many recorded commands `status` shows before it stops listing. */
const LEDGER_STATUS_ROWS = 5

/**
 * Where a recorded key came from, in words.
 *
 * The key is the whole identity and is not meant to be read; the origin is the
 * one part of it a maintainer recognises.
 * @param key - a ledger key.
 */
function commandOrigin(key: string): string {
  const comment = /:comment=([^:]+)$/.exec(key)
  if (comment?.[1] !== undefined) return `comment ${comment[1]}`
  if (/:run=/.test(key)) return 'a workflow run'
  if (key.endsWith(':feedback:merge')) return 'the merge report'
  return 'no comment or run id'
}

/**
 * `publish`: fulfil the target's request to put the frozen scratch on the branch.
 *
 * Everything here exists to keep one promise: the pull request branch has one
 * writer, and that writer runs the gates first. So the target freezes and this
 * applies, the gate stack decides, and only a green tree is pushed — and every
 * outcome, including a refusal and which stage refused, is what the thread gets
 * back.
 */
async function publishCommand(
  input: CommandRunInput,
  client: ReturnType<typeof createDeployClient>,
  preview: PreviewKey,
  record: () => Pick<CommandOutcome, 'record'>,
  effectful: boolean,
): Promise<CommandOutcome> {
  // Everything knowable before the freeze is checked first — the gate stack, the
  // pull request's branch, and its head — because a freeze is a state change on
  // somebody else's machine and a refusal after it leaves a revision frozen that
  // nothing consumes. What the target's own answer names can only be checked
  // once it arrives, and every one of those refusals is reported back to it.
  if (input.gates === undefined) {
    return {
      ok: false,
      reply: '**`publish` cannot run:** this invocation cannot run the gate stack, and a change reaches the branch only through the gates.',
    }
  }
  const target = await resolveBranchTarget(input, preview)
  if ('reason' in target) return { ok: false, reply: `**\`publish\` could not run:** ${target.reason}` }

  const frozen = await client.publish(preview)
  if (!frozen.ok) return { ok: false, reply: `**\`publish\` failed:** ${inline(frozen.reason, 300)}` }
  const revision = parseFrozenRevision(frozen.body)
  if (revision === undefined) {
    // An acknowledgement is not a hand-back: without a frozen revision there is
    // nothing to fetch, and saying "accepted" would claim a publish happened.
    return {
      ok: false,
      reply: [
        '**`publish` could not continue:** the deploy target acknowledged the request without freezing a revision.',
        '',
        'The hand-back is what a `publish` owes: `POST` answers `{ revision, baseSha, headSha }`, and the Action fetches that revision as a diff. [The publish hand-back](https://github.com/royenheart/dsh-migrate-bot/blob/main/docs/design/preview-and-live-view.md#81-the-publish-hand-back) is the contract.',
      ].join('\n'),
    }
  }
  // Everything the target just named is checked before it is logged, fetched or
  // applied: a revision is a string the target chose and it is about to be
  // echoed into the job log and the live view.
  const frozenProblem = invalidRevision(revision.revision)
    ?? (revision.headSha === undefined ? undefined : invalidCommit(revision.headSha))
  if (frozenProblem !== undefined) {
    return await refuseFrozen(client, preview, revision.revision, target.branch, frozenProblem, input.log)
  }
  input.log(`command publish: frozen revision ${revision.revision}`)

  const fetched = await client.scratch(preview, revision.revision)
  if (!fetched.ok) {
    // A revision the target cannot serve back is the target's to rebuild, and
    // the sentence says what the reader can do about it.
    return await refuseFrozen(
      client,
      preview,
      revision.revision,
      target.branch,
      `the target could not serve back the revision it froze (\`${revision.revision}\`): ${inline(fetched.reason, 300)}. Publishing again freezes a new one.`,
      input.log,
      'remote',
    )
  }
  const served = diffOf(fetched)
  if ('reason' in served) {
    return await refuseFrozen(
      client,
      preview,
      revision.revision,
      target.branch,
      `${served.reason}; a frozen revision is served as a unified diff, as the hand-back requires`,
      input.log,
    )
  }
  // The sha the target froze wins over the one read earlier: the diff was taken
  // against that tree, and applying it anywhere else applies it to the wrong
  // base. The branch comes from the pull request, which is where it goes.
  const headSha = revision.headSha ?? target.headSha
  const invalid = invalidBranch(target.branch) ?? invalidCommit(headSha) ?? invalidRevision(revision.revision)
  if (invalid !== undefined) {
    return await refuseFrozen(client, preview, revision.revision, target.branch, invalid, input.log)
  }

  // A publish is the one verb that leaves files in the checkout — its temporary
  // worktree — and they are mine, not the plugin's. A read-only verb writes
  // nothing, so this is here rather than on every invocation.
  try {
    ensureMigrateGitExclude(input.workdir)
  } catch (error) {
    input.log(`publish: could not extend the checkout's git exclude: ${error instanceof Error ? error.message : String(error)}`)
  }

  let applied: HandbackResult
  try {
    applied = await applyHandback({
      workdir: input.workdir,
      branch: target.branch,
      headSha,
      revision: revision.revision,
      diff: served.diff,
      repository: preview.repository,
      pullRequest: preview.pullRequest,
      treeDir: input.treeDir ?? resolve(input.workdir, '.dsh-migrate', 'publish-tree'),
      runGates: input.gates,
      log: input.log,
    })
  } catch (error) {
    // This verb runs git against a value a target chose; whatever escapes, the
    // thread still gets an answer, because the answer is the audit trail — and
    // the preview is told that the hand-back stopped rather than left waiting.
    // The message is the gate runner's own — code that came from the scratch
    // tree — so it is one bounded line here as well, in the reply a human reads
    // and in the body a target parses. A reply over GitHub's comment limit is
    // dropped, and a dropped reply is no audit trail at all.
    const detail = inline(error instanceof Error ? error.message : String(error), 300)
    const reported = await client.publishResult(preview, {
      revision: revision.revision,
      outcome: 'refused',
      stage: 'error',
      branch: target.branch,
      detail,
    })
    if (!reported.ok) input.log(`command publish: the target was not told how it ended: ${reported.reason}`)
    return {
      ok: false,
      reply: `**\`publish\` failed:** the hand-back stopped with an error: ${detail}`,
    }
  }
  await reportPublishOutcome(client, preview, applied, revision.revision, target.branch, input.log)
  // `command_repeat` says this delivery did nothing: either the target answered
  // from the key it was given, or the branch already carried the revision.
  const nothingDone = frozen.replayed === true || (applied.ok && applied.alreadyPublished === true)
  return publishReply(applied, revision.revision, target.branch, record, effectful, nothingDone)
}

/** One gate layer as the report carries it: what it said, and why it did not run. */
function gateDetail(step: GateStep): string {
  return inline(
    [step.detail, step.skipped === undefined ? '' : `skipped: ${step.skipped}`]
      .filter(part => part !== '')
      .join(' — '),
    300,
  )
}

/**
 * Refuse after the target froze a revision, and tell it so.
 *
 * Everything that can refuse *before* the freeze is checked first, so a refusal
 * here means the target is holding a revision this Action will never apply. A
 * preview that is told nothing waits forever, so every one of these paths
 * reports.
 * @param client - the target's client.
 * @param preview - the pull request the publish was about.
 * @param revision - the revision the target froze.
 * @param branch - the branch the change was for.
 * @param detail - why the Action stopped.
 * @param log - where a target that cannot be told is recorded.
 */
async function refuseFrozen(
  client: ReturnType<typeof createDeployClient>,
  preview: PreviewKey,
  revision: string,
  branch: string,
  detail: string,
  log: (message: string) => void,
  /** Which stage refused: a target-side read failure is not an apply failure. */
  stage: 'remote' | 'apply' | 'error' = 'apply',
): Promise<CommandOutcome> {
  await reportPublishOutcome(client, preview, {
    ok: false,
    stage,
    detail: inline(detail, 300),
  }, revision, branch, log)
  return { ok: false, reply: `**\`publish\` could not continue:** ${inline(detail, 300)}` }
}

/**
 * Say how the publish ended, where the preview can read it.
 *
 * Every outcome is reported, including a refusal and which stage refused, and a
 * target that does not serve this call is a line in the log rather than a
 * failure: the thread already has the answer, and the preview saying nothing is
 * the state this replaces.
 * @param client - the target's client.
 * @param preview - the pull request the publish was about.
 * @param applied - what the hand-back did.
 * @param revision - the target's own id for the frozen tree.
 * @param branch - the branch the change was for.
 * @param log - where a target that cannot be told is recorded.
 */
async function reportPublishOutcome(
  client: ReturnType<typeof createDeployClient>,
  preview: PreviewKey,
  applied: HandbackResult,
  revision: string,
  branch: string,
  log: (message: string) => void,
): Promise<void> {
  const result = await client.publishResult(preview, {
    revision,
    outcome: applied.ok ? 'published' : 'refused',
    branch,
    ...(applied.ok
      ? { commit: applied.commit, ...(applied.alreadyPublished ? { alreadyPublished: true as const } : {}) }
      : { stage: applied.stage, detail: inline(applied.detail, 300) }),
    // Which harness the refusal or the pass was judged against, when the gates
    // resolved one: a preview cannot render a verdict it cannot name.
    ...(applied.gates?.tag === undefined ? {} : { tag: inline(applied.gates.tag, 80) }),
    gates: (applied.gates?.steps ?? []).map(step => ({
      layer: step.layer,
      ok: step.ok,
      ...(gateDetail(step) === '' ? {} : { detail: gateDetail(step) }),
    })),
  })
  if (!result.ok) log(`command publish: the target was not told how it ended: ${result.reason}`)
}

/**
 * The diff a scratch answer carries, whether it was served as JSON or as a patch.
 *
 * A JSON answer without a `diff` field is reported as that, rather than having
 * its own JSON applied as a patch and failing with a message about the wrong
 * thing.
 * @param answer - what the target answered for the frozen revision.
 */
function diffOf(answer: { body?: unknown; text?: string }): { diff: string } | { reason: string } {
  const body = answer.body
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const diff = (body as { diff?: unknown }).diff
    if (typeof diff === 'string' && diff.trim() !== '') return { diff }
    if (typeof diff === 'string') {
      return { reason: 'the target served the frozen revision as an empty diff, and a frozen revision carries a change' }
    }
    return { reason: 'the target answered the frozen revision as JSON without a `diff` field' }
  }
  const text = answer.text ?? ''
  if (text.trim() === '') {
    return {
      reason: 'the target served the frozen revision as an empty diff, and a frozen revision always carries a change',
    }
  }
  return { diff: text }
}

/**
 * Where a published revision goes: the pull request's own head branch.
 *
 * The branch name is read from the API rather than guessed, because a push to a
 * guessed branch is a push to the wrong place, and the head sha the target froze
 * is preferred over the one read now — the diff was taken against that one.
 */
async function resolveBranchTarget(
  input: CommandRunInput,
  preview: PreviewKey,
): Promise<{ branch: string; headSha: string } | { reason: string }> {
  const token = input.env.GITHUB_TOKEN
  if (token === undefined || token === '') {
    return { reason: '`GITHUB_TOKEN` is not set, so the pull request head branch cannot be read' }
  }
  const [owner, repo] = preview.repository.split('/')
  if (owner === undefined || repo === undefined) {
    return { reason: `\`${preview.repository}\` is not an \`owner/name\` repository` }
  }
  let detail
  try {
    detail = await fetchPullRequestDetail({
      token,
      owner,
      repo,
      number: preview.pullRequest,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    })
  } catch (error) {
    return {
      reason: `pull request #${String(preview.pullRequest)} could not be read: ${inline(error instanceof Error ? error.message : String(error), 300)}`,
    }
  }
  if (detail === undefined) {
    return { reason: `pull request #${String(preview.pullRequest)} does not exist in \`${preview.repository}\`` }
  }
  if (detail.headRef === undefined) {
    return { reason: `pull request #${String(preview.pullRequest)} reports no head branch to push to` }
  }
  const branchProblem = invalidBranch(detail.headRef)
  if (branchProblem !== undefined) return { reason: branchProblem }
  if (detail.state !== 'open') {
    // A publish lands on an open pull request's branch, and the preview it came
    // from is destroyed when the pull request closes: there is nothing left to
    // review, and a push to a merged or closed branch is a change nobody asked
    // for.
    return {
      reason: `pull request #${String(preview.pullRequest)} is ${detail.state}; a publish lands on an open pull request's branch`,
    }
  }
  if (detail.headRepo !== undefined && detail.headRepo !== preview.repository) {
    // A fork's branch name means nothing in this repository: the same name here
    // is a different branch, and the pull request is not the one being updated.
    return {
      reason: `pull request #${String(preview.pullRequest)} has its head in \`${inline(detail.headRepo, 100)}\`; a publish pushes to the pull request's own branch in \`${preview.repository}\`, and this Action does not write to a fork`,
    }
  }
  if (detail.headSha === undefined) {
    return { reason: `pull request #${String(preview.pullRequest)} reports no head commit` }
  }
  return { branch: detail.headRef, headSha: detail.headSha }
}

/** What the thread is told about an attempted hand-back. */
function publishReply(
  applied: HandbackResult,
  revision: string,
  branch: string,
  record: () => Pick<CommandOutcome, 'record'>,
  effectful: boolean,
  /** Whether this delivery published nothing, however that came about. */
  nothingDone: boolean,
): CommandOutcome {
  if (applied.ok) {
    const head = applied.alreadyPublished
      ? `**\`publish\` already landed.** Revision \`${revision}\` is on \`${branch}\` as \`${applied.commit.slice(0, 8)}\`, so nothing was applied or pushed again.`
      : `**\`publish\` landed.** Revision \`${revision}\` is on \`${branch}\` as \`${applied.commit.slice(0, 8)}\`.`
    // The tag is the state branch's when the run read it from there, so it is
    // collapsed like every other value that came from outside this invocation.
    const against = applied.gates.tag === undefined
      ? ''
      : `\n\nVerified against \`${inline(applied.gates.tag, 80)}\`.`
    const gates = applied.gates.steps.length === 0 ? '' : `\n\n${renderGateReport(applied.gates)}`
    return {
      ok: true,
      reply: `${head}${against}${gates}`,
      ...(effectful ? record() : {}),
      ...(nothingDone ? { repeat: true as const } : {}),
    }
  }
  const stage = applied.stage === 'gates'
    ? 'the gates refused it'
    : applied.stage === 'apply'
      ? 'it could not be applied or committed'
      : applied.stage === 'base'
        ? 'the branch moved after the target froze that revision'
        : applied.stage === 'remote'
          ? 'the pull request branch could not be read from the remote, or this checkout is not the repository the command is about'
          : 'it could not be pushed'
  const gates = applied.gates === undefined ? '' : `\n\n${renderGateReport(applied.gates)}`
  return {
    ok: false,
    reply: [
      `**\`publish\` was refused:** ${stage}. Nothing reached \`${branch}\`.`,
      '',
      // Git's own refusal text quotes the target's patch, so it is one line here
      // like every other value that came from outside.
      inline(applied.detail, 600),
      gates,
    ].join('\n'),
  }
}

/** One channel outcome rendered for a reply. */
/**
 * One channel's outcome, as the line of the reply that carries it.
 *
 * A URL, a title and a reason here came from a channel's answer or from a
 * model's draft, and the reply is a comment: each is collapsed first.
 */
function feedbackDetail(outcome: FeedbackResult['outcomes'][number]): string {
  switch (outcome.status) {
    case 'delivered':
      return outcome.url === undefined ? '' : ` — ${inline(outcome.url, 300)}`
    case 'dry-run':
      return ` — would send ${outcome.method}: "${inline(outcome.title, 200)}"`
    default:
      return ` — ${inline(outcome.reason, 300)}`
  }
}

/** A feedback command's outcome, plus what actually left the run. */
interface FeedbackCommandOutcome extends CommandOutcome {
  /**
   * The channels that took delivery.
   *
   * `ran` alone is not enough: a stage where every channel failed ran, and its
   * failures are in the reply, but nothing outside this run changed. The ids are
   * kept rather than a boolean because the record is what tells a later run —
   * and the person reading `status` — which channels this command already
   * reached.
   */
  delivered: string[]
}

async function feedbackCommand(
  input: CommandRunInput,
  dryRun: boolean,
  resend: boolean,
): Promise<FeedbackCommandOutcome> {
  if (input.feedback === undefined) {
    return { ok: false, reply: '**`feedback` cannot run:** this invocation cannot start a feedback session.', delivered: [] }
  }
  const result = await input.feedback({ dryRun, resend })
  const lines: string[] = [dryRun ? '**Feedback dry run**' : '**Feedback**', '']
  if (!result.ran) lines.push(`Nothing was sent: ${result.reason ?? 'the stage did not run'}.`)
  else {
    for (const outcome of result.outcomes) {
      lines.push(`- \`${outcome.channel}\`: ${outcome.status}${feedbackDetail(outcome)}`)
      if (outcome.status === 'dry-run') {
        lines.push('', `<details><summary>Would send</summary>`, '', '```markdown', outcome.bodyPreview, '```', '', '</details>')
      }
    }
  }
  if (dryRun) lines.push('', '_Dry run: the sessions ran and the payloads were produced, but nothing was delivered._')
  return {
    ok: result.ran,
    reply: lines.join('\n'),
    delivered: result.outcomes
      .filter(outcome => outcome.status === 'delivered')
      .map(outcome => outcome.channel),
  }
}

export { renderCommandHelp }
