/**
 * Making a command safe to deliver twice.
 *
 * A command can arrive twice for reasons the user did not choose: GitHub
 * redelivers a webhook, someone re-runs the workflow, a comment is edited and
 * the event fires again, or the same instruction is posted twice. Every verb
 * here either costs money, changes a preview, or writes into somebody else's
 * repository, so a doubled delivery is not harmless.
 *
 * Two layers hold that, and each holds on its own:
 *
 * 1. **This Action remembers.** A command that has an effect is recorded in the
 *    state branch, and a second delivery of the same command is answered
 *    without repeating it. This is what covers the verbs that never reach a
 *    deploy target: `feedback` spends API quota and posts into other people's
 *    repositories.
 * 2. **The target is told.** Every mutating call carries `Idempotency-Key`, so
 *    a target that honours it cannot act twice even when layer 1 lost the race
 *    against a run writing the state branch at the same time. That header is
 *    specified in the target's API contract.
 *
 * The key is derived from the delivery, never from recorded state: the comment
 * that carried the command when there is one, and otherwise the workflow run
 * that delivered it. A key that folded in the pull request the state branch
 * records would change when a scheduled run opens the next one, and the same
 * comment would execute twice — which is the failure this module exists to
 * prevent. `verb` is part of the key so a comment edited into a different
 * command is a different command.
 *
 * The repository is part of the key because the key is also what the deploy
 * target sees, and a target serves several repositories: its own addressing is
 * `{repository}/{pullRequest}`, so a key without the repository would let one
 * repository's publish replay another's. It is read from the workflow's
 * environment rather than from the checkout, so a transient git failure cannot
 * change it. A repository *rename* therefore changes every key, and deliveries
 * made under the old name are new commands again; that is the one case this
 * shape does not survive.
 */

import { inline } from '../render/text.ts'

export interface CommandIdentity {
  /** The comment the command came from, when it came from one. */
  commentId?: string | undefined
  /** Repository this command acts on, `owner/name`. */
  repository: string
  /**
   * Pull request or issue the command named, when it named one.
   *
   * Never read from recorded state: a scope that a scheduled run can rewrite is
   * not part of the command's identity.
   */
  issueNumber?: number | undefined
  verb: string
  flags: readonly string[]
  /**
   * The workflow run that delivered it, used when there is no comment id.
   *
   * `GITHUB_RUN_ATTEMPT` is deliberately not part of this: re-running a
   * workflow is the same instruction delivered again, and the point is that the
   * second attempt is a repeat rather than a second command.
   */
  runId?: string | undefined
}

/**
 * A stable key for one command.
 *
 * The same delivery twice yields the same key; a different verb, a different
 * comment, or a different workflow run yields a different one. When there is
 * neither a comment id nor a run id the key falls back to the command's own
 * content, which is the most that can be promised without a delivery to anchor
 * to.
 * @param identity - what the command is and where it came from.
 */
export function commandKey(identity: CommandIdentity): string {
  const scope = identity.issueNumber === undefined ? '-' : String(identity.issueNumber)
  const base = `${identity.repository}#${scope}:${identity.verb}`
  const flags = [...identity.flags].sort().join(',')
  if (identity.commentId !== undefined && identity.commentId !== '') {
    return `${base}:comment=${identity.commentId}`
  }
  if (identity.runId !== undefined && identity.runId !== '') {
    return `${base}:run=${identity.runId}:flags=${flags}`
  }
  return `${base}:flags=${flags}`
}

/**
 * The key the automatic feedback path records a merge under.
 *
 * It shares the ledger with the commands because "already carried out" is one
 * fact about one repository, and a second place to remember it would be a second
 * place to disagree with it. It names the merge rather than the delivery, so
 * every attempt at reporting one merge produces the same key.
 * @param repository - `owner/name` of the repository the merge landed in.
 * @param pullRequest - the merged pull request.
 */
export function mergeReportKey(repository: string, pullRequest: number): string {
  return `${repository}#${String(pullRequest)}:feedback:merge`
}

/**
 * One thing this Action has already carried out.
 *
 * Deliberately not the reply: the reply is on the thread that asked for it, and
 * copying it there would put rendered payloads — including a dry run's draft
 * text — into a branch they were never meant to be read from. `channels` is the
 * exception, because which channels a merge reached decides which ones a re-run
 * still owes, and that cannot be recovered from anywhere else.
 */
export interface CommandRecord {
  key: string
  verb: string
  /** When it was answered, ISO 8601. */
  at: string
  /** Channels a merge report reached, for the one record that has channels. */
  channels?: string[]
}

/**
 * How many records are kept, and how old a record may be.
 *
 * Both bounds are real and neither is a promise about redelivery: a webhook can
 * be redelivered by hand at any time, and an old workflow can be re-run with its
 * comment id and run id unchanged. A record older than either bound is a new
 * command again, which is a second effect rather than a suppressed one.
 *
 * The two kinds are bounded apart because they answer different questions and
 * neither may be pushed out by the other: commands arrive whenever a human types
 * one, and a merge report is written once per merge, so one busy month of
 * commands must not be able to make a merge look unreported.
 */
export const LEDGER_LIMIT = 200
export const MERGE_LEDGER_LIMIT = 100
export const LEDGER_MAX_AGE_DAYS = 30

/** The verb a merge report is recorded under, which is also how `prune` tells the two kinds apart. */
export const MERGE_VERB = 'feedback (merge)'

function parseRecord(raw: unknown): CommandRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.key !== 'string' || record.key === '') return undefined
  if (typeof record.verb !== 'string' || record.verb === '') return undefined
  const parsed: CommandRecord = {
    key: record.key,
    verb: record.verb,
    at: typeof record.at === 'string' ? record.at : '',
  }
  const channels = Array.isArray(record.channels)
    ? record.channels.filter((channel): channel is string => typeof channel === 'string' && channel !== '')
    : []
  if (channels.length > 0) parsed.channels = channels
  return parsed
}

/**
 * Read the ledger out of whatever the state branch held. Invalid entries are
 * dropped one at a time rather than discarding the list, so one corrupt record
 * cannot make an already-answered command run a second time.
 * @param raw - the `commands` field as the branch held it.
 */
export function parseCommandLedger(raw: unknown): CommandRecord[] {
  if (!Array.isArray(raw)) return []
  const records: CommandRecord[] = []
  for (const entry of raw) {
    const record = parseRecord(entry)
    if (record !== undefined) records.push(record)
  }
  return prune(records)
}

/** The record for one key, when this Action has already carried that command out. */
export function commandRecorded(
  records: readonly CommandRecord[],
  key: string,
): CommandRecord | undefined {
  return records.find(record => record.key === key)
}

/** Drop what has aged out, then keep the newest of each kind. */
function prune(records: readonly CommandRecord[], now: Date = new Date()): CommandRecord[] {
  const oldest = now.getTime() - LEDGER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const fresh = records.filter((record) => {
    const at = Date.parse(record.at)
    // An unreadable timestamp is kept: dropping it would silently make the
    // command it stands for runnable again.
    return Number.isNaN(at) || at >= oldest
  })
  const kept: CommandRecord[] = []
  let commands = 0
  let merges = 0
  // Newest first, so what is dropped is what is oldest.
  for (let index = fresh.length - 1; index >= 0; index -= 1) {
    const record = fresh[index]
    if (record === undefined) continue
    if (record.verb === MERGE_VERB) {
      if (merges >= MERGE_LEDGER_LIMIT) continue
      merges += 1
    } else {
      if (commands >= LEDGER_LIMIT) continue
      commands += 1
    }
    kept.unshift(record)
  }
  return kept
}

/**
 * Two ledgers as one, without losing a record either of them holds.
 *
 * The state branch has several writers and each one replaces the whole file, so
 * the writer that reads last would otherwise decide what the record of the
 * other's work is. A key that both hold keeps the earlier `at`: the record that
 * matters is when the command was first carried out, not when somebody last
 * noticed it.
 * @param ledgers - the ledgers to combine, in any order.
 */
export function mergeCommandLedgers(...ledgers: readonly (readonly CommandRecord[])[]): CommandRecord[] {
  const byKey = new Map<string, CommandRecord>()
  for (const ledger of ledgers) {
    for (const record of ledger) {
      const held = byKey.get(record.key)
      if (held === undefined) {
        byKey.set(record.key, record)
        continue
      }
      const channels = [...new Set([...(held.channels ?? []), ...(record.channels ?? [])])]
      byKey.set(record.key, {
        key: record.key,
        verb: record.verb,
        at: earlier(held.at, record.at),
        ...(channels.length === 0 ? {} : { channels }),
      })
    }
  }
  const merged = [...byKey.values()].sort((left, right) => stamp(left.at) - stamp(right.at))
  return prune(merged)
}

/** Which of two timestamps came first, keeping an unreadable one out of the way. */
function earlier(left: string, right: string): string {
  const leftAt = Date.parse(left)
  const rightAt = Date.parse(right)
  if (Number.isNaN(leftAt)) return right
  if (Number.isNaN(rightAt)) return left
  return leftAt <= rightAt ? left : right
}

/** A timestamp as a number, with an unparseable one sorted last rather than dropped. */
function stamp(at: string): number {
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
}

/**
 * The ledger with one record written, oldest first and bounded.
 *
 * A key that is already there keeps the channels it had and gains the new ones,
 * because a merge reported to one channel and later to another reached both, and
 * a second write must not erase what the first one knows.
 * @param records - the ledger as it was read.
 * @param record - the record to write.
 * @param now - injectable clock for the age bound.
 */
export function withCommandRecord(
  records: readonly CommandRecord[],
  record: CommandRecord,
  now: Date = new Date(),
): CommandRecord[] {
  const existing = commandRecorded(records, record.key)
  const channels = [...new Set([...(existing?.channels ?? []), ...(record.channels ?? [])])]
  const next: CommandRecord = {
    key: record.key,
    verb: record.verb,
    at: record.at,
    ...(channels.length === 0 ? {} : { channels }),
  }
  return prune([...records.filter(entry => entry.key !== record.key), next], now)
}

/**
 * How a repeat answers.
 *
 * It says what happened, which channels it reached when that is known, and how
 * to ask again, because the honest answer to a doubled command is that the
 * second delivery did nothing. The original reply is where it always was: on the
 * thread, one comment up.
 *
 * Every field is collapsed before it is rendered: a record is read back out of
 * the state branch, which is a file another writer — or an older build, or a
 * hand edit — may have written, so its text is data like any other.
 * @param record - the record of the first delivery.
 */
export function repeatReply(record: CommandRecord): string {
  const when = record.at === '' ? 'earlier' : `at ${inline(record.at, 40)}`
  const reached = record.channels === undefined || record.channels.length === 0
    ? ''
    : ` It reached ${record.channels.map(channel => inline(channel, 40)).join(', ')}.`
  return [
    `**\`${inline(record.verb, 40)}\` already ran.** This delivery is the same command — the same comment, or the same workflow run — as the one this Action carried out ${when}, so nothing was sent again.${reached}`,
    '',
    'To ask for another one, post a new comment.',
  ].join('\n')
}
