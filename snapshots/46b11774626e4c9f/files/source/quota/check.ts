import type { QuotaCheckInput, QuotaDecision } from './types.ts'

/**
 * Decide whether the run may continue. Action code calls this — it never
 * parses a provider body.
 *
 * `limit` is this Action's own usage, not the account-wide balance drop.
 */
export function decideQuota(input: QuotaCheckInput): QuotaDecision {
  const snapshot = input.snapshot
  const spent = input.used !== undefined && input.used > 0 ? input.used : 0

  if (snapshot.kind === 'unavailable') {
    const remaining = snapshot.remaining === undefined ? 'unknown' : String(snapshot.remaining)
    const currency = snapshot.currency ?? ''
    return {
      action: 'abort',
      reason: 'insufficient_balance',
      message: `insufficient balance: official quota reports the account is not available (remaining ${remaining} ${currency})`.trim(),
      snapshot,
      spent,
    }
  }

  if (input.limit !== undefined && spent >= input.limit) {
    return {
      action: 'abort',
      reason: 'limit_exceeded',
      message: `quota limit exceeded: this run spent ${spent} USD of limit ${input.limit}`,
      snapshot,
      spent,
    }
  }

  return { action: 'continue', snapshot, spent }
}
