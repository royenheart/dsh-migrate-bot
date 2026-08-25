const VERDICT_LABELED = /verdict\s*[:.)\]]\s*`?(keep|shrink|retire)`?/i
const VERDICT_HEADING = /^#{1,6}\s*(?:\d+\.\s*)?verdict\b[^\n]*\n+`?(keep|shrink|retire)`?/im

export function longestRun(text: string, char: string): number {
  let max = 0
  let current = 0
  for (const next of text) {
    if (next === char) {
      current += 1
      if (current > max) max = current
    } else {
      current = 0
    }
  }
  return max
}

/**
 * Fence that is longer than any `~` run in the payload, so GFM cannot close early.
 */
export function wrapFenced(content: string, info = ''): string {
  const fence = '~'.repeat(Math.max(4, longestRun(content, '~') + 1))
  const open = info === '' ? fence : `${fence}${info}`
  const body = content.endsWith('\n') ? content : `${content}\n`
  return `${open}\n${body}${fence}`
}

/** Neutralize tags that would close our `<details>` wrapper. */
export function neutralizeEmbedHtml(text: string): string {
  return text.replace(/<\/?(?:details|summary)\b/gi, match => `&lt;${match.slice(1)}`)
}

/**
 * Inline code whose payload may itself contain backticks.
 */
export function inlineCode(text: string): string {
  const ticks = '`'.repeat(Math.max(1, longestRun(text, '`') + 1))
  if (ticks.length === 1) return `${ticks}${text}${ticks}`
  return `${ticks} ${text} ${ticks}`
}

export function boldLine(text: string): string {
  return `**${text.replaceAll('**', '')}**`
}

/**
 * Flowing markdown that must not steal the parent outline or open a fence.
 */
export function sanitizeFlowingMarkdown(text: string): string {
  const neutralized = neutralizeEmbedHtml(text)
  return neutralized.split(/\r?\n/).map(line => {
    let next = line.replace(/^(\s{0,3})#{1,6}\s+/, '$1')
    const fence = next.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/)
    if (fence !== null) {
      const mark = fence[2] ?? ''
      next = `${fence[1] ?? ''}${mark.slice(0, 1)} ${mark.slice(1)}${fence[3] ?? ''}`
    }
    return next
  }).join('\n')
}

/**
 * First ATX heading text, if any.
 */
export function reportTitle(markdown: string): string | undefined {
  const match = markdown.match(/^#{1,6}\s+(.+)$/m)
  const title = match?.[1]?.trim()
  return title === undefined || title === '' ? undefined : title
}

/**
 * keep | shrink | retire when the report labels a verdict.
 */
export function reportVerdict(markdown: string): string | undefined {
  const labeled = markdown.match(VERDICT_LABELED) ?? markdown.match(VERDICT_HEADING)
  const value = labeled?.[1]?.toLowerCase()
  if (value !== undefined) return value
  return undefined
}

function sentenceTrim(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const slice = collapsed.slice(0, maxChars)
  const stop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '))
  if (stop >= 80) return slice.slice(0, stop + 1)
  return `${slice.trimEnd()}…`
}

/**
 * First complete prose paragraphs, never raw ATX headings.
 */
export function reportPreview(markdown: string, maxChars = 800): string {
  const lines = markdown.split(/\r?\n/).filter(line => !/^#{1,6}\s/.test(line.trim()))
  const paras = lines.join('\n').split(/\n\s*\n/)
    .map(para => para.replace(/\s+/g, ' ').trim())
    .filter(para => para.length >= 20 && !/^verdict\b/i.test(para))
  let out = ''
  for (const para of paras) {
    if (VERDICT_LABELED.test(para) && para.length < 40) continue
    const next = out === '' ? para : `${out}\n\n${para}`
    if (next.length > maxChars) {
      if (out === '') return sentenceTrim(para, maxChars)
      break
    }
    out = next
    if (out.length >= 420) break
  }
  return out
}

/**
 * Short Issue/PR excerpt: title, verdict, prose. No H1/H2 that steal the template outline.
 */
export function summarizeAgentReport(markdown: string | undefined, fallback: string): string {
  if (markdown === undefined || markdown.trim() === '') return fallback
  const text = markdown.trim()
  const title = reportTitle(text)
  const verdict = reportVerdict(text)
  const preview = sanitizeFlowingMarkdown(reportPreview(text))
  const lines: string[] = []
  if (title !== undefined) lines.push(boldLine(title))
  if (verdict !== undefined) lines.push(`Verdict: ${inlineCode(verdict)}`)
  if (preview !== '') {
    if (lines.length > 0) lines.push('')
    lines.push(preview)
  }
  if (lines.length === 0) return fallback
  return lines.join('\n')
}

export function formatErrorExcerpt(errors: string, empty: string): string {
  const text = errors.trim() === '' ? empty : errors.replace(/\s+$/, '')
  return wrapFenced(neutralizeEmbedHtml(text))
}

/**
 * Paths from `diff --git a/… b/…` headers.
 */
export function parseDiffPaths(diff: string): string[] {
  const paths: string[] = []
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const path = match[2] ?? match[1]
    if (path !== undefined && path !== '') paths.push(path)
  }
  return paths
}

const DIFF_EXCERPT = 4000

function excerptDiff(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw
  const slice = raw.slice(0, maxChars)
  const nl = slice.lastIndexOf('\n')
  const cut = nl >= 200 ? slice.slice(0, nl) : slice
  return `${cut.trimEnd()}\n…`
}

export function formatWorkingTree(diff: string, language: 'en' | 'zh'): string {
  const trimmed = diff.trim()
  if (trimmed === '') return language === 'zh' ? '_无文件改动。_' : '_No file changes._'
  const files = parseDiffPaths(trimmed)
  const heading = language === 'zh' ? '变更文件' : 'Changed files'
  const excerptLabel = language === 'zh' ? 'Diff 摘录' : 'Diff excerpt'
  const more = language === 'zh'
    ? '_已截断。完整 diff 见配套 PR。_'
    : '_Truncated. Full diff is on the pull request._'
  const list = files.length === 0
    ? (language === 'zh' ? '- （未能解析路径）' : '- (could not parse paths)')
    : files.map(file => `- ${inlineCode(file)}`).join('\n')
  const truncated = trimmed.length > DIFF_EXCERPT
  const excerpt = neutralizeEmbedHtml(excerptDiff(trimmed, DIFF_EXCERPT))
  return `${heading}

${list}

<details>
<summary>${excerptLabel}</summary>

${wrapFenced(excerpt, 'diff')}
${truncated ? `\n${more}\n` : ''}
</details>`
}
