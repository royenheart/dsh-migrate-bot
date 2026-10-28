import { createHash } from 'node:crypto'
import type { RunManifest } from './manifest.ts'
import type { SessionObservation, SessionRecord } from './session.ts'

/**
 * Send one run's session evidence to Langfuse over its OTLP/HTTP endpoint.
 *
 * These are the standard OTLP spans plus Langfuse's observation attributes:
 * no Langfuse SDK, no new dependency, and a failed export never fails a
 * migration. The trace id is deterministic, so a manifest written before the
 * export can still point at the trace.
 */

export interface LangfuseSettings {
  host: string
  publicKey: string
  secretKey: string
  timeoutMs?: number | undefined
}

export function langfuseSettings(env: NodeJS.ProcessEnv): LangfuseSettings | undefined {
  const host = env.LANGFUSE_HOST
  const publicKey = env.LANGFUSE_PUBLIC_KEY
  const secretKey = env.LANGFUSE_SECRET_KEY
  if (host === undefined || host === '' || publicKey === undefined || publicKey === '' || secretKey === undefined || secretKey === '') return undefined
  return { host: host.replace(/\/+$/, ''), publicKey, secretKey }
}

interface Attribute {
  key: string
  value: { stringValue: string } | { intValue: number } | { doubleValue: number } | { boolValue: boolean }
}

interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attribute[]
  status?: { code: number; message?: string }
}

export interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: Attribute[] }
    scopeSpans: Array<{
      scope: { name: string; version: string }
      spans: Span[]
    }>
  }>
}

const SERVICE = 'dsh-migrate'

function hash(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length)
}

export function traceIdFor(runId: string): string {
  return hash(`trace:${runId}`, 32)
}

function spanIdFor(seed: string): string {
  return hash(`span:${seed}`, 16)
}

function nano(ms: number): string {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString()
}

function string(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } }
}

function integer(key: string, value: number): Attribute {
  return { key, value: { intValue: Math.max(0, Math.round(value)) } }
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function bounded(text: string, max = 8_000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function span(input: {
  traceId: string
  seed: string
  parentSpanId?: string | undefined
  name: string
  start: number
  end: number
  attributes: Attribute[]
  failed?: boolean | undefined
  message?: string | undefined
}): Span {
  return {
    traceId: input.traceId,
    spanId: spanIdFor(input.seed),
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    name: input.name,
    kind: 1,
    startTimeUnixNano: nano(input.start),
    endTimeUnixNano: nano(Math.max(input.start, input.end)),
    attributes: input.attributes,
    ...(input.failed === true
      ? { status: { code: 2, ...(input.message === undefined ? {} : { message: input.message }) } }
      : { status: { code: 1 } }),
  }
}

function sessionTimes(sessions: readonly SessionRecord[], manifest: RunManifest): { start: number; end: number } {
  const starts = sessions.map(session => Date.parse(session.startedAt)).filter(Number.isFinite)
  const ends = sessions.map(session => Date.parse(session.endedAt)).filter(Number.isFinite)
  const fallback = Date.parse(manifest.startedAt)
  return {
    start: starts.length === 0 ? fallback : Math.min(...starts),
    end: ends.length === 0 ? Math.max(fallback, Date.parse(manifest.endedAt)) : Math.max(...ends),
  }
}

/** Build the OTLP payload; exported for tests and for a future collector. */
export function buildOtlpPayload(manifest: RunManifest, sessions: readonly SessionRecord[]): OtlpPayload {
  const traceId = manifest.trace?.id ?? traceIdFor(manifest.runId)
  const times = sessionTimes(sessions, manifest)
  const rootId = spanIdFor(`root:${manifest.runId}`)
  const root = span({
    traceId,
    seed: `root:${manifest.runId}`,
    name: `migrate ${manifest.plugin.join(', ')} → ${manifest.target.tag}`,
    start: times.start,
    end: times.end,
    attributes: [
      string('langfuse.trace.name', `migrate ${manifest.plugin.join(', ')} → ${manifest.target.tag}`),
      string('langfuse.trace.metadata.run_id', manifest.runId),
      string('langfuse.trace.metadata.migration', manifest.migrationId),
      string('langfuse.trace.metadata.plugin', manifest.plugin.join(', ')),
      string('langfuse.trace.metadata.target', manifest.target.tag),
      ...(manifest.source === undefined ? [] : [string('langfuse.trace.metadata.source', manifest.source.tag)]),
      string('langfuse.trace.metadata.outcome', manifest.outcome),
      string('langfuse.observation.type', 'span'),
      string('langfuse.observation.input', json({
        plugin: manifest.plugin,
        ...(manifest.source === undefined ? {} : { source: manifest.source }),
        target: manifest.target,
      })),
      string('langfuse.observation.output', manifest.outcome),
    ],
  })

  const spans: Span[] = [root]
  for (const session of sessions) {
    const sessionId = spanIdFor(`session:${manifest.runId}:${session.name}`)
    const start = Date.parse(session.startedAt)
    const end = Date.parse(session.endedAt)
    const observations = [...session.observations].sort((left, right) => left.seq - right.seq)
    const sessionSpan = span({
      traceId,
      seed: `session:${manifest.runId}:${session.name}`,
      parentSpanId: rootId,
      name: `session ${session.kind} (${session.name})`,
      start,
      end,
      failed: session.outcome !== 'completed',
      ...(session.outcome === 'completed' ? {} : { message: session.outcome }),
      attributes: [
        string('langfuse.observation.type', 'agent'),
        string('langfuse.observation.input', bounded(session.prompt)),
        ...(session.output === undefined ? [] : [string('langfuse.observation.output', bounded(session.output))]),
        string('langfuse.observation.metadata.kind', session.kind),
        string('langfuse.observation.metadata.name', session.name),
        string('langfuse.observation.metadata.outcome', session.outcome),
        string('langfuse.observation.metadata.prompt_sha256', session.promptSha256),
        ...(session.progress === undefined
          ? []
          : [
            integer('langfuse.observation.metadata.turns', session.progress.turns),
            integer('langfuse.observation.metadata.steps', session.progress.steps),
            integer('langfuse.observation.metadata.elapsed_seconds', session.progress.elapsedSeconds),
          ]),
        ...(session.usage === undefined
          ? []
          : [
            integer('gen_ai.usage.input_tokens', session.usage.inputTokens),
            integer('gen_ai.usage.output_tokens', session.usage.outputTokens),
            integer('gen_ai.usage.cache_read.input_tokens', session.usage.cacheHitTokens),
            ...(session.usage.usd === undefined ? [] : [string('langfuse.observation.cost_details', json({ total: session.usage.usd }))]),
          ]),
        integer('langfuse.observation.metadata.tool_calls', session.toolCalls),
      ],
    })
    spans.push(sessionSpan)

    let previousTime = start
    for (const observation of observations) {
      const time = Math.max(previousTime, observation.time)
      previousTime = time
      if (observation.type === 'assistant') {
        const next = observations.find(entry => entry.seq > observation.seq && entry.time >= time)
        const endTime = next?.time ?? end
        spans.push(span({
          traceId,
          seed: `generation:${manifest.runId}:${session.name}:${String(observation.seq)}`,
          parentSpanId: sessionId,
          name: observation.turn === undefined ? 'assistant' : `assistant ${String(observation.turn)}.${String(observation.step ?? 0)}`,
          start: time,
          end: endTime,
          attributes: [
            string('langfuse.observation.type', 'generation'),
            string('gen_ai.request.model', manifest.agent.model.model),
            ...(observation.usage === undefined
              ? []
              : [
                integer('gen_ai.usage.input_tokens', observation.usage.inputTokens),
                integer('gen_ai.usage.output_tokens', observation.usage.outputTokens),
                integer('gen_ai.usage.cache_read.input_tokens', observation.usage.cacheHitTokens),
              ]),
            ...(observation.text === undefined ? [] : [string('langfuse.observation.output', observation.text)]),
            ...(observation.reasoning === undefined ? [] : [string('langfuse.observation.metadata.reasoning', observation.reasoning)]),
          ],
        }))
        continue
      }
      if (observation.type !== 'tool-call') continue
      const call = observation
      const result = observations.find(entry => entry.seq > call.seq && entry.type === 'tool-result')
      const toolName = call.tool?.name ?? result?.tool?.name ?? 'tool'
      spans.push(span({
        traceId,
        seed: `tool:${manifest.runId}:${session.name}:${String(call.seq)}`,
        parentSpanId: sessionId,
        name: `tool ${toolName}`,
        start: time,
        end: result?.time ?? end,
        failed: result?.tool?.failed === true,
        ...(result?.tool?.failed === true ? { message: `${toolName} failed` } : {}),
        attributes: [
          string('langfuse.observation.type', 'tool'),
          string('langfuse.observation.metadata.tool', toolName),
          ...(call.tool?.arguments === undefined ? [] : [string('langfuse.observation.input', call.tool.arguments)]),
          ...(result?.tool?.result === undefined ? [] : [string('langfuse.observation.output', result.tool.result)]),
        ],
      }))
    }
  }

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          string('service.name', SERVICE),
          string('service.version', manifest.actionVersion),
        ],
      },
      scopeSpans: [{
        scope: { name: SERVICE, version: manifest.actionVersion },
        spans,
      }],
    }],
  }
}

export class LangfuseExporter {
  constructor(
    private readonly settings: LangfuseSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  traceId(runId: string): string {
    return traceIdFor(runId)
  }

  async export(manifest: RunManifest, sessions: readonly SessionRecord[]): Promise<{ exported: boolean; detail?: string | undefined }> {
    const payload = buildOtlpPayload(manifest, sessions)
    const auth = Buffer.from(`${this.settings.publicKey}:${this.settings.secretKey}`).toString('base64')
    try {
      const response = await this.fetchImpl(`${this.settings.host}/api/public/otel/v1/traces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${auth}`,
          'x-langfuse-ingestion-version': '4',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.settings.timeoutMs ?? 10_000),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return { exported: false, detail: `Langfuse ${String(response.status)}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}` }
      }
      return { exported: true }
    } catch (error) {
      return { exported: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function toolCallsOf(observations: readonly SessionObservation[]): number {
  return observations.filter(observation => observation.type === 'tool-call').length
}
