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

export interface ReportSection {
  title: string
  body: string
}

const SECTION_BODY = 4000

function truncateBlock(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const slice = trimmed.slice(0, maxChars)
  const nl = slice.lastIndexOf('\n')
  const cut = nl >= 200 ? slice.slice(0, nl) : slice
  return `${cut.trimEnd()}\n…`
}

/**
 * Split an agent report on ATX headings. The first heading is the document title.
 */
export function splitReportSections(markdown: string): { title: string | undefined; lead: string; sections: ReportSection[] } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const sections: ReportSection[] = []
  const before: string[] = []
  let current: ReportSection | undefined
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(?:\d+\.\s*)?(.+?)\s*$/)
    if (heading?.[1] !== undefined) {
      if (current !== undefined) sections.push({ title: current.title, body: current.body.trim() })
      current = { title: heading[1].trim(), body: '' }
      continue
    }
    if (current === undefined) before.push(line)
    else current.body += `${current.body === '' ? '' : '\n'}${line}`
  }
  if (current !== undefined) sections.push({ title: current.title, body: current.body.trim() })
  const title = sections[0]?.title
  const leadFromTitle = sections[0]?.body ?? ''
  const rest = title === undefined ? sections : sections.slice(1)
  const lead = [before.join('\n').trim(), leadFromTitle].filter(part => part !== '').join('\n\n')
  return { title, lead, sections: rest }
}

function findSection(markdown: string | undefined, title: RegExp): string | undefined {
  if (markdown === undefined) return undefined
  const found = splitReportSections(markdown).sections.find(section => title.test(section.title))
  if (found === undefined || found.body.trim() === '') return undefined
  return found.body.trim()
}

/**
 * Structured A/B/C body: title, verdict, then each prompt section as `###`.
 * Headings stay at ### so they cannot steal the Issue `##` outline.
 */
export function formatAgentReport(markdown: string | undefined, fallback: string): string {
  if (markdown === undefined || markdown.trim() === '') return fallback
  const text = markdown.trim()
  const split = splitReportSections(text)
  const title = split.title ?? reportTitle(text)
  const verdict = reportVerdict(text)
  const lines: string[] = []
  if (title !== undefined) lines.push(boldLine(title))
  if (verdict !== undefined) lines.push(`Verdict: ${inlineCode(verdict)}`)
  if (split.sections.length === 0) {
    const preview = sanitizeFlowingMarkdown(reportPreview(text) || split.lead)
    if (preview !== '') {
      if (lines.length > 0) lines.push('')
      lines.push(preview)
    }
    return lines.length === 0 ? fallback : lines.join('\n')
  }
  if (split.lead !== '') {
    lines.push('')
    lines.push(sanitizeFlowingMarkdown(truncateBlock(split.lead, 800)))
  }
  for (const section of split.sections) {
    if (section.title === '') continue
    lines.push('')
    lines.push(`### ${section.title.replaceAll('#', '').trim()}`)
    if (section.body !== '') {
      lines.push('')
      lines.push(sanitizeFlowingMarkdown(truncateBlock(section.body, SECTION_BODY)))
    }
  }
  return lines.length === 0 ? fallback : lines.join('\n')
}

/** @deprecated Use {@link formatAgentReport}. */
export function summarizeAgentReport(markdown: string | undefined, fallback: string): string {
  return formatAgentReport(markdown, fallback)
}

export function formatRootCause(input: {
  language: 'en' | 'zh'
  mechanicalOk: boolean
  reportA?: string | undefined
  reportB?: string | undefined
  reportC?: string | undefined
}): string {
  const zh = input.language === 'zh'
  const fromC = findSection(input.reportC, /root cause|根因/i)
  if (fromC !== undefined) return sanitizeFlowingMarkdown(truncateBlock(fromC, SECTION_BODY))
  const parts: string[] = []
  const verdict = input.reportA === undefined ? undefined : reportVerdict(input.reportA)
  if (verdict !== undefined) {
    parts.push(zh ? `重叠结论：${inlineCode(verdict)}` : `Overlap verdict: ${inlineCode(verdict)}`)
  }
  const gaps = findSection(input.reportB, /remaining|gap|patch|缺口/i)
    ?? findSection(input.reportA, /remaining|gap|patch|缺口|overlap|重叠/i)
  const edits = findSection(input.reportA, /edit|concrete|改动/i)
    ?? findSection(input.reportB, /edit|改动/i)
  if (gaps !== undefined) parts.push(sanitizeFlowingMarkdown(truncateBlock(gaps, SECTION_BODY)))
  else if (edits !== undefined) parts.push(sanitizeFlowingMarkdown(truncateBlock(edits, SECTION_BODY)))
  if (!input.mechanicalOk) {
    parts.push(zh
      ? '机械测试仍失败，错误摘录见下方。'
      : 'Mechanical tests still fail; see the excerpt below.')
  }
  if (parts.length === 0) {
    return input.mechanicalOk
      ? (zh ? '工作区机械检测已通过。产品层结论见下方重叠与对齐各节。' : 'Mechanical checks passed. See overlap and alignment sections below.')
      : (zh ? '机械检测仍失败。错误摘录是直接原因；重叠/对齐各节说明预期改法。' : 'Mechanical checks still fail. The error excerpt is the immediate cause; overlap and alignment sections describe the intended fix.')
  }
  return parts.join('\n\n')
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
