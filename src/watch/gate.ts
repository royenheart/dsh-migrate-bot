import type { ResolvedVersion } from './dsh-version.ts'
import type { PendingMigration, SeenState } from './seen.ts'
import { inline } from '../render/text.ts'

export type WatchRunReason = 'first-run' | 'updated' | 'forced' | 'watch-disabled' | 'mechanical-only'
export type WatchSkipReason = 'unchanged'

export type WatchDecision =
  | { action: 'run'; reason: WatchRunReason }
  | { action: 'skip'; reason: WatchSkipReason; previous: SeenState }

/**
 * Decide whether this Action invocation should run the migrate pipeline.
 * First run (no saved dsh version) always proceeds. Later runs proceed only
 * when the resolved target differs, unless the caller forces a run.
 */
export function decideWatch(input: {
  watchEnabled: boolean
  force: boolean
  mechanicalOnly: boolean
  current: ResolvedVersion
  previous: SeenState | undefined
}): WatchDecision {
  if (input.mechanicalOnly) return { action: 'run', reason: 'mechanical-only' }
  if (input.force) return { action: 'run', reason: 'forced' }
  if (!input.watchEnabled) return { action: 'run', reason: 'watch-disabled' }
  if (input.previous === undefined) return { action: 'run', reason: 'first-run' }
  if (input.previous.version !== input.current.version) return { action: 'run', reason: 'updated' }
  return { action: 'skip', reason: 'unchanged', previous: input.previous }
}

/**
 * What this run decided, as the line the log carries.
 *
 * The tag comes from the state branch or from the resolver, and this line is
 * written to stdout where the runner parses workflow commands: every branch
 * collapses it, not only the one an unchanged version takes.
 */
export function describeWatchDecision(decision: WatchDecision, current: ResolvedVersion): string {
  const tag = inline(current.tag, 80)
  if (decision.action === 'skip') {
    // A tag is the state branch's when the run read it from there: one line of
    // it, because this message is written to stdout where the runner parses
    // workflow commands.
    return `dsh unchanged (${inline(decision.previous.tag, 80)} == ${tag}), skip`
  }
  switch (decision.reason) {
    case 'first-run':
      return `first run: no prior dsh state, processing ${tag}`
    case 'updated':
      return `dsh updated, processing ${tag}`
    case 'forced':
      return `forced run, processing ${tag}`
    case 'watch-disabled':
      return `watch disabled, processing ${tag}`
    case 'mechanical-only':
      return `mechanical-only, skipping dsh update gate`
  }
}

export type OpenPullRequestDecision =
  | { action: 'proceed'; note?: string }
  | { action: 'skip'; pending: PendingMigration; reason: string }

/**
 * Whether the migrate pull request this repository already has blocks this run.
 *
 * A run publishes onto a branch named for the version *and* the moment, so a
 * second run while the first pull request is open opens a second, overlapping
 * pull request built from the same unmigrated base: two reviews of one
 * migration, and the whole migration spent twice. The recorded state holds one
 * pending row, so the second run also overwrites the first pull request's row,
 * and merging the first would then promote a tag that nothing verified.
 *
 * The override is its own input (`allow_second_pull_request`) rather than the
 * `force` that means "ignore an unchanged dsh version": a user re-running a
 * version on purpose has not thereby asked for a second pull request, and it
 * says what it costs rather than passing silently. A mechanical-only run
 * publishes nothing, so it is never blocked.
 * @param input - the recorded state, and the two flags that change the answer.
 */
export function decideOpenPullRequest(input: {
  previous: SeenState | undefined
  allowSecond: boolean
  mechanicalOnly: boolean
}): OpenPullRequestDecision {
  const pending = input.previous?.pending
  if (pending === undefined || input.mechanicalOnly) return { action: 'proceed' }
  if (input.allowSecond) {
    return {
      action: 'proceed',
      note: `migrate pull request #${String(pending.pr)} is still open; --allow-second-pr runs anyway and will open a second one`,
    }
  }
  return {
    action: 'skip',
    pending,
    reason: `migrate pull request #${String(pending.pr)} is open, and this run would open a second one`,
  }
}
