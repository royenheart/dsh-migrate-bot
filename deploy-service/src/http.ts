import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Small HTTP helpers shared by the routes: one answer shape, bounded body
 * reading, and the two credential checks.
 */

/** One answer, built before anything is written so it can be stored for replay. */
export interface Answer {
  status: number
  contentType: string
  body: string
  headers?: Record<string, string>
}

/**
 * A JSON answer.
 * @param status - the HTTP status.
 * @param value - serialised as the body.
 */
export function json(status: number, value: unknown): Answer {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(value)}\n` }
}

/**
 * A JSON error answer, `{ error }`.
 * @param status - the HTTP status.
 * @param message - one line a caller can show.
 */
export function failure(status: number, message: string): Answer {
  return json(status, { error: message })
}

/**
 * Write an answer to the response.
 * @param res - the response.
 * @param answer - what to write.
 * @param extra - headers added for this delivery only, such as the replay marker.
 */
export function send(res: ServerResponse, answer: Answer, extra: Record<string, string> = {}): void {
  res.writeHead(answer.status, {
    'Content-Type': answer.contentType,
    'Content-Length': String(Buffer.byteLength(answer.body)),
    'Cache-Control': 'no-store',
    ...answer.headers,
    ...extra,
  })
  res.end(answer.body)
}

/** A request body that ran past its limit. */
export class BodyTooLarge extends Error {}

/**
 * Read a request body, refusing one larger than `limit` bytes.
 * @param req - the request.
 * @param limit - the most bytes accepted.
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > limit) throw new BodyTooLarge(`the body is larger than ${String(limit)} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Compare two secrets in constant time, whatever their lengths.
 *
 * Both sides are hashed first, so the comparison always runs over 32 bytes and
 * the time it takes says nothing about the length or a common prefix.
 * @param given - what the caller sent.
 * @param expected - the configured secret.
 */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Whether a request carries `Authorization: Bearer <token>` with the right token.
 * @param req - the request.
 * @param token - the configured `DEPLOY_TOKEN`.
 */
export function hasBearer(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? ''
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') return false
  return sameSecret(value, token)
}

/**
 * Verify GitHub's `X-Hub-Signature-256` over the raw body.
 * @param body - the body exactly as received.
 * @param signature - the header value, `sha256=<hex>`.
 * @param secret - the configured `GITHUB_WEBHOOK_SECRET`.
 */
export function validSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (signature === undefined || !signature.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  return sameSecret(signature, expected)
}

/**
 * Escape text for HTML element content and attribute values.
 * @param text - text somebody else wrote.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

/** The value of a header that may arrive once or not at all. */
export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}
