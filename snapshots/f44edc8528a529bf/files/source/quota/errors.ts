export class QuotaError extends Error {
  override readonly name = 'QuotaError'
  readonly code: 'insufficient_balance' | 'limit_exceeded' | 'query_failed'

  constructor(code: QuotaError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function isQuotaError(value: unknown): value is QuotaError {
  return value instanceof QuotaError
}
