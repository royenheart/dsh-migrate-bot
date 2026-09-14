/**
 * Official DeepSeek published rates (USD per 1M tokens), as a dated snapshot.
 *
 * The table is vendored rather than fetched because DeepSeek publishes no
 * machine-readable price source: `api-docs.deepseek.com` has no OpenAPI JSON and
 * no feed, and every third-party price dataset checked on 2026-09-12 was stale,
 * missing the current model ids, or had no peak/off-peak concept at all. A
 * vendored snapshot with a date is therefore the honest artifact, and the age of
 * that date is reported alongside any cost derived from it.
 *
 * Two rules that a naive table gets wrong, both from the official pricing page:
 *
 * 1. **Price the model that served the request, not the alias that was
 *    requested.** DeepSeek normalises the response `model` (`deepseek-v4-flash`
 *    is answered as `deepseek-flash`), and retired aliases are routed to the
 *    current model and billed at its rates.
 * 2. **Peak and off-peak are different prices.** Off-peak is half of peak, and
 *    the window is UTC 01:00–04:00 and 06:00–10:00, Monday to Friday.
 *
 * The data home for these figures is `pricing/deepseek.json`, which the Python
 * benchmark summarizer also reads so a recorded cost and a reported cost come
 * from one table. The constants below are the compiled-in mirror the runtime
 * uses, and `scripts/verify-price-table.ts` fails when the two drift.
 *
 * @see https://api-docs.deepseek.com/quick_start/pricing
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

/** When this snapshot was taken from the official pricing page. */
export const PRICE_TABLE_FETCHED_AT = '2026-09-12'

/** The page this snapshot was read from. */
export const PRICE_TABLE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing'

/**
 * How long a snapshot stays worth reporting without a warning. DeepSeek changed
 * prices twice in the month before this snapshot, and tells readers to check the
 * page regularly, so two weeks is the point where a figure stops being
 * comparable rather than merely old.
 */
export const PRICE_TABLE_STALE_AFTER_DAYS = 14

/**
 * Official table keyed by the id DeepSeek reports as *served*, plus the retired
 * aliases that route to the same model and are billed at the same rates.
 *
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired: requests
 * under those names are served by V4.1-Flash and billed at the Flash price
 * (official footnote 1), which is why they carry the `deepseek-flash` numbers
 * rather than a historical table of their own.
 *
 * Third-party tables disagree on that last point: as of 2026-09-12 LiteLLM
 * (whose default branch is `litellm_internal_staging`, not `main`) and LLMRates
 * both still list `deepseek-v4-flash` at the retired model's own 0.44 / 0.014 /
 * 1.32. The official footnote is the source of record here, and a mismatch in
 * reported cost is the signal to re-read that page rather than the table.
 */
export const DEEPSEEK_RATES: Record<string, OfficialRates> = {
  'deepseek-flash': {
    cacheHit: { offPeak: 0.003, peak: 0.006 },
    cacheMiss: { offPeak: 0.15, peak: 0.30 },
    output: { offPeak: 0.60, peak: 1.20 },
  },
  'deepseek-v4-flash': {
    cacheHit: { offPeak: 0.003, peak: 0.006 },
    cacheMiss: { offPeak: 0.15, peak: 0.30 },
    output: { offPeak: 0.60, peak: 1.20 },
  },
  'deepseek-v4-flash-vision-exp': {
    cacheHit: { offPeak: 0.003, peak: 0.006 },
    cacheMiss: { offPeak: 0.15, peak: 0.30 },
    output: { offPeak: 0.60, peak: 1.20 },
  },
  'deepseek-v4-pro': {
    cacheHit: { offPeak: 0.022, peak: 0.044 },
    cacheMiss: { offPeak: 0.66, peak: 1.32 },
    output: { offPeak: 1.98, peak: 3.96 },
  },
}

/**
 * A dated routing change that makes the requested alias the wrong thing to price.
 *
 * From 2026-09-14T04:00Z, `deepseek-v4-pro` requests are routed to V4.1-Flash at
 * V4.1-Flash rates until V4.1-Pro launches. The pricing page's own footnote and
 * the release news disagree about whether V4 Pro keeps its own billing from that
 * date; the news is the more specific statement about routing, so it is applied
 * here and the contradiction is recorded rather than hidden.
 */
export interface RouteOverride {
  model: string
  from: string
  pricedAs: string
  note: string
}

export const DEEPSEEK_ROUTE_OVERRIDES: readonly RouteOverride[] = [
  {
    model: 'deepseek-v4-pro',
    from: '2026-09-14T04:00:00Z',
    pricedAs: 'deepseek-flash',
    note: 'official news news260910: all deepseek-v4-pro requests route to V4.1-Flash at V4.1-Flash rates; the pricing page footnote still says the billing method is unchanged',
  },
]

/**
 * The id to price a request under.
 *
 * The served id wins whenever the caller knows it, because the requested alias
 * can be routed elsewhere; without it the alias is used, after any dated routing
 * override that applies at this time.
 * @param requested - the model id the request asked for.
 * @param served - the `model` the response reported, when the caller captured it.
 * @param at - the time the request was made, for dated routing rules.
 */
export function modelForPricing(requested: string, served?: string | undefined, at?: Date): string {
  if (served !== undefined && served !== '') return served
  const when = at ?? new Date()
  for (const override of DEEPSEEK_ROUTE_OVERRIDES) {
    if (override.model !== requested) continue
    if (when.getTime() >= Date.parse(override.from)) return override.pricedAs
  }
  return requested
}

/** Official rates for a model id, following the routed-alias rules. */
export function ratesForModel(model: string, at?: Date): OfficialRates | undefined {
  return DEEPSEEK_RATES[modelForPricing(model, undefined, at)]
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

/** Whether a usage sample was billed at the peak rate. */
export function tierOf(at: Date): 'peak' | 'off-peak' {
  return isDeepseekPeak(at) ? 'peak' : 'off-peak'
}

/** Why a cost is reported the way it is. */
export type PriceStatus = 'ok' | 'stale-table' | 'unknown-model'

/** A cost together with the table and tier that produced it. */
export interface PricedUsage {
  usd?: number | undefined
  status: PriceStatus
  /** The snapshot date any figure was computed from. */
  tableFetchedAt: string
  /** Whole days between the snapshot and the run, when a `now` is supplied. */
  tableAgeDays?: number | undefined
  /** `peak` or `off-peak`; `mixed` when the samples straddle the boundary. */
  tier?: 'peak' | 'off-peak' | 'mixed' | undefined
  model: string
  detail: string
}

/** Whole days since the vendored snapshot was taken. */
export function priceTableAgeDays(now: Date = new Date()): number {
  const fetched = Date.parse(`${PRICE_TABLE_FETCHED_AT}T00:00:00Z`)
  return Math.max(0, Math.floor((now.getTime() - fetched) / 86_400_000))
}

/** Whether the vendored snapshot is old enough that its figures need re-checking. */
export function priceTableStale(now: Date = new Date()): boolean {
  return priceTableAgeDays(now) > PRICE_TABLE_STALE_AFTER_DAYS
}

/**
 * Price usage samples, reporting the table's provenance with the number.
 *
 * A missing model is `unknown-model` rather than a zero cost: a silent zero is
 * indistinguishable from a free run, which is how a wrong model id hides.
 * @param samples - one entry per request, with the tokens that request billed.
 * @param model - the requested model id.
 * @param options.servedModel - the `model` the responses reported, when captured.
 * @param options.now - the time to measure the table's age against.
 */
export function priceDeepseekUsageDetailed(
  samples: readonly UsageSample[],
  model: string,
  options: { servedModel?: string | undefined; now?: Date } = {},
): PricedUsage {
  const now = options.now ?? new Date()
  const ageDays = priceTableAgeDays(now)
  // Routing is resolved per request, from that request's own time: a run that
  // spans the moment a model starts being served as another one has to price
  // each request under the rules that applied when it was made, and a cost
  // computed "as of now" would silently re-price an older run.
  let usd = 0
  let sawPeak = false
  let sawOffPeak = false
  let pricedAs = modelForPricing(model, options.servedModel, samples[0] === undefined ? now : new Date(samples[0].time))
  let priced = false
  for (const sample of samples) {
    const at = new Date(sample.time)
    const perSample = modelForPricing(model, options.servedModel, at)
    const rates = DEEPSEEK_RATES[perSample]
    if (rates === undefined) {
      pricedAs = perSample
      continue
    }
    pricedAs = perSample
    priced = true
    const peak = isDeepseekPeak(at)
    if (peak) sawPeak = true
    else sawOffPeak = true
    usd += sample.cacheMissTokens / PER_MILLION * (peak ? rates.cacheMiss.peak : rates.cacheMiss.offPeak)
    usd += sample.cacheHitTokens / PER_MILLION * (peak ? rates.cacheHit.peak : rates.cacheHit.offPeak)
    usd += sample.outputTokens / PER_MILLION * (peak ? rates.output.peak : rates.output.offPeak)
  }
  if (!priced) {
    // Nothing to price is not the same as nothing known: an empty sample list
    // still reports the table, and only a model with no vendored rate is
    // `unknown-model`.
    const known = DEEPSEEK_RATES[modelForPricing(model, options.servedModel, now)]
    if (known !== undefined && samples.length === 0) {
      const staleEmpty = ageDays > PRICE_TABLE_STALE_AFTER_DAYS
      return {
        usd: 0,
        status: staleEmpty ? 'stale-table' : 'ok',
        tableFetchedAt: PRICE_TABLE_FETCHED_AT,
        tableAgeDays: ageDays,
        model: pricedAs,
        detail: `no priced request in this usage; the ${PRICE_TABLE_FETCHED_AT} snapshot would have applied`,
      }
    }
    return {
      status: 'unknown-model',
      tableFetchedAt: PRICE_TABLE_FETCHED_AT,
      tableAgeDays: ageDays,
      model: pricedAs,
      detail: `no vendored rate for \`${pricedAs}\`; costs are unreported rather than zero`,
    }
  }
  const stale = ageDays > PRICE_TABLE_STALE_AFTER_DAYS
  return {
    usd,
    status: stale ? 'stale-table' : 'ok',
    tableFetchedAt: PRICE_TABLE_FETCHED_AT,
    tableAgeDays: ageDays,
    tier: sawPeak && sawOffPeak ? 'mixed' : sawPeak ? 'peak' : 'off-peak',
    model: pricedAs,
    detail: stale
      ? `priced from the ${PRICE_TABLE_FETCHED_AT} snapshot, which is ${String(ageDays)} days old; re-check ${PRICE_TABLE_SOURCE}`
      : `priced from the ${PRICE_TABLE_FETCHED_AT} snapshot (${tierName(sawPeak, sawOffPeak)})`,
  }
}

function tierName(sawPeak: boolean, sawOffPeak: boolean): string {
  if (sawPeak && sawOffPeak) return 'peak and off-peak'
  return sawPeak ? 'peak' : 'off-peak'
}

/**
 * The USD estimate for a set of samples, or `undefined` when the model has no
 * vendored rate. Callers that record a benchmark result should prefer
 * {@link priceDeepseekUsageDetailed}, which also reports the table's age.
 */
export function priceDeepseekUsage(samples: readonly UsageSample[], model: string): number | undefined {
  return priceDeepseekUsageDetailed(samples, model).usd
}
