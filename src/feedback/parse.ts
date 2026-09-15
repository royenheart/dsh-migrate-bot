/**
 * Parse what a feedback session printed.
 *
 * The contract is one fenced JSON block at the end of the output. Parsing is
 * strict on purpose: a channel that cannot produce its block is reported as a
 * failure with the reason, and never delivered as a half-written issue. Nothing
 * here repairs the model's output, because a repaired payload is a payload
 * nobody reviewed.
 */

export interface FeedbackPayload {
  title: string
  body: string
  files: Array<{ path: string; content: string }>
}

export interface DedupeDecision {
  slug: string
  post: boolean
  reason: string
  existing: Array<{ url: string; title: string; why: string }>
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** The last fenced ```json block in the text, or its last `{...}` object. */
export function extractJsonBlock(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)]
  for (const match of fenced.reverse()) {
    const body = match[1]
    if (body === undefined) continue
    const parsed = tryParse(body)
    if (parsed !== undefined) return parsed
  }
  const start = text.lastIndexOf('\n{')
  if (start >= 0) {
    const parsed = tryParse(text.slice(start + 1))
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read a `{ title, body, files }` payload.
 * @param text - the whole session output.
 */
export function parseFeedbackPayload(text: string): ParseResult<FeedbackPayload> {
  const record = asRecord(extractJsonBlock(text))
  if (record === undefined) return { ok: false, reason: 'the session printed no JSON report block' }
  const title = asText(record.title)
  const body = asText(record.body)
  if (title === undefined) return { ok: false, reason: 'the report block has no title' }
  if (body === undefined) return { ok: false, reason: 'the report block has no body' }
  const files: Array<{ path: string; content: string }> = []
  if (record.files !== undefined) {
    if (!Array.isArray(record.files)) return { ok: false, reason: 'the report block has a non-list "files"' }
    for (const entry of record.files) {
      const file = asRecord(entry)
      const path = file === undefined ? undefined : asText(file.path)
      const content = file === undefined ? undefined : file.content
      if (path === undefined || typeof content !== 'string') {
        return { ok: false, reason: 'a "files" entry is missing "path" or "content"' }
      }
      if (path.startsWith('/') || path.split('/').includes('..')) {
        return { ok: false, reason: `file path \`${path}\` is not a repository-relative path` }
      }
      files.push({ path, content })
    }
  }
  return { ok: true, value: { title, body, files } }
}

/**
 * Read a `{ decisions: [...] }` classification, one decision per draft.
 * @param text - the whole session output.
 */
export function parseDedupePayload(text: string): ParseResult<DedupeDecision[]> {
  const record = asRecord(extractJsonBlock(text))
  if (record === undefined) return { ok: false, reason: 'the session printed no JSON classification block' }
  if (!Array.isArray(record.decisions)) {
    return { ok: false, reason: 'the classification block has no "decisions" list' }
  }
  if (record.decisions.length === 0) {
    return { ok: false, reason: 'the classification block carries no decision' }
  }
  const decisions: DedupeDecision[] = []
  for (const entry of record.decisions) {
    const item = asRecord(entry)
    if (item === undefined) return { ok: false, reason: 'a decision is not an object' }
    const slug = item.slug === undefined ? undefined : asText(item.slug)
    if (slug === undefined) return { ok: false, reason: 'a decision has no "slug"' }
    if (typeof item.post !== 'boolean') return { ok: false, reason: `the decision for \`${slug}\` has no boolean "post"` }
    const reason = asText(item.reason)
    if (reason === undefined) return { ok: false, reason: `the decision for \`${slug}\` has no "reason"` }
    const existing: DedupeDecision['existing'] = []
    if (item.existing !== undefined) {
      if (!Array.isArray(item.existing)) {
        return { ok: false, reason: `the decision for \`${slug}\` has a non-list "existing"` }
      }
      for (const candidate of item.existing) {
        const found = asRecord(candidate)
        const url = found === undefined ? undefined : asText(found.url)
        if (url === undefined) return { ok: false, reason: `an "existing" entry for \`${slug}\` has no url` }
        existing.push({
          url,
          title: (found === undefined ? undefined : asText(found.title)) ?? url,
          why: (found === undefined ? undefined : asText(found.why)) ?? '',
        })
      }
    }
    decisions.push({ slug, post: item.post, reason, existing })
  }
  return { ok: true, value: decisions }
}
