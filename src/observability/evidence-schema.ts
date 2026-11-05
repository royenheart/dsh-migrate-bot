import { z } from 'zod'

/**
 * The transport shape of one run evidence bundle.
 *
 * The state-branch reader produces `InspectData`; the deploy service validates
 * that payload before storing it. This schema is the one contract both sides
 * use, so a field added to the producer has one place to change on the service.
 */
export const manifestSchema = z.object({
  runId: z.string().min(1),
  migrationId: z.string().min(1),
  startedAt: z.string().min(1),
  workflow: z.object({
    graph: z.string().min(1).optional(),
    nodes: z.array(z.string().min(1)).optional(),
    edges: z.array(z.string().min(1)).optional(),
    state: z.string().min(1).optional(),
  }).passthrough(),
  target: z.object({ tag: z.string().optional(), version: z.string().optional() }).passthrough(),
  evaluation: z.object({ record: z.string().optional(), harborJob: z.string().optional(), trialId: z.string().optional() }).passthrough().optional(),
  totals: z.object({
    sessions: z.number().int().min(0).optional(),
    turns: z.number().int().min(0).optional(),
    steps: z.number().int().min(0).optional(),
    toolCalls: z.number().int().min(0).optional(),
    elapsedSeconds: z.number().int().min(0).optional(),
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cacheHitTokens: z.number().int().min(0).optional(),
    usd: z.number().min(0).optional(),
  }).passthrough().optional(),
  sessions: z.array(z.object({ name: z.string() }).passthrough()),
}).passthrough()

export const inspectDataSchema = z.object({
  migrationId: z.string().min(1).max(200),
  runs: z.array(z.object({
    runId: z.string().min(1),
    manifest: manifestSchema,
    prompts: z.record(z.string(), z.string()),
  })).min(1).max(500),
  history: z.array(z.object({ runId: z.string().min(1), startedAt: z.string().min(1) })).max(500).optional(),
  warnings: z.array(z.string()).max(2000).optional(),
})
