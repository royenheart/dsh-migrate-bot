import { boundTraceLine, redactSecrets } from './session-trace.ts'
import type { SessionObservation } from '../observability/session.ts'

/**
 * Turn a dsh session event into the bounded, structured record Langfuse
 * receives. The trace line is for a person watching a run; this is for a
 * trace tree, so it keeps turn/step, tool arguments and usage.
 */

export const OBSERVATION_PREFIX = 'dsh-migrate-observation:'
const DEFAULT_MAX_CHARS = 4_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function dataOf(event: Record<string, unknown>): Record<string, unknown> {
  return isRecord(event.data) ? event.data : event
}

function messageOf(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(data.message) ? data.message : undefined
}

function blockText(message: Record<string, unknown> | undefined, types: readonly string[]): string {
  if (message === undefined || !Array.isArray(message.content)) return ''
  return message.content
    .filter(isRecord)
    .filter(block => types.includes(String(block.type)))
    .map(block => asString(block.text) ?? '')
    .filter(text => text !== '')
    .join('\n')
}

function readUsage(value: unknown): SessionObservation['usage'] {
  if (!isRecord(value)) return undefined
  if (typeof value.inputTokens === 'number' && typeof value.outputTokens === 'number') {
    return {
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cacheHitTokens: asNumber(value.cacheReadTokens) ?? 0,
    }
  }
  if (typeof value.prompt_tokens === 'number' && typeof value.completion_tokens === 'number') {
    const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined
    return {
      inputTokens: Math.max(0, value.prompt_tokens - (asNumber(value.prompt_cache_hit_tokens) ?? asNumber(details?.cached_tokens) ?? 0)),
      outputTokens: value.completion_tokens,
      cacheHitTokens: asNumber(value.prompt_cache_hit_tokens) ?? asNumber(details?.cached_tokens) ?? 0,
    }
  }
  return undefined
}

function usageOf(data: Record<string, unknown>): SessionObservation['usage'] {
  const direct = readUsage(data.usage)
  if (direct !== undefined) return direct
  const chunk = isRecord(data.chunk) ? data.chunk : undefined
  if (chunk !== undefined) return readUsage(chunk.usage) ?? (chunk.type === 'usage' ? readUsage(chunk) : undefined)
  return undefined
}

function at(event: Record<string, unknown>): number {
  return asNumber(event.time) ?? asNumber(event.ts) ?? asNumber(event.createdAt) ?? Date.now()
}

/**
 * Translate one event; unknown events become a generic observation, and an
 * event without a sequence number is not observable.
 */
export function translateObservation(
  event: unknown,
  options: { secrets?: readonly string[] | undefined; maxChars?: number | undefined } = {},
): SessionObservation | undefined {
  if (!isRecord(event)) return undefined
  const seq = asNumber(event.seq)
  const type = asString(event.type)
  if (seq === undefined || type === undefined || type === '') return undefined
  const data = dataOf(event)
  const max = options.maxChars ?? DEFAULT_MAX_CHARS
  const text = (value: string): string => boundTraceLine(redactSecrets(value, options.secrets), max)
  const turn = asNumber(data.turn)
  const step = asNumber(data.step)
  const base = {
    seq,
    time: at(event),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  }

  if (type === 'assistant/message') {
    const message = messageOf(data)
    const reasoning = blockText(message, ['reasoning'])
    const body = blockText(message, ['text'])
    const usage = usageOf(data)
    if (reasoning === '' && body === '' && usage === undefined) return { ...base, type: 'assistant' }
    return {
      ...base,
      type: 'assistant',
      ...(reasoning === '' ? {} : { reasoning: text(reasoning) }),
      ...(body === '' ? {} : { text: text(body) }),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  if (type === 'tool/call') {
    const name = asString(data.name) ?? 'unknown'
    const args = asString(data.arguments) ?? ''
    return {
      ...base,
      type: 'tool-call',
      tool: {
        name,
        ...(args === '' ? {} : { arguments: text(args) }),
      },
    }
  }

  if (type === 'tool/result') {
    const message = messageOf(data)
    const result = blockText(message, ['text'])
    const failed = message?.isError === true || isRecord(data.error)
    const error = isRecord(data.error)
      ? [asString(data.error.code), asString(data.error.reason) ?? asString(data.error.message)].filter(Boolean).join(': ')
      : ''
    return {
      ...base,
      type: 'tool-result',
      tool: {
        name: asString(data.name) ?? 'unknown',
        ...(result === '' ? {} : { result: text(result) }),
        ...(error === '' ? {} : { result: text(error) }),
        failed,
      },
    }
  }

  if (type === 'turn/start') return { ...base, type: 'turn-start' }
  if (type === 'turn/end') return { ...base, type: 'turn-end' }
  if (type === 'usage') return { ...base, type: 'usage', ...(usageOf(data) === undefined ? {} : { usage: usageOf(data) }) }
  return { ...base, type: 'other' }
}

export function encodeObservationLine(observation: SessionObservation): string {
  return `${OBSERVATION_PREFIX} ${JSON.stringify(observation)}`
}

export function decodeObservationLine(line: string): SessionObservation | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(OBSERVATION_PREFIX)) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(OBSERVATION_PREFIX.length).trim())
    if (!isRecord(parsed)) return undefined
    if (typeof parsed.seq !== 'number' || typeof parsed.time !== 'number' || typeof parsed.type !== 'string') return undefined
    return parsed as unknown as SessionObservation
  } catch {
    return undefined
  }
}

export function stripObservationLines(text: string): string {
  return text.split('\n').filter(line => !line.trimStart().startsWith(OBSERVATION_PREFIX)).join('\n')
}
