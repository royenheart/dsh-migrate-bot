/**
 * Rendering text somebody else wrote.
 *
 * A value that arrives from a deploy target, a pull request, or an API is data:
 * the place it lands is a comment, a step summary, or a log line, and a newline
 * in it forges a row, a mention, or a link in something a human reads. Every
 * path that puts such a value into rendered output uses this, so there is one
 * rule rather than one per call site.
 */

/**
 * One short line, with nothing that could start a line of its own.
 *
 * Whitespace collapses, backticks are dropped — they are the only terminator of
 * the code span these values usually sit in — and the result is capped.
 * @param value - the text as it arrived.
 * @param limit - how much of it to keep.
 */
export function inline(value: string, limit = 120): string {
  return collapse(value).slice(0, limit)
}

/**
 * The one line a value becomes, before anything caps its length.
 *
 * Capping is separate because a caller that needs the whole value — the URL rule
 * refuses one too long to be shown rather than cutting it into a different URL —
 * has to see it first.
 * @param value - the text as it arrived.
 */
function collapse(value: string): string {
  return value
    // Whitespace and the characters that are not whitespace to `\s` but still
    // start, rewrite, or hide what a reader sees: an ANSI escape and a NUL, the
    // C1 block whose U+0085 is a line break to some terminals, the soft hyphen
    // and the invisible Hangul fillers, the zero-width and bidirectional
    // controls — U+061C is the Arabic letter mark, a strong RTL control — the
    // musical and interlinear controls, and the tag characters, which encode a
    // second copy of the text invisibly. They become a space rather than nothing,
    // because dropping a zero-width character can weld two words into the mention
    // it was hiding (`@every\u200bone`). U+3164 is the Hangul filler: a blank where
    // a space is not allowed, so a space is what it becomes.
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufe00-\ufe0f\u3164\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}]+/gu, ' ')
    .replace(/`/g, '')
    .trim()
}

/**
 * A URL a target named, or nothing.
 *
 * A URL is not text: it becomes a link target, an output value, and a line in a
 * log, and a `)` in it ends a markdown link early, a credential in it
 * republishes a secret the design forbids, and a `javascript:` scheme is not a
 * page. The value is collapsed to one line first, then the survivors are
 * checked, and what fails a check is dropped rather than rendered — the caller
 * says so and shows nothing. A character the collapse replaces therefore yields
 * a URL with that character replaced rather than no URL at all; the link is
 * wrong, which is what a URL carrying a newline deserves. A URL longer than the
 * limit is dropped too: what a reader would click is a different URL that
 * probably does not exist.
 * @param value - the URL as it arrived.
 * @param limit - how long a URL may be and still be shown.
 */
export function externalUrl(value: string, limit = 300): string | undefined {
  const collapsed = collapse(value)
  if (collapsed === '' || collapsed.length > limit) return undefined
  let parsed: URL
  try {
    parsed = new URL(collapsed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  // Percent-escape what markdown and code spans treat as syntax — by hand,
  // because `encodeURIComponent` leaves parentheses alone and a `)` is exactly
  // what ends a markdown link early. Brackets are left alone: an IPv6 literal
  // needs them in the authority, and neither a code span nor a bare markdown
  // link destination is ended by one.
  return collapsed.replace(
    /[()<>`\s]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}
