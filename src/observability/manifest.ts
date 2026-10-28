import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PACKAGE_ROOT, PACKAGE_VERSION } from '../paths.ts'
import { workflowDiagram } from '../workflow/graph.ts'
import type { AgentConfig } from '../config/schema.ts'
import type { ManifestCheck, SessionRecord } from './session.ts'

/**
 * The immutable record of one Action run: which workflow, prompts, skill,
 * runtime, model and target it used, what it spent, and where its trace lives.
 *
 * The manifest is small enough for the state branch. Prompt text and
 * observations stay in the run directory; Langfuse receives the trace.
 */

const modelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  thinking: z.string(),
  reasoningEffort: z.string(),
})

const usageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheHitTokens: z.number().int().min(0),
  usd: z.number().min(0).optional(),
})

const sessionSchema = z.object({
  kind: z.string(),
  name: z.string(),
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  promptPath: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  outcome: z.enum(['completed', 'failed', 'spend-cap']),
  usage: usageSchema.optional(),
  progress: z.object({
    turns: z.number().int().min(0),
    steps: z.number().int().min(0),
    elapsedSeconds: z.number().int().min(0),
  }).optional(),
  toolCalls: z.number().int().min(0),
})

export const runManifestSchema = z.object({
  schema: z.literal(1),
  runId: z.string().min(1),
  runUrl: z.string().optional(),
  migrationId: z.string().min(1),
  actionVersion: z.string().min(1),
  workflow: z.object({
    id: z.literal('migrate'),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    adapter: z.literal('local'),
    graph: z.string().optional(),
  }),
  plugin: z.array(z.string().min(1)).min(1),
  source: z.object({ tag: z.string(), version: z.string() }).optional(),
  target: z.object({ tag: z.string(), version: z.string() }),
  agent: z.object({
    runtime: z.string().min(1),
    skill: z.string().min(1),
    model: modelSchema,
  }),
  prompts: z.record(z.string(), z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    path: z.string().min(1),
  })),
  sessions: z.array(sessionSchema),
  checks: z.array(z.object({
    check: z.string().min(1),
    outcome: z.enum(['pass', 'fail', 'skipped']),
  })),
  totals: z.object({
    sessions: z.number().int().min(0),
    turns: z.number().int().min(0),
    steps: z.number().int().min(0),
    toolCalls: z.number().int().min(0),
    elapsedSeconds: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheHitTokens: z.number().int().min(0),
    usd: z.number().min(0).optional(),
  }),
  outcome: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  trace: z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    exported: z.boolean(),
  }).optional(),
})

export type RunManifest = z.infer<typeof runManifestSchema>

export interface ManifestInput {
  runId: string
  runUrl?: string | undefined
  migrationId: string
  plugin: string[]
  source?: { tag: string; version: string } | undefined
  target: { tag: string; version: string }
  agent: AgentConfig
  sessions: SessionRecord[]
  checks: ManifestCheck[]
  outcome: string
  startedAt: string
  endedAt: string
  traceId?: string | undefined
  traceExported?: boolean | undefined
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The workflow's identity: the statechart and the model it consumes. */
export function workflowHash(): string {
  const hash = createHash('sha256')
  for (const path of ['src/workflow/machine.ts', 'src/workflow/model.ts']) {
    try {
      hash.update(readFileSync(join(PACKAGE_ROOT, path)))
    } catch {
      hash.update(`missing:${path}`)
    }
  }
  return hash.digest('hex')
}

/** The dsh version the image pins, or the env override a local checkout can set. */
export function agentRuntime(): string {
  const override = process.env.DSH_MIGRATE_AGENT_RUNTIME
  if (override !== undefined && override !== '') return override
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'container', 'agent-runtime', 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const dependencies = (parsed as { dependencies?: unknown }).dependencies
      if (typeof dependencies === 'object' && dependencies !== null) {
        const dsh = (dependencies as { '@deepseek-ai/dsh'?: unknown })['@deepseek-ai/dsh']
        if (typeof dsh === 'string' && dsh !== '') return dsh
      }
    }
  } catch {
    // A local run without the image falls back to an explicit marker.
  }
  return 'unknown'
}

/** The skill pin the image carries; `DSH_MIGRATE_SKILL_COMMIT` is set by the Dockerfile. */
export function skillCommit(): string {
  const value = process.env.DSH_MIGRATE_SKILL_COMMIT
  return value === undefined || value === '' ? 'unknown' : value
}

export function buildRunManifest(input: ManifestInput): RunManifest {
  const sessions = input.sessions.map(session => ({
    kind: session.kind,
    name: session.name,
    promptSha256: session.promptSha256,
    promptPath: `prompts/${session.promptSha256}.md`,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    outcome: session.outcome,
    ...(session.usage === undefined ? {} : { usage: session.usage }),
    ...(session.progress === undefined ? {} : { progress: session.progress }),
    toolCalls: session.toolCalls,
  }))
  const usage = input.sessions.flatMap(session => session.usage === undefined ? [] : [session.usage])
  const usd = usage.flatMap(entry => entry.usd === undefined ? [] : [entry.usd])
  const prompts = Object.fromEntries(input.sessions.map(session => [
    session.name,
    { sha256: session.promptSha256, path: `prompts/${session.promptSha256}.md` },
  ]))
  return runManifestSchema.parse({
    schema: 1,
    runId: input.runId,
    ...(input.runUrl === undefined ? {} : { runUrl: input.runUrl }),
    migrationId: input.migrationId,
    actionVersion: PACKAGE_VERSION ?? 'unknown',
    workflow: { id: 'migrate', hash: workflowHash(), adapter: 'local', graph: workflowDiagram() },
    plugin: input.plugin,
    ...(input.source === undefined ? {} : { source: input.source }),
    target: input.target,
    agent: {
      runtime: agentRuntime(),
      skill: skillCommit(),
      model: {
        provider: input.agent.provider,
        model: input.agent.model,
        thinking: input.agent.thinking,
        reasoningEffort: input.agent.reasoningEffort,
      },
    },
    prompts,
    sessions,
    checks: input.checks,
    totals: {
      sessions: sessions.length,
      turns: input.sessions.reduce((sum, session) => sum + (session.progress?.turns ?? 0), 0),
      steps: input.sessions.reduce((sum, session) => sum + (session.progress?.steps ?? 0), 0),
      toolCalls: input.sessions.reduce((sum, session) => sum + session.toolCalls, 0),
      elapsedSeconds: input.sessions.reduce((sum, session) => sum + (session.progress?.elapsedSeconds ?? 0), 0),
      inputTokens: usage.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: usage.reduce((sum, entry) => sum + entry.outputTokens, 0),
      cacheHitTokens: usage.reduce((sum, entry) => sum + entry.cacheHitTokens, 0),
      ...(usd.length === 0 ? {} : { usd: usd.reduce((sum, value) => sum + value, 0) }),
    },
    outcome: input.outcome,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    ...(input.traceId === undefined ? {} : { trace: { id: input.traceId, exported: input.traceExported === true } }),
  })
}

export function manifestPath(migrationId: string, runId: string): string {
  return `migrations/${migrationId}/runs/${runId}/manifest.json`
}

export function serializeManifest(manifest: RunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
