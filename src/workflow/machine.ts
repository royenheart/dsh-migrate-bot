import { assign, setup } from 'xstate'
import type {
  CheckName,
  CheckResult,
  MigrationEvent,
  MigrationInput,
  Proposal,
  Settings,
  StopReason,
} from './model.ts'

/**
 * The migration workflow, as a statechart.
 *
 * This machine is the specification: every state, every event it accepts, and
 * every activity it asks for is declared here and nowhere else. It performs no
 * I/O. A state that needs work done declares one `run` entry action whose
 * parameters name the activity; the engine executes it and sends the result
 * back as an event. `docs/reference/workflow.md` is generated from this file.
 */

/** Which tree the checks look at, and therefore which checks run. */
export type Scope = 'initial' | 'attempt' | 'final'

export type ActivityRequest =
  | { activity: 'check'; check: CheckName; release: 'source' | 'target'; e2eScope: 'subset' | 'full' }
  | { activity: 'session'; kind: 'overlap' | 'extension-points' | 'repair'; attempt: number }
  | { activity: 'authorE2E' }
  | { activity: 'inspectTree' }
  | { activity: 'publishProposal' }
  | { activity: 'deliverReport'; channel: string }

export interface MigrationContext {
  input: MigrationInput
  scope: Scope
  /** Checks still to run in the current pass, in order. */
  queue: CheckName[]
  reviewed: boolean
  attempts: number
  lastFingerprint: string | undefined
  /** The check that failed last. */
  failure: CheckResult | undefined
  /** Boot checks of the unmodified tree, on the source and on the target release. */
  sourceBoot: CheckResult | undefined
  targetBoot: CheckResult | undefined
  stoppedBy: StopReason | undefined
  warnings: string[]
  proposal: Proposal | undefined
  /** Report channels that already took this migration's report. */
  delivered: string[]
  /** Report channels left in the current reporting pass. */
  pending: string[]
  /** Whether the proposal was merged. */
  merged: boolean
  /** Comments whose `report` command was already handled. */
  comments: string[]
}

/**
 * The checks one pass runs, in order.
 *
 * `initial` looks at the unmodified tree; when the pre-migration boot check on
 * the target already passed, boot is not run again. `attempt` runs after a review or a repair. `final`
 * re-runs the whole end-to-end suite when the attempt ran only a subset.
 */
export function checksFor(scope: Scope, settings: Settings, bootPassed: boolean): CheckName[] {
  const enabled = (check: CheckName): boolean => check === 'mechanical' || settings.checks[check]
  const order: Record<Scope, CheckName[]> = {
    initial: ['mechanical', ...(bootPassed ? [] : ['boot'] as CheckName[]), 'web', 'e2e'],
    attempt: ['mechanical', 'boot', 'web', 'e2e'],
    final: settings.e2eSubsetFirst ? ['e2e'] : [],
  }
  return order[scope].filter(enabled)
}

function e2eScopeOf(scope: Scope, settings: Settings): 'subset' | 'full' {
  return scope === 'attempt' && settings.e2eSubsetFirst ? 'subset' : 'full'
}

type Guard = (args: { context: MigrationContext; event: MigrationEvent }) => boolean

/** What each guard means; `docs/reference/workflow.md` prints this table. */
export const GUARD_DESCRIPTIONS = {
  bootEnabled: 'The boot check is enabled.',
  hasSource: 'A source release is known and the boot check is enabled.',
  initialPassPossible: 'The review policy is `when-checks-fail` and the unmodified tree did not fail the boot check on the target release.',
  queueEmpty: 'Every check of the current pass has run.',
  checkFailed: 'The check failed.',
  spendCap: 'The session was not run, or was stopped, because the spend cap was reached.',
  sessionFailed: 'The session crashed or exceeded its watchdog.',
  blockerValid: 'The repair report declared an upstream blocker with every evidence field.',
  scopeIs: 'The current pass has the given scope.',
  notReviewed: 'The overlap and extension-point reviews have not run.',
  canRepair: 'Repair attempts are left, and the failure fingerprint differs from the one the last repair attempt was given.',
  advisoryE2EFailure: 'The failing check is the end-to-end check and its failure policy is `advisory`.',
  e2eEnabled: 'The end-to-end check is enabled.',
  changedAndPublish: 'The tree changed and publishing is on.',
  changed: 'The tree changed.',
  proposalMerged: 'The closed pull request is this proposal, and it was merged.',
  proposalClosed: 'The closed pull request is this proposal.',
  pendingEmpty: 'Every channel of the reporting pass has been tried.',
  pendingEmptyAndMerged: 'Every channel of the reporting pass has been tried, and the proposal was merged.',
  newComment: 'The `report` command comes from a comment not handled before.',
} as const

const checkFailed: Guard = ({ event }) => event.type === 'check.done' && event.result.outcome === 'fail'
const sessionOutcome = (outcome: 'spend-cap' | 'failed'): Guard =>
  ({ event }) => event.type === 'session.done' && event.outcome === outcome

export const migrationMachine = setup({
  types: {
    context: {} as MigrationContext,
    events: {} as MigrationEvent,
    input: {} as MigrationInput,
  },
  actions: {
    /** Ask the engine for one activity. The body is empty: the engine reads the parameters. */
    run: (_, _params: ActivityRequest) => {},
    acceptReportCommand: assign({
      comments: ({ context, event }) => event.type === 'command.report' ? [...context.comments, event.comment] : context.comments,
      delivered: ({ context, event }) => event.type === 'command.report' && event.resend ? [] : context.delivered,
    }),
  },
  guards: {
    bootEnabled: ({ context }) => context.input.settings.checks.boot,
    hasSource: ({ context }) => context.input.source !== undefined && context.input.settings.checks.boot,
    initialPassPossible: ({ context }) => context.input.settings.reviewPolicy === 'when-checks-fail'
      && context.targetBoot?.outcome !== 'fail',
    queueEmpty: ({ context }) => context.queue.length === 0,
    checkFailed,
    spendCap: sessionOutcome('spend-cap'),
    sessionFailed: sessionOutcome('failed'),
    blockerValid: ({ event }) => event.type === 'session.done' && event.blocker === 'valid',
    scopeIs: ({ context }, params: { scope: Scope }) => context.scope === params.scope,
    notReviewed: ({ context }) => !context.reviewed,
    canRepair: ({ context }) => context.attempts < context.input.settings.maxAttempts
      && context.failure?.fingerprint !== context.lastFingerprint,
    advisoryE2EFailure: ({ context }) => context.failure?.check === 'e2e'
      && context.input.settings.e2eFailurePolicy === 'advisory',
    e2eEnabled: ({ context }) => context.input.settings.checks.e2e,
    changedAndPublish: ({ context, event }) => event.type === 'tree.inspected' && event.changed
      && context.input.settings.publish,
    changed: ({ event }) => event.type === 'tree.inspected' && event.changed,
    proposalMerged: ({ context, event }) => event.type === 'pull-request.closed' && event.merged
      && event.number === context.proposal?.pullRequest.number,
    proposalClosed: ({ context, event }) => event.type === 'pull-request.closed'
      && event.number === context.proposal?.pullRequest.number,
    pendingEmpty: ({ context }) => context.pending.length === 0,
    pendingEmptyAndMerged: ({ context }) => context.pending.length === 0 && context.merged,
    newComment: ({ context, event }) => event.type === 'command.report' && !context.comments.includes(event.comment),
  },
}).createMachine({
  id: 'migration',
  context: ({ input }) => ({
    input,
    scope: 'initial',
    queue: [],
    reviewed: false,
    attempts: 0,
    lastFingerprint: undefined,
    failure: undefined,
    sourceBoot: undefined,
    targetBoot: undefined,
    stoppedBy: undefined,
    warnings: [],
    proposal: undefined,
    delivered: [],
    pending: [],
    merged: false,
    comments: [],
  }),
  initial: 'start',
  on: {
    'activity.error': { target: '.error' },
  },
  states: {
    start: {
      always: [
        { guard: 'hasSource', target: 'sourceBoot' },
        { guard: 'bootEnabled', target: 'targetBoot' },
        { target: 'afterBaseline' },
      ],
    },
    sourceBoot: {
      description: 'Boot the unmodified tree on the source release, to classify the outcome.',
      entry: { type: 'run', params: { activity: 'check', check: 'boot', release: 'source', e2eScope: 'full' } },
      on: {
        'check.done': {
          target: 'targetBoot',
          actions: assign({ sourceBoot: ({ event }) => event.result }),
        },
      },
    },
    targetBoot: {
      description: 'Boot the unmodified tree on the target release.',
      entry: { type: 'run', params: { activity: 'check', check: 'boot', release: 'target', e2eScope: 'full' } },
      on: {
        'check.done': {
          target: 'afterBaseline',
          actions: assign({ targetBoot: ({ event }) => event.result }),
        },
      },
    },
    afterBaseline: {
      always: [
        { guard: 'initialPassPossible', target: 'checking', actions: assign({ scope: 'initial' }) },
        { target: 'reviewing' },
      ],
    },
    reviewing: {
      description: 'The overlap review and the extension-point review, once per migration.',
      initial: 'overlap',
      states: {
        overlap: {
          description: 'The overlap review session.',
          entry: { type: 'run', params: { activity: 'session', kind: 'overlap', attempt: 0 } },
          on: {
            'session.done': [
              { guard: 'spendCap', target: '#migration.failed', actions: assign({ stoppedBy: 'spend-cap' }) },
              { guard: 'sessionFailed', target: '#migration.failed', actions: assign({ stoppedBy: 'session-failed' }) },
              { target: 'extensionPoints' },
            ],
          },
        },
        extensionPoints: {
          description: 'The extension-point review session.',
          entry: { type: 'run', params: { activity: 'session', kind: 'extension-points', attempt: 0 } },
          on: {
            'session.done': [
              { guard: 'spendCap', target: '#migration.failed', actions: assign({ stoppedBy: 'spend-cap' }) },
              { guard: 'sessionFailed', target: '#migration.failed', actions: assign({ stoppedBy: 'session-failed' }) },
              { target: '#migration.checking', actions: assign({ reviewed: true, scope: 'attempt' }) },
            ],
          },
        },
      },
    },
    checking: {
      description: 'One pass of checks; which checks run depends on the scope of the pass.',
      entry: assign({
        queue: ({ context }) => checksFor(context.scope, context.input.settings, context.targetBoot?.outcome === 'pass'),
      }),
      initial: 'next',
      states: {
        next: {
          always: [
            { guard: 'queueEmpty', target: '#migration.checksPassed' },
            { target: 'running' },
          ],
        },
        running: {
          description: 'Run the next check of the current pass.',
          entry: {
            type: 'run',
            params: ({ context }) => ({
              activity: 'check',
              check: context.queue[0] as CheckName,
              release: 'target',
              e2eScope: e2eScopeOf(context.scope, context.input.settings),
            }),
          },
          on: {
            'check.done': [
              {
                guard: 'checkFailed',
                target: '#migration.evaluating',
                actions: assign({ failure: ({ event }) => event.result }),
              },
              { target: 'next', actions: assign({ queue: ({ context }) => context.queue.slice(1) }) },
            ],
          },
        },
      },
    },
    checksPassed: {
      always: [
        { guard: { type: 'scopeIs', params: { scope: 'initial' } }, target: 'concluding' },
        {
          guard: { type: 'scopeIs', params: { scope: 'attempt' } },
          target: 'checking',
          actions: assign({ scope: 'final' }),
        },
        { guard: 'e2eEnabled', target: 'authoringE2E' },
        { target: 'concluding' },
      ],
    },
    evaluating: {
      always: [
        { guard: 'notReviewed', target: 'reviewing' },
        { guard: 'canRepair', target: 'repairing' },
        {
          guard: 'advisoryE2EFailure',
          target: 'authoringE2E',
          actions: assign({
            warnings: ({ context }) => [...context.warnings, `end-to-end check failed (advisory): ${context.failure?.fingerprint ?? ''}`],
          }),
        },
        {
          target: 'failed',
          actions: assign({
            stoppedBy: ({ context }) => context.attempts >= context.input.settings.maxAttempts ? 'attempt-limit' : 'repeated-failure',
          }),
        },
      ],
    },
    repairing: {
      description: 'Repair attempt n: one agent session given the reviews and the failing check.',
      entry: [
        assign({
          attempts: ({ context }) => context.attempts + 1,
          lastFingerprint: ({ context }) => context.failure?.fingerprint,
        }),
        { type: 'run', params: ({ context }) => ({ activity: 'session', kind: 'repair', attempt: context.attempts }) },
      ],
      on: {
        'session.done': [
          { guard: 'spendCap', target: 'failed', actions: assign({ stoppedBy: 'spend-cap' }) },
          { guard: 'sessionFailed', target: 'failed', actions: assign({ stoppedBy: 'session-failed' }) },
          { guard: 'blockerValid', target: 'failed', actions: assign({ stoppedBy: 'upstream-blocker' }) },
          { target: 'checking', actions: assign({ scope: 'attempt' }) },
        ],
      },
    },
    authoringE2E: {
      description: 'An agent session writes or extends the end-to-end suite on its own branch. It never blocks.',
      entry: { type: 'run', params: { activity: 'authorE2E' } },
      on: {
        'e2e.authored': {
          target: 'concluding',
          actions: assign({
            warnings: ({ context, event }) => event.outcome === 'failed'
              ? [...context.warnings, `end-to-end suite not updated: ${event.detail}`]
              : context.warnings,
          }),
        },
      },
    },
    concluding: {
      description: 'Decide between a proposal and a compatible result from the state of the tree.',
      entry: { type: 'run', params: { activity: 'inspectTree' } },
      on: {
        'tree.inspected': [
          { guard: 'changedAndPublish', target: 'publishing' },
          { guard: 'changed', target: 'unpublished' },
          { target: 'compatible' },
        ],
      },
    },
    publishing: {
      description: 'Push the proposal branch and open or update the issue and the pull request.',
      entry: { type: 'run', params: { activity: 'publishProposal' } },
      on: {
        'proposal.published': {
          target: 'awaitingMerge',
          actions: assign({ proposal: ({ event }) => event.proposal }),
        },
      },
    },
    awaitingMerge: {
      description: 'Wait for the maintainer to merge or close the proposal.',
      on: {
        'pull-request.closed': [
          { guard: 'proposalMerged', target: 'reporting', actions: assign({ merged: true }) },
          { guard: 'proposalClosed', target: 'rejected' },
        ],
        'proposal.superseded': { target: 'superseded' },
        'command.report': { guard: 'newComment', target: 'reporting', actions: 'acceptReportCommand' },
      },
    },
    accepted: {
      description: 'The proposal was merged and reported; a `report` command can report it again.',
      on: {
        'command.report': { guard: 'newComment', target: 'reporting', actions: 'acceptReportCommand' },
      },
    },
    reporting: {
      description: 'Send the merge report to every enabled channel that has not taken it yet.',
      entry: assign({
        pending: ({ context }) => context.input.settings.reportChannels
          .filter(channel => !context.delivered.includes(channel)),
      }),
      initial: 'next',
      states: {
        next: {
          always: [
            { guard: 'pendingEmptyAndMerged', target: '#migration.accepted' },
            { guard: 'pendingEmpty', target: '#migration.awaitingMerge' },
            { target: 'running' },
          ],
        },
        running: {
          description: 'Send the merge report to the next channel.',
          entry: {
            type: 'run',
            params: ({ context }) => ({ activity: 'deliverReport', channel: context.pending[0] as string }),
          },
          on: {
            'report.done': {
              target: 'next',
              actions: assign({
                pending: ({ context }) => context.pending.slice(1),
                delivered: ({ context, event }) => event.outcome === 'delivered'
                  ? [...context.delivered, event.channel]
                  : context.delivered,
              }),
            },
          },
        },
      },
    },
    compatible: { type: 'final', description: 'The unmodified tree passes every check on the target release.' },
    unpublished: { type: 'final', description: 'The tree changed and passed, and publishing is turned off.' },
    failed: { type: 'final', description: 'The checks still fail; the migration stopped.' },
    error: { type: 'final', description: 'An activity failed for a reason outside the plugin.' },
    rejected: { type: 'final', description: 'The proposal was closed without merging.' },
    superseded: { type: 'final', description: 'A later migration took over the proposal.' },
  },
})

