import { replay, project, type MigrationView, type Projection } from '../../src/workflow/projection.ts'
import type { MigrationContext } from '../../src/workflow/machine.ts'
import type { LogEntry, MigrationEvent, MigrationInput, Proposal, Settings } from '../../src/workflow/model.ts'

/**
 * Real machine states for tests, built by replaying a log rather than by
 * writing a context by hand, so a test cannot describe a state the machine
 * never reaches.
 */

export const AT = '2026-10-10T00:00:00.000Z'

export function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    reviewPolicy: 'when-checks-fail',
    maxAttempts: 2,
    e2eFailurePolicy: 'advisory',
    e2ePublish: true,
    checks: { cards: false, boot: false, web: false, e2e: false },
    publish: true,
    reportChannels: [],
    ...overrides,
  }
}

export function input(version = '0.2.0', overrides: Partial<MigrationInput> = {}): MigrationInput {
  return { target: { tag: `dsh-v${version}`, version }, settings: settings(), ...overrides }
}

export function logOf(migrationInput: MigrationInput, events: readonly MigrationEvent[], run = 'test'): LogEntry[] {
  return [
    { kind: 'started', at: AT, run, input: migrationInput },
    ...events.map(event => ({ kind: 'event' as const, at: AT, event })),
  ]
}

export function proposal(number = 7): Proposal {
  return {
    branch: 'dsh-migrate/proposal',
    headSha: 'a'.repeat(40),
    issue: { number: number - 1, url: `https://github.com/acme/plugin/issues/${String(number - 1)}` },
    pullRequest: { number, url: `https://github.com/acme/plugin/pull/${String(number)}` },
  }
}

/** The events that take the default input to `awaitingMerge` with a proposal. */
export function proposedEvents(open: Proposal = proposal()): MigrationEvent[] {
  return [
    { type: 'check.done', result: { check: 'mechanical', outcome: 'fail', fingerprint: 'mechanical: TS2304', detail: 'error TS2304' } },
    { type: 'session.done', kind: 'overlap', outcome: 'completed', blocker: 'none', detail: '', report: 'reports/overlap.md' },
    { type: 'session.done', kind: 'extension-points', outcome: 'completed', blocker: 'none', detail: '', report: 'reports/extension-points.md' },
    { type: 'check.done', result: { check: 'mechanical', outcome: 'pass', fingerprint: '', detail: '' } },
    { type: 'tree.inspected', changed: true, files: 2 },
    { type: 'proposal.published', proposal: open },
  ]
}

export function contextOf(migrationInput: MigrationInput, events: readonly MigrationEvent[]): MigrationContext {
  const replayed = replay(logOf(migrationInput, events))
  if (replayed === undefined) throw new Error('no run')
  return replayed.snapshot.context
}

export function projectionOf(logs: Record<string, LogEntry[]>): Projection {
  return project(new Map(Object.entries(logs)))
}

export function viewOf(migrationInput: MigrationInput, events: readonly MigrationEvent[]): MigrationView {
  const view = projectionOf({ [migrationInput.target.version]: logOf(migrationInput, events) }).migrations[0]
  if (view === undefined) throw new Error('no view')
  return view
}
