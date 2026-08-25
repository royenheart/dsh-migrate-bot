import { createDeepseekQuotaQuery } from './deepseek.ts'
import type { QuotaQuery, QuotaQueryInput, QuotaSnapshot } from './types.ts'

function isDeepseekProvider(provider: string): boolean {
  return provider === 'deepseek-official' || provider.startsWith('deepseek')
}

function unimplemented(provider: string): QuotaQuery {
  return {
    provider,
    query(input: QuotaQueryInput): Promise<QuotaSnapshot> {
      return Promise.resolve({
        kind: 'unimplemented',
        provider,
        queriedAt: (input.now ?? new Date()).toISOString(),
      })
    },
  }
}

/**
 * Quota query for the configured model provider. The Action only calls this
 * factory — it does not know how DeepSeek (or a future provider) parses quota.
 */
export function createQuotaQuery(options: {
  provider: string
  fetchImpl?: typeof fetch | undefined
}): QuotaQuery {
  if (isDeepseekProvider(options.provider)) {
    return createDeepseekQuotaQuery({
      provider: options.provider,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })
  }
  return unimplemented(options.provider)
}
