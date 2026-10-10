import { transition } from 'xstate'
import { BADGE_FILE, logPath, migrationFile, serializeLog, type StateSnapshot, type StateStore } from '../state/store.ts'
import { badgeOf } from './badge.ts'
import { inline } from '../render/text.ts'
import { migrationMachine, type ActivityRequest, type MigrationContext } from './machine.ts'
import { project, replay, stateOf, type MigrationView, type Projection } from './projection.ts'
import type { LogEntry, MigrationEvent, MigrationInput } from './model.ts'

/**
 * The in-job engine: it executes the migration machine inside one GitHub
 * Actions job and keeps the event log on the state branch.
 *
 * It replays a migration's log to the current state, runs the activity that
 * state asks for, appends the result, and repeats until the machine reaches a
 * final state or waits for an event from outside the job. The log is pushed
 * after every activity with an external effect and when the engine stops, so a
 * cancelled job loses at most activities whose effects stayed inside it.
 */

export interface ActivityResult {
  event: MigrationEvent
  /** Files to keep on the state branch, relative to the migration directory. */
  files?: ReadonlyMap<string, string> | undefined
}

export type ActivityRunner = (request: ActivityRequest, context: MigrationContext) => Promise<ActivityResult>

/** Activities whose effect leaves the job; the log is pushed right after each. */
const EFFECTFUL = new Set<ActivityRequest['activity']>(['publishProposal', 'deliverReport'])

export class EngineError extends Error {
  override readonly name = 'EngineError'
}

export interface EngineOptions {
  store: StateStore
  activities: ActivityRunner
  /** The workflow run, recorded in each `started` entry. */
  run: string
  log: (message: string) => void
  now?: () => Date
}

export class InJobEngine {
  private state: StateSnapshot
  private readonly now: () => Date

  constructor(private readonly options: EngineOptions) {
    this.state = options.store.read()
    this.now = options.now ?? (() => new Date())
  }

  /** The projected consumer state, as of the last read or write. */
  status(): Projection {
    return project(this.state.logs)
  }

  /**
   * Start a new run of a migration, and advance it as far as it goes.
   * @param id - the migration id: the target version.
   * @param input - what the migration needs to know.
   * @param supersedes - the migration whose open proposal this one takes over.
   */
  async start(id: string, input: MigrationInput, supersedes?: string): Promise<MigrationView> {
    this.append(id, { kind: 'started', at: this.now().toISOString(), run: this.options.run, input })
    return await this.advance(id, supersedes)
  }

  /**
   * Deliver an event from outside the job to one migration.
   * @param id - the migration id.
   * @param event - an external event.
   */
  async deliver(id: string, event: MigrationEvent): Promise<MigrationView> {
    if (!this.state.logs.has(id)) throw new EngineError(`no migration ${id} on the state branch`)
    this.append(id, { kind: 'event', at: this.now().toISOString(), event })
    return await this.advance(id)
  }

  private append(id: string, entry: LogEntry): void {
    this.state.logs.set(id, [...(this.state.logs.get(id) ?? []), entry])
  }

  private async advance(id: string, supersedes?: string): Promise<MigrationView> {
    const replayed = replay(this.state.logs.get(id) ?? [])
    if (replayed === undefined) throw new EngineError(`migration ${id} has no started entry`)
    let { snapshot, pending } = replayed
    const touched = new Set([id])
    let files = new Map<string, string>()
    while (snapshot.status === 'active') {
      const request = pending[0]
      if (request === undefined) break
      this.options.log(`${id}: ${stateOf(snapshot)} → ${describe(request)}`)
      const result = await this.execute(request, snapshot.context)
      if (result.event.type === 'activity.error') this.options.log(`${id}: ${request.activity} failed: ${inline(result.event.detail, 600)}`)
      this.append(id, { kind: 'event', at: this.now().toISOString(), event: result.event })
      for (const [name, content] of result.files ?? []) files.set(migrationFile(id, name), content)
      const [next, actions] = transition(migrationMachine, snapshot, result.event)
      snapshot = next
      pending = actions.filter(action => action.type === 'run').map(action => action.params as ActivityRequest)
      if (result.event.type === 'proposal.published' && supersedes !== undefined) {
        this.append(supersedes, { kind: 'event', at: this.now().toISOString(), event: { type: 'proposal.superseded', by: id } })
        touched.add(supersedes)
      }
      if (EFFECTFUL.has(request.activity)) {
        this.persist(touched, files, `dsh-migrate: ${id} ${request.activity}`)
        files = new Map()
      }
    }
    this.persist(touched, files, `dsh-migrate: ${id} ${stateOf(snapshot)}`)
    this.options.log(`${id}: ${stateOf(snapshot)}`)
    const view = this.status().migrations.find(migration => migration.id === id)
    if (view === undefined) throw new EngineError(`migration ${id} vanished from the projection`)
    return view
  }

  private async execute(request: ActivityRequest, context: MigrationContext): Promise<ActivityResult> {
    try {
      return await this.options.activities(request, context)
    } catch (error) {
      return {
        event: { type: 'activity.error', activity: request.activity, detail: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  /** Push the touched logs, the files collected, and the badge. */
  private persist(touched: ReadonlySet<string>, files: ReadonlyMap<string, string>, message: string): void {
    const changes = new Map(files)
    for (const id of touched) changes.set(logPath(id), serializeLog(this.state.logs.get(id) ?? []))
    changes.set(BADGE_FILE, `${JSON.stringify(badgeOf(this.status()), null, 2)}\n`)
    const written = this.options.store.write(this.state.tip, changes, message)
    if (!written.ok) throw new EngineError(`could not write the state branch: ${written.reason}: ${written.detail}`)
    if (written.commit !== 'unchanged') this.state.tip = written.commit
  }
}

function describe(request: ActivityRequest): string {
  switch (request.activity) {
    case 'check':
      return `${request.check} check${request.release === 'source' ? ' (source release)' : ''}`
    case 'session':
      return request.kind === 'repair' ? `repair attempt ${String(request.attempt)}` : `${request.kind} review`
    case 'deliverReport':
      return `merge report to ${request.channel}`
    default:
      return request.activity
  }
}
