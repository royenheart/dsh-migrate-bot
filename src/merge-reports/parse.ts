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

/** A fence line as CommonMark reads one: up to three spaces, then three or more backticks. */
const FENCE_LINE = /^ {0,3}(`{3,})(.*)$/

/**
 * The body of the last fenced block in a session's output. Fences are lines,
 * so backticks inside a JSON string (a report body quoting code) are not one.
 */
export function lastFencedBlock(text: string): string | undefined {
  let last: string | undefined
  let open: { fence: string; lines: string[] } | undefined
  for (const line of text.split('\n')) {
    const fence = FENCE_LINE.exec(line)
    if (open === undefined) {
      if (fence !== null) open = { fence: fence[1] ?? '', lines: [] }
    } else if (fence !== null && (fence[1] ?? '').length >= open.fence.length && (fence[2] ?? '').trim() === '') {
      last = open.lines.join('\n')
      open = undefined
    } else {
      open.lines.push(line)
    }
  }
  return last
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
