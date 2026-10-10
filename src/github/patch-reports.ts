import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { neutralizeEmbedHtml, wrapFenced } from './issue-format.ts'
import { externalUrl, inline } from '../render/text.ts'

export const PATCH_REPORTS_DIR = '.dsh-migrate/patch-reports'
export const PATCH_REPORT_FILE = 'report.md'

const OFFICIAL_REF = /https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/(?:issues|pull|discussions)\/\d+[^\s)]*/g
const COMMENT_LIMIT = 60_000

export interface PatchReport {
  slug: string
  title: string
  body: string
  kind: 'existing' | 'draft'
  links: string[]
}

export function patchReportsRoot(workdir: string): string {
  return join(workdir, PATCH_REPORTS_DIR)
}

function firstHeading(body: string, fallback: string): string {
  const match = body.match(/^#\s+(.+)$/m)
  const title = match?.[1]?.trim()
  return title !== undefined && title !== '' ? title : fallback
}

function officialLinks(body: string): string[] {
  return [...new Set(body.match(OFFICIAL_REF) ?? [])]
}

/**
 * One patch report: it is a draft unless it links an existing official thread.
 * @param slug - the report's directory name.
 * @param text - the report's markdown.
 */
export function parsePatchReport(slug: string, text: string): PatchReport | undefined {
  const body = text.trim()
  if (body === '') return undefined
  const links = officialLinks(body)
  return { slug, title: firstHeading(body, slug), body, kind: links.length > 0 ? 'existing' : 'draft', links }
}

/** Read one `report.md` per subdirectory of `.dsh-migrate/patch-reports/`. */
export function collectPatchReports(workdir: string): PatchReport[] {
  const root = patchReportsRoot(workdir)
  if (!existsSync(root)) return []
  const reports: PatchReport[] = []
  for (const slug of readdirSync(root).sort()) {
    const file = join(root, slug, PATCH_REPORT_FILE)
    if (!statSync(join(root, slug)).isDirectory() || !existsSync(file)) continue
    const report = parsePatchReport(slug, readFileSync(file, 'utf8'))
    if (report !== undefined) reports.push(report)
  }
  return reports
}

export function formatPatchReportComment(input: {
  reports: readonly PatchReport[]
  pullRequestUrl?: string | undefined
}): string[] {
  if (input.reports.length === 0 && input.pullRequestUrl === undefined) return []
  const lines: string[] = []
  // A URL is rendered as one only when it is one: a comment line is not a place
  // to republish a credential or a link that was not named.
  const pullRequestUrl = input.pullRequestUrl === undefined ? undefined : externalUrl(input.pullRequestUrl, 300)
  if (pullRequestUrl !== undefined) {
    lines.push(`Companion PR: ${pullRequestUrl}`)
    lines.push('')
  }
  if (input.reports.length === 0) {
    return [lines.join('\n').trim()]
  }
  lines.push('## Patch report index')
  lines.push('')
  lines.push('| Patch | Kind | Links |')
  lines.push('| --- | --- | --- |')
  for (const report of input.reports) {
    const kind = report.kind
    // Every one of these is text the migration wrote into the repository it read.
    const links = report.links.length === 0 ? '—' : report.links.map(link => inline(link, 200)).join('<br>')
    lines.push(`| \`${inline(report.slug, 60)}\` | ${kind} | ${links} |`)
  }
  const header = `${lines.join('\n')}\n`
  const chunks: string[] = []
  let current = header
  for (const report of input.reports) {
    const block = `\n## ${inline(report.slug, 60)}\n\n${wrapFenced(neutralizeEmbedHtml(report.body), 'markdown')}\n`
    if (current.length + block.length > COMMENT_LIMIT && current !== header) {
      chunks.push(current.trim())
      current = block
      continue
    }
    current += block
  }
  if (current.trim() !== '') chunks.push(current.trim())
  return chunks
}
