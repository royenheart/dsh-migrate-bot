/**
 * Project the repository documents into the data the wiki page reads.
 *
 * The repository documents are the source; this module only groups them for the
 * sidebar and carries their Markdown. Rendering happens in the browser with the
 * same pinned Markdown library the rest of the site uses, so a documentation
 * change needs no second source and no generated Markdown is committed.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from './repo.ts'

/** One document the wiki shows. `source` is repository-root-relative. */
export interface WikiPage {
  source: string
  route: string
  group: string
  title: string
  markdown: string
}

/** The groups, in sidebar order. */
const GROUPS = ['Overview', 'Design', 'Operations', 'Reference', 'Engineering', 'Postmortems'] as const

/** Markdown files below a directory, recursively and in path order. */
function markdownFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(path => join(dir, path))
    .filter(path => path.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
}

/** The first level-one heading, or the file name when the document has none. */
function titleOf(source: string, markdown: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? source
}

/** Which sidebar group a document belongs to. */
function groupOf(source: string): string {
  if (source === 'README.md' || source === 'AGENTS.md' || source === 'docs/index.md') return 'Overview'
  if (source.startsWith('docs/design/')) return 'Design'
  if (source.startsWith('docs/operations/')) return 'Operations'
  if (source.startsWith('docs/reference/')) return 'Reference'
  if (source.startsWith('docs/postmortems/')) return 'Postmortems'
  return 'Engineering'
}

/**
 * Build the wiki projection from the working tree.
 * @param root - repository root; defaults to this checkout.
 */
export function wikiPages(root = REPO_ROOT): WikiPage[] {
  const sources = [
    'README.md',
    'AGENTS.md',
    ...markdownFiles(join(root, 'docs')).map(path => relative(root, path)),
  ]
  return sources
    .filter(source => source.endsWith('.md'))
    .map(source => {
      const raw = readFileSync(join(root, source), 'utf8')
      const end = raw.startsWith('---\n') ? raw.indexOf('\n---\n', 4) : -1
      const markdown = end === -1 ? raw : raw.slice(end + 5)
      return { source, route: source, group: groupOf(source), title: titleOf(source, markdown), markdown }
    })
    .sort((left, right) => {
      const group = GROUPS.indexOf(left.group as typeof GROUPS[number]) - GROUPS.indexOf(right.group as typeof GROUPS[number])
      return group === 0 ? left.route.localeCompare(right.route) : group
    })
}

/** Write the wiki projection for a site build. */
function pageFile(source: string): string {
  return source.replaceAll('/', '__')
}

export function writeWikiData(outDir: string, root = REPO_ROOT): number {
  const pages = wikiPages(root)
  mkdirSync(join(outDir, 'data', 'wiki-pages'), { recursive: true })
  writeFileSync(join(outDir, 'data', 'wiki.json'), `${JSON.stringify({ pages: pages.map(({ markdown: _markdown, ...page }) => page) })}\n`)
  for (const page of pages) writeFileSync(join(outDir, 'data', 'wiki-pages', `${pageFile(page.source)}.json`), `${JSON.stringify(page)}\n`)
  return pages.length
}
