/**
 * Official DeepSeek published rates (USD per 1M tokens).
 * @see https://api-docs.deepseek.com/quick_start/pricing
 *
 * Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday.
 * Off-peak is half of peak. Expense = tokens × price.
 */

export interface OfficialRates {
  cacheHit: { offPeak: number; peak: number }
  cacheMiss: { offPeak: number; peak: number }
  output: { offPeak: number; peak: number }
}

export interface UsageSample {
  time: number
  cacheMissTokens: number
  cacheHitTokens: number
  outputTokens: number
}

const PER_MILLION = 1_000_000

/** Official table keyed by model id. */
export const DEEPSEEK_RATES: Record<string, OfficialRates> = {
  'deepseek-v4-pro': {
    cacheHit: { offPeak: 0.022, peak: 0.044 },
    cacheMiss: { offPeak: 0.66, peak: 1.32 },
    output: { offPeak: 1.98, peak: 3.96 },
  },
  'deepseek-v4-flash': {
    cacheHit: { offPeak: 0.007, peak: 0.014 },
    cacheMiss: { offPeak: 0.22, peak: 0.44 },
    output: { offPeak: 0.66, peak: 1.32 },
  },
  'deepseek-v4-flash-vision-exp': {
    cacheHit: { offPeak: 0.007, peak: 0.014 },
    cacheMiss: { offPeak: 0.22, peak: 0.44 },
    output: { offPeak: 0.66, peak: 1.32 },
  },
}

export function ratesForModel(model: string): OfficialRates | undefined {
  return DEEPSEEK_RATES[model]
}

/**
 * Official peak window: 01:00–04:00 and 06:00–10:00 UTC, weekdays.
 * End hours are exclusive ([01:00, 04:00) and [06:00, 10:00)).
 */
export function isDeepseekPeak(at: Date): boolean {
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes()
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
}

export function priceDeepseekUsage(samples: readonly UsageSample[], model: string): number | undefined {
  const rates = ratesForModel(model)
  if (rates === undefined) return undefined
  let usd = 0
  for (const sample of samples) {
    const peak = isDeepseekPeak(new Date(sample.time))
    const hit = peak ? rates.cacheHit.peak : rates.cacheHit.offPeak
    const miss = peak ? rates.cacheMiss.peak : rates.cacheMiss.offPeak
    const out = peak ? rates.output.peak : rates.output.offPeak
    usd += sample.cacheMissTokens / PER_MILLION * miss
    usd += sample.cacheHitTokens / PER_MILLION * hit
    usd += sample.outputTokens / PER_MILLION * out
  }
  return usd
}
