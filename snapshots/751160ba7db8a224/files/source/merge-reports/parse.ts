import { z } from 'zod'

/**
 * Parse what a report session printed: one fenced JSON block at the end.
 *
 * Strict on purpose. A session that cannot produce its block is a failed
 * channel with a reason, never a half-written issue.
 */

export const reportPayloadSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
})
export type ReportPayload = z.infer<typeof reportPayloadSchema>

export const duplicateDecisionSchema = z.object({
  slug: z.string().min(1),
  post: z.boolean(),
  reason: z.string(),
  existing: z.array(z.object({ url: z.string(), title: z.string(), why: z.string() })),
})
export type DuplicateDecision = z.infer<typeof duplicateDecisionSchema>

export const duplicatePayloadSchema = z.object({ decisions: z.array(duplicateDecisionSchema) })

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

const FENCE = '```'

/** The body of the last fenced block in a session's output. */
export function lastFencedBlock(text: string): string | undefined {
  const end = text.lastIndexOf(`\n${FENCE}`)
  if (end < 0) return undefined
  const open = text.lastIndexOf(FENCE, end - 1)
  if (open < 0) return undefined
  const firstLine = text.indexOf('\n', open)
  return firstLine < 0 || firstLine > end ? undefined : text.slice(firstLine + 1, end)
}

/**
 * Parse the last fenced block of a session's output against a schema.
 * @param text - the whole session output.
 * @param schema - the payload shape the channel's contract names.
 */
export function parsePayload<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  const block = lastFencedBlock(text)
  if (block === undefined) return { ok: false, reason: 'the session printed no fenced JSON block' }
  let raw: unknown
  try {
    raw = JSON.parse(block)
  } catch (error) {
    return { ok: false, reason: `the JSON block does not parse: ${(error as Error).message}` }
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: z.prettifyError(parsed.error) }
}
