/**
 * Provider-neutral quota snapshot. Callers (CLI / Action) must not inspect
 * provider-specific payloads — use {@link QuotaSnapshot} and {@link QuotaDecision}.
 */
export type QuotaKind = 'available' | 'unavailable' | 'unimplemented'

export interface QuotaSnapshot {
  kind: QuotaKind
  /** Provider id that produced this snapshot (`deepseek-official`, …). */
  provider: string
  /** ISO-8601 time of the query (or of the unimplemented decision). */
  queriedAt: string
  /** Remaining official balance when the provider reports one. */
  remaining?: number | undefined
  currency?: string | undefined
  granted?: number | undefined
  toppedUp?: number | undefined
}

export interface QuotaQueryInput {
  apiKey: string
  /** Wall-clock for tests; production uses `new Date()`. */
  now?: Date | undefined
}

export interface QuotaQuery {
  readonly provider: string
  query(input: QuotaQueryInput): Promise<QuotaSnapshot>
}

export type QuotaDecision =
  | { action: 'continue'; snapshot: QuotaSnapshot; spent: number }
  | { action: 'abort'; reason: 'insufficient_balance' | 'limit_exceeded'; message: string; snapshot: QuotaSnapshot; spent: number }

export interface QuotaCheckInput {
  snapshot: QuotaSnapshot
  /** This Action run's own accounted tokens (not account-wide spend). */
  used?: number | undefined
  /** Optional cap on {@link used} for this Action run only. */
  limit?: number | undefined
}
