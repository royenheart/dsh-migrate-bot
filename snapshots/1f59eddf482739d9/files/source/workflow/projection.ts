import { initialTransition, transition, type SnapshotFrom } from 'xstate'
import { compareReleases } from '../domain/release.ts'
import { migrationMachine, type ActivityRequest, type MigrationContext } from './machine.ts'
import type { LogEntry, Release } from './model.ts'

/**
 * The consumer's state, derived from the event logs on the state branch.
 *
 * Nothing here is stored: the processed release, the verified release and the
 * open proposal are recomputed from the logs on every read, so they cannot
 * disagree with them.
 */

export type MigrationSnapshot = SnapshotFrom<typeof migrationMachine>

export interface Replay {
  snapshot: MigrationSnapshot
  /** The activity the current state asked for and the log holds no result of. */
  pending: ActivityRequest[]
  run: string
  startedAt: string
}

/**
 * Replay the latest run of one migration's log through the machine.
 *
 * A log holds every run of a migration, each beginning with a `started` entry;
 * a forced re-run starts a new one. Only the latest run counts.
 * @param entries - the log, oldest first.
 */
export function replay(entries: readonly LogEntry[]): Replay | undefined {
  const start = entries.findLastIndex(entry => entry.kind === 'started')
  const started = entries[start]
  if (started === undefined || started.kind !== 'started') return undefined
  const runs = (actions: readonly { type: string; params?: unknown }[]): ActivityRequest[] =>
    actions.filter(action => action.type === 'run').map(action => action.params as ActivityRequest)
  let [snapshot, actions] = initialTransition(migrationMachine, started.input)
  let pending = runs(actions)
  for (const entry of entries.slice(start + 1)) {
    if (entry.kind !== 'event') continue
    const [next, emitted] = transition(migrationMachine, snapshot, entry.event)
    // An event the current state ignores leaves the snapshot as it was, and the
    // activity that state asked for is still outstanding.
    if (next !== snapshot) pending = runs(emitted)
    snapshot = next
  }
  return { snapshot, pending, run: started.run, startedAt: started.at }
}

/** The top-level state a snapshot is in. */
export function stateOf(snapshot: MigrationSnapshot): string {
  return typeof snapshot.value === 'string' ? snapshot.value : Object.keys(snapshot.value)[0] ?? ''
}


export interface MigrationView {
  /** The migration id, which is the target version. */
  id: string
  target: Release
  state: string
  context: MigrationContext
  run: string
  startedAt: string
}

export interface Projection {
  /** Newest first. */
  migrations: MigrationView[]
  /** The newest release a migration finished for, successful or not. An `error` does not count. */
  processed?: MigrationView
  /** The newest release proven on the default branch: a compatible migration or a merged proposal. */
  verified?: Release
  /** The migration whose proposal is open. */
  open?: MigrationView
}

/**
 * Project every migration log.
 * @param logs - migration id to its log.
 */
export function project(logs: ReadonlyMap<string, readonly LogEntry[]>): Projection {
  const migrations: MigrationView[] = []
  for (const [id, entries] of logs) {
    const replayed = replay(entries)
    if (replayed === undefined) continue
    migrations.push({
      id,
      target: replayed.snapshot.context.input.target,
      state: stateOf(replayed.snapshot),
      context: replayed.snapshot.context,
      run: replayed.run,
      startedAt: replayed.startedAt,
    })
  }
  migrations.sort((left, right) => compareReleases(right.target, left.target))
  const processed = migrations.find(view => view.state !== 'error')
  const verified = migrations.find(view => view.state === 'compatible' || view.context.merged)?.target
  const open = migrations.find(view => view.state === 'awaitingMerge' || (view.state === 'reporting' && !view.context.merged))
  return {
    migrations,
    ...(processed === undefined ? {} : { processed }),
    ...(verified === undefined ? {} : { verified }),
    ...(open === undefined ? {} : { open }),
  }
}
