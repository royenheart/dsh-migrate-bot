/**
 * Read progress from a dsh session event list without importing dsh types.
 * Field names are sniffed (turn/step/usage aliases) so a harness rename of
 * the TypeScript types does not break the Action as long as the durable
 * event JSON still carries those facts.
 */

import { priceDeepseekUsage, type UsageSample } from '../quota/deepseek-price.ts'

export interface SessionProgress {
  turns: number
  steps: number
  elapsedSeconds: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  /** This-run official USD estimate; absent when the model has no published rates. */
  costUsd?: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function eventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : ''
}

function eventTime(event: Record<string, unknown>, fallback: number): number {
  return asNumber(event.time) ?? asNumber(event.ts) ?? asNumber(event.createdAt) ?? fallback
}

function eventData(event: Record<string, unknown>): Record<string, unknown> {
  return isRecord(event.data) ? event.data : event
}

/**
 * Accept both harness TokenUsage (`inputTokens` is uncached) and official
 * DeepSeek wire usage (`prompt_tokens` includes cache hits).
 */
export function readUsage(value: unknown): {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
} | undefined {
  if (!isRecord(value)) return undefined

  if (typeof value.inputTokens === 'number' && typeof value.outputTokens === 'number') {
    const hit = asNumber(value.cacheReadTokens) ?? 0
    const miss = asNumber(value.cacheMissTokens) ?? value.inputTokens
    return {
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
    }
  }

  if (typeof value.prompt_tokens === 'number' && typeof value.completion_tokens === 'number') {
    const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined
    const hit = asNumber(value.prompt_cache_hit_tokens)
      ?? asNumber(details?.cached_tokens)
      ?? 0
    const miss = asNumber(value.prompt_cache_miss_tokens)
      ?? Math.max(0, value.prompt_tokens - hit)
    return {
      inputTokens: miss,
      outputTokens: value.completion_tokens,
      cacheHitTokens: hit,
      cacheMissTokens: miss,
    }
  }

  return undefined
}

function usageFromEvent(event: Record<string, unknown>, data: Record<string, unknown>): ReturnType<typeof readUsage> {
  const direct = readUsage(data.usage)
  if (direct !== undefined) return direct
  const chunk = isRecord(data.chunk) ? data.chunk : undefined
  if (chunk !== undefined) {
    if (chunk.type === 'usage' || readUsage(chunk.usage) !== undefined) {
      const fromChunk = readUsage(chunk.usage) ?? readUsage(chunk)
      if (fromChunk !== undefined) return fromChunk
    }
  }
  if (eventType(event) === 'usage') return readUsage(data) ?? readUsage(event)
  return undefined
}

/**
 * Summarize a session event list. Event `time` prices each usage sample at
 * official DeepSeek peak / off-peak rates when `model` is known.
 */
export function summarizeSessionEvents(
  events: readonly unknown[],
  elapsedSeconds: number,
  options: { model?: string | undefined; now?: number | undefined } = {},
): SessionProgress {
  let turns = 0
  let steps = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0
  const samples: UsageSample[] = []
  const fallbackTime = options.now ?? Date.now()

  for (const item of events) {
    if (!isRecord(item)) continue
    const type = eventType(item)
    const data = eventData(item)
    if (type === 'turn/start') turns += 1
    if (type === 'step/start') steps += 1
    const usage = usageFromEvent(item, data)
    if (usage === undefined) continue
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    cacheHitTokens += usage.cacheHitTokens
    cacheMissTokens += usage.cacheMissTokens
    samples.push({
      time: eventTime(item, fallbackTime),
      cacheMissTokens: usage.cacheMissTokens,
      cacheHitTokens: usage.cacheHitTokens,
      outputTokens: usage.outputTokens,
    })
  }

  const costUsd = options.model === undefined
    ? undefined
    : priceDeepseekUsage(samples, options.model)

  return {
    turns,
    steps,
    elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheMissTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

/** This Action run's official USD estimate for one session snapshot. */
export function usageUnits(progress: SessionProgress): number {
  return progress.costUsd ?? 0
}

export function formatSessionProgress(progress: SessionProgress): string {
  const cost = progress.costUsd === undefined ? undefined : `$${progress.costUsd.toFixed(6)}`
  return [
    `${progress.turns} turns`,
    `${progress.steps} steps`,
    `${progress.elapsedSeconds}s`,
    `cache hit ${progress.cacheHitTokens} miss ${progress.cacheMissTokens}`,
    `in ${progress.inputTokens} out ${progress.outputTokens}`,
    ...(cost === undefined ? [] : [cost]),
  ].join(' / ')
}

const STATUS_PREFIX = 'dsh-migrate-status:'

export function encodeStatusLine(progress: SessionProgress): string {
  return `${STATUS_PREFIX} ${JSON.stringify(progress)}`
}

export function decodeStatusLine(line: string): SessionProgress | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(STATUS_PREFIX)) return undefined
  const raw = trimmed.slice(STATUS_PREFIX.length).trim()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    const turns = asNumber(parsed.turns)
    const steps = asNumber(parsed.steps)
    const elapsedSeconds = asNumber(parsed.elapsedSeconds)
    const inputTokens = asNumber(parsed.inputTokens)
    const outputTokens = asNumber(parsed.outputTokens)
    const cacheHitTokens = asNumber(parsed.cacheHitTokens)
    const cacheMissTokens = asNumber(parsed.cacheMissTokens)
    const costUsd = asNumber(parsed.costUsd)
    if (
      turns === undefined || steps === undefined || elapsedSeconds === undefined
      || inputTokens === undefined || outputTokens === undefined
      || cacheHitTokens === undefined || cacheMissTokens === undefined
    ) {
      return undefined
    }
    return {
      turns,
      steps,
      elapsedSeconds,
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheMissTokens,
      ...(costUsd === undefined ? {} : { costUsd }),
    }
  } catch {
    return undefined
  }
}

export function isInsufficientBalanceText(text: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(text)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(text)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(text)
    || /dsh-migrate: QUOTA\b/.test(text)
    || /dsh-migrate: insufficient balance\b/i.test(text)
}

export function isQuotaLimitText(text: string): boolean {
  return /dsh-migrate: quota limit exceeded\b/i.test(text)
}
