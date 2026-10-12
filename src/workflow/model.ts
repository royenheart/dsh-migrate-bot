import { z } from 'zod'
import { E2E_FAILURE_POLICIES, REVIEW_POLICIES } from '../config/schema.ts'

/**
 * The data the migration workflow is made of: its input, the events the machine
 * consumes, and the entries of the event log. Every type here is a zod schema,
 * because the event log is read back from the state branch and validated before
 * it is replayed.
 */

export const releaseSchema = z.strictObject({
  tag: z.string().min(1),
  version: z.string().min(1),
})
export type Release = z.infer<typeof releaseSchema>

export const CHECKS = ['mechanical', 'boot', 'web', 'e2e'] as const
export type CheckName = (typeof CHECKS)[number]

export const checkResultSchema = z.strictObject({
  check: z.enum(CHECKS),
  outcome: z.enum(['pass', 'fail', 'skipped']),
  /** The normalised first failing line; compared across attempts. Empty unless the check failed. */
  fingerprint: z.string(),
  /** A bounded excerpt of the output, or why the check was skipped. */
  detail: z.string(),
})
export type CheckResult = z.infer<typeof checkResultSchema>

export const linkSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().min(1),
})

export const proposalSchema = z.strictObject({
  branch: z.string().min(1),
  /** The commit the proposal branch was pushed at. */
  headSha: z.string().min(1),
  issue: linkSchema,
  pullRequest: linkSchema,
})
export type Proposal = z.infer<typeof proposalSchema>

export const settingsSchema = z.strictObject({
  reviewPolicy: z.enum(REVIEW_POLICIES),
  maxAttempts: z.number().int().min(1),
  e2eFailurePolicy: z.enum(E2E_FAILURE_POLICIES),
  checks: z.strictObject({ boot: z.boolean(), web: z.boolean(), e2e: z.boolean() }),
  /** Whether a changed tree becomes a proposal on GitHub. */
  publish: z.boolean(),
  /** Report channels that are enabled, in delivery order. */
  reportChannels: z.array(z.string().min(1)),
})
export type Settings = z.infer<typeof settingsSchema>

export const migrationInputSchema = z.strictObject({
  target: releaseSchema,
  /** The release the plugin last worked on, and where that came from. */
  source: z.strictObject({
    release: releaseSchema,
    origin: z.enum(['verified', 'declared-peers']),
  }).optional(),
  /** The open proposal this migration supersedes when it publishes. */
  proposal: proposalSchema.optional(),
  settings: settingsSchema,
})
export type MigrationInput = z.infer<typeof migrationInputSchema>

export const STOP_REASONS = ['attempt-limit', 'repeated-failure', 'upstream-blocker', 'spend-cap', 'session-failed'] as const
export type StopReason = (typeof STOP_REASONS)[number]

const usageSchema = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheHitTokens: z.number().int().min(0),
  usd: z.number().min(0).optional(),
})
export type SessionUsage = z.infer<typeof usageSchema>

/** The result of every activity, and every event from outside the job. */
export const migrationEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('check.done'), result: checkResultSchema }),
  z.strictObject({
    type: z.literal('session.done'),
    kind: z.enum(['overlap', 'extension-points', 'repair']),
    outcome: z.enum(['completed', 'spend-cap', 'failed']),
    /** For a repair session: whether it declared an upstream blocker, and with all evidence fields. */
    blocker: z.enum(['none', 'incomplete', 'valid']),
    detail: z.string(),
    usage: usageSchema.optional(),
    /** The review report, relative to the migration directory on the state branch. */
    report: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('e2e.characterized'),
    outcome: z.enum(['characterized', 'skipped', 'failed']),
    /** The tests that passed on the source release. */
    baseline: z.array(z.string()),
    detail: z.string(),
    usage: usageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('e2e.published'),
    outcome: z.enum(['pushed', 'unchanged', 'failed']),
    detail: z.string(),
    usage: usageSchema.optional(),
  }),
  z.strictObject({ type: z.literal('tree.inspected'), changed: z.boolean(), files: z.number().int().min(0) }),
  z.strictObject({ type: z.literal('proposal.published'), proposal: proposalSchema }),
  z.strictObject({
    type: z.literal('report.done'),
    channel: z.string().min(1),
    outcome: z.enum(['delivered', 'held', 'skipped', 'failed']),
    detail: z.string(),
    url: z.string().optional(),
    usage: usageSchema.optional(),
  }),
  z.strictObject({ type: z.literal('activity.error'), activity: z.string().min(1), detail: z.string() }),
  z.strictObject({
    type: z.literal('pull-request.closed'),
    number: z.number().int().positive(),
    merged: z.boolean(),
    mergeSha: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('proposal.superseded'), by: z.string().min(1) }),
  z.strictObject({
    type: z.literal('command.report'),
    resend: z.boolean(),
    /** The comment that carried the command; a second delivery of it is ignored. */
    comment: z.string().min(1),
  }),
])
export type MigrationEvent = z.infer<typeof migrationEventSchema>

/** One line of `migrations/<version>/events.jsonl`. */
export const logEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('started'),
    at: z.iso.datetime(),
    /** The workflow run that started it, or `local`. */
    run: z.string().min(1),
    input: migrationInputSchema,
  }),
  z.strictObject({ kind: z.literal('event'), at: z.iso.datetime(), event: migrationEventSchema }),
])
export type LogEntry = z.infer<typeof logEntrySchema>
