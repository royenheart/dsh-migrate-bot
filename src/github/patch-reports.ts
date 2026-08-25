import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
 * Read one `report.md` per subdirectory of `.dsh-migrate/patch-reports/`.
 */
export function collectPatchReports(workdir: string): PatchReport[] {
  const root = patchReportsRoot(workdir)
  if (!existsSync(root)) return []
  const slugs = readdirSync(root).sort()
  const reports: PatchReport[] = []
  for (const slug of slugs) {
    const dir = join(root, slug)
    if (!statSync(dir).isDirectory()) continue
    const file = join(dir, PATCH_REPORT_FILE)
    if (!existsSync(file)) continue
    const body = readFileSync(file, 'utf8').trim()
    if (body === '') continue
    const links = officialLinks(body)
    reports.push({
      slug,
      title: firstHeading(body, slug),
      body,
      kind: links.length > 0 ? 'existing' : 'draft',
      links,
    })
  }
  return reports
}

export function formatPatchReportComment(input: {
  reports: readonly PatchReport[]
  pullRequestUrl?: string | undefined
  language: 'en' | 'zh'
}): string[] {
  if (input.reports.length === 0 && input.pullRequestUrl === undefined) return []
  const zh = input.language === 'zh'
  const lines: string[] = []
  if (input.pullRequestUrl !== undefined) {
    lines.push(zh ? `配套 PR：${input.pullRequestUrl}` : `Companion PR: ${input.pullRequestUrl}`)
    lines.push('')
  }
  if (input.reports.length === 0) {
    return [lines.join('\n').trim()]
  }
  lines.push(zh ? '## 补丁报告总表' : '## Patch report index')
  lines.push('')
  lines.push(zh ? '| 补丁 | 类型 | 链接 |' : '| Patch | Kind | Links |')
  lines.push('| --- | --- | --- |')
  for (const report of input.reports) {
    const kind = report.kind === 'existing'
      ? (zh ? '已有讨论' : 'existing')
      : (zh ? '讨论草稿' : 'draft')
    const links = report.links.length === 0 ? '—' : report.links.join('<br>')
    lines.push(`| \`${report.slug}\` | ${kind} | ${links} |`)
  }
  const header = `${lines.join('\n')}\n`
  const chunks: string[] = []
  let current = header
  for (const report of input.reports) {
    const block = `\n## ${report.slug}\n\n${report.body}\n`
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
