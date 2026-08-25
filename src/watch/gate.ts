import type { ResolvedVersion } from './dsh-version.ts'
import type { SeenState } from './seen.ts'

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

export function describeWatchDecision(decision: WatchDecision, current: ResolvedVersion): string {
  if (decision.action === 'skip') {
    return `dsh unchanged (${decision.previous.tag} == ${current.tag}), skip`
  }
  switch (decision.reason) {
    case 'first-run':
      return `first run: no prior dsh state, processing ${current.tag}`
    case 'updated':
      return `dsh updated, processing ${current.tag}`
    case 'forced':
      return `forced run, processing ${current.tag}`
    case 'watch-disabled':
      return `watch disabled, processing ${current.tag}`
    case 'mechanical-only':
      return `mechanical-only, skipping dsh update gate`
  }
}
