/**
 * A dependency-free Markdown scanner for the repository's documentation gates.
 *
 * The gates need three things from a document: the anchors it exposes, the
 * relative links it contains, and the line each of those sits on. A full
 * CommonMark parser is not required for that, and adding one would put a parser
 * and its transitive dependencies in the path of every CI run, so this module
 * covers exactly the constructs the repository's own documentation uses and
 * treats everything else as plain text.
 *
 * Only fenced code blocks and inline code spans are special-cased, because both
 * routinely contain text that looks like a heading or a link (`# comment`,
 * `[x](y)`) without being one.
 */

/** One ATX heading, with the 1-based line it starts on. */
export interface Heading {
  level: number
  /** Rendered heading text: inline Markdown syntax already removed. */
  text: string
  line: number
}

/** One link or image target, with the 1-based line it appears on. */
export interface LinkRef {
  url: string
  line: number
}

/** An opening or closing code fence and the marker character it uses. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * Report which lines of `source` sit inside a fenced code block.
 *
 * A fence closes only on a run of the same character that opened it, so a
 * `~~~` block may contain ``` ``` ``` without ending early.
 * @param source - the document's full text.
 * @returns a 0-based lookup that is true for every line inside a fence.
 */
function fencedLines(source: string): boolean[] {
  const lines = source.split('\n')
  const inside = lines.map(() => false)
  let marker: string | undefined
  for (const [index, line] of lines.entries()) {
    const match = FENCE.exec(line)
    if (marker === undefined) {
      if (match?.[1] !== undefined) {
        marker = match[1][0]
        inside[index] = true
      }
      continue
    }
    inside[index] = true
    if (match?.[1]?.[0] === marker) marker = undefined
  }
  return inside
}

/** One line of prose: outside fences and the frontmatter, with code spans and link targets removed. */
export interface ProseLine {
  line: number
  text: string
}

/**
 * The prose of a document, line by line. Code spans and fenced blocks hold
 * identifiers and samples, not prose, and a link keeps only its label.
 * @param source - the document's full text.
 * @returns every line outside fences and the frontmatter, in order.
 */
export function proseLines(source: string): ProseLine[] {
  const fenced = fencedLines(source)
  const lines = source.split('\n')
  const frontmatter = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  return lines.flatMap((raw, index) => fenced[index] === true || index <= frontmatter
    ? []
    : [{ line: index + 1, text: raw.replace(/`[^`]*`/g, ' ').replace(/!?\[([^\]]*)\]\([^()]*\)/g, '$1') }])
}

/**
 * Remove inline Markdown syntax from a fragment of text, keeping its words.
 *
 * Codespans keep their contents (GitHub slugs the rendered text, which includes
 * them), images and links collapse to their label, and emphasis, strikethrough,
 * and raw HTML tags disappear.
 * @param text - raw inline Markdown.
 * @returns the text as a reader sees it.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^()]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)([^*_]+)\1/g, '$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

/**
 * Turn rendered heading text into the anchor GitHub assigns it.
 *
 * Lowercases, drops every character that is not a letter, number, space,
 * underscore, or hyphen, then maps each space to a hyphen. Removal happens
 * before the space mapping, so `a — b` becomes `a--b` (two hyphens), which is
 * what GitHub produces.
 * @param heading - the rendered heading text.
 * @returns the slug for the first occurrence of that heading.
 */
export function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')
}

/**
 * Every anchor a document exposes: each heading's GitHub slug with GitHub's
 * `-1`, `-2`, … suffixes for repeats, plus every explicit `<a id="…">`.
 * @param source - the document's full text.
 * @returns the set of valid `#fragment` targets for links into this document.
 */
export function documentAnchors(source: string): Set<string> {
  const anchors = new Set<string>()
  const seen = new Map<string, number>()
  for (const heading of headingsOf(source)) {
    const base = githubSlug(heading.text)
    let bump = seen.get(base) ?? 0
    let candidate = base
    while (anchors.has(candidate)) {
      bump += 1
      candidate = `${base}-${bump}`
    }
    seen.set(base, bump)
    anchors.add(candidate)
  }
  // An `<a id>` inside a comment registers nothing, and one shown inside a code
  // sample is being displayed rather than declared, so both are excluded.
  const fenced = fencedLines(source)
  const live = source
    .split('\n')
    .filter((_, index) => fenced[index] !== true)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
  for (const match of live.matchAll(/<a id="([^"]+)"/g)) {
    if (match[1] !== undefined) anchors.add(match[1])
  }
  return anchors
}

/**
 * Collect the ATX headings of a document, skipping fenced code blocks.
 * @param source - the document's full text.
 * @returns headings in document order.
 */
export function headingsOf(source: string): Heading[] {
  const fenced = fencedLines(source)
  const headings: Heading[] = []
  for (const [index, line] of source.split('\n').entries()) {
    if (fenced[index] === true) continue
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    headings.push({ level: match[1].length, text: stripInlineMarkdown(match[2]), line: index + 1 })
  }
  return headings
}

/**
 * Collect every link and image target in a document, in both the inline
 * (`[label](target)`) and reference-definition (`[label]: target`) forms.
 * Code fences and inline code spans are skipped, because a URL inside a code
 * sample is being shown, not linked.
 * @param source - the document's full text.
 * @returns the targets in document order, with their lines.
 */
export function linksOf(source: string): LinkRef[] {
  const fenced = fencedLines(source)
  const found: LinkRef[] = []
  for (const [index, raw] of source.split('\n').entries()) {
    if (fenced[index] === true) continue
    const line = raw.replace(/`[^`]*`/g, '')
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (match[1] !== undefined) found.push({ url: match[1], line: index + 1 })
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line)
    if (definition?.[1] !== undefined) found.push({ url: definition[1], line: index + 1 })
  }
  return found
}

/**
 * Split a link target into its path and fragment, percent-decoding the path.
 * @param url - a raw link target.
 * @returns the decoded path (`''` for a same-page anchor) and the fragment without `#`.
 */
export function splitTarget(url: string): { path: string; fragment: string | undefined } {
  const hash = url.indexOf('#')
  const beforeHash = hash === -1 ? url : url.slice(0, hash)
  const rawFragment = hash === -1 ? '' : url.slice(hash + 1)
  const withoutQuery = beforeHash.replace(/[?].*$/, '')
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    // A malformed percent escape is not a path any renderer resolves; keeping it
    // raw lets the existence check report the link as broken.
  }
  return { path: decoded, fragment: hash === -1 || rawFragment === '' ? undefined : decodeURIComponent(rawFragment) }
}

/**
 * True for targets this repository's gates do not check: scheme-qualified URLs
 * (`https:`, `mailto:`), protocol-relative hosts, and root-absolute paths.
 * @param url - a raw link target.
 * @returns whether the target is out of scope for link resolution.
 */
export function isExternalTarget(url: string): boolean {
  if (url.startsWith('//') || url.startsWith('/')) return true
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}
