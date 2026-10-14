import type { QuotaQuery, QuotaQueryInput, QuotaSnapshot } from './types.ts'

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parse the official DeepSeek `GET /user/balance` body.
 * @see https://api-docs.deepseek.com/api/get-user-balance
 */
export function parseDeepseekBalance(body: unknown, meta: {
  provider: string
  queriedAt: string
}): QuotaSnapshot {
  if (!isRecord(body)) {
    throw new Error('DeepSeek balance response is not an object')
  }
  const infos = body.balance_infos
  let remaining: number | undefined
  let currency: string | undefined
  let granted: number | undefined
  let toppedUp: number | undefined
  if (Array.isArray(infos)) {
    for (const item of infos) {
      if (!isRecord(item)) continue
      const total = parseAmount(item.total_balance)
      if (total === undefined) continue
      remaining = total
      currency = typeof item.currency === 'string' ? item.currency : undefined
      granted = parseAmount(item.granted_balance)
      toppedUp = parseAmount(item.topped_up_balance)
      break
    }
  }
  const available = body.is_available === true
  if (!available) {
    return {
      kind: 'unavailable',
      provider: meta.provider,
      queriedAt: meta.queriedAt,
      ...(remaining === undefined ? {} : { remaining }),
      ...(currency === undefined ? {} : { currency }),
      ...(granted === undefined ? {} : { granted }),
      ...(toppedUp === undefined ? {} : { toppedUp }),
    }
  }
  return {
    kind: 'available',
    provider: meta.provider,
    queriedAt: meta.queriedAt,
    ...(remaining === undefined ? {} : { remaining }),
    ...(currency === undefined ? {} : { currency }),
    ...(granted === undefined ? {} : { granted }),
    ...(toppedUp === undefined ? {} : { toppedUp }),
  }
}

export function createDeepseekQuotaQuery(options: {
  provider?: string | undefined
  fetchImpl?: typeof fetch | undefined
}): QuotaQuery {
  const provider = options.provider ?? 'deepseek-official'
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    provider,
    async query(input: QuotaQueryInput): Promise<QuotaSnapshot> {
      const queriedAt = (input.now ?? new Date()).toISOString()
      const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: 'application/json',
        },
      })
      if (!response.ok) {
        throw new Error(`DeepSeek balance query failed: HTTP ${response.status}`)
      }
      const body: unknown = await response.json()
      return parseDeepseekBalance(body, { provider, queriedAt })
    },
  }
}
