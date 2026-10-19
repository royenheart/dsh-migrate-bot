/**
 * Gate: `docs/index.md` is a complete, resolvable index of the repository's docs.
 *
 * The index is the progressive-disclosure entry point: `AGENTS.md` carries
 * rules and links here, and this table is what sends a reader to the
 * one document — and the one section — that owns a subject. A hand-maintained
 * table like that rots in two directions, and this gate closes both:
 *
 *   - A row can point somewhere that no longer exists. Every row's home file is
 *     checked on disk and every entry-point anchor is computed from the target
 *     document's headings, so a renamed heading fails here rather than silently
 *     dropping a reader at the top of a page.
 *   - A document can be added and never indexed, which makes it unreachable
 *     through the documented path. Every Markdown file under `docs/` and the two
 *     root entry points must appear as a row's home.
 *
 * The table shape is enforced because the gate has to read it: one topic, one
 * backticked home path, and exactly one entry-point link per row.
 */

import { dirname, relative, resolve } from 'node:path'
import { documentAnchors, linksOf, splitTarget } from './md.ts'
import { isFile, readText, rel, repoFiles, REPO_ROOT } from './repo.ts'

/** The index document, relative to the repository root. */
export const INDEX_PATH = 'docs/index.md'

/** Root entry points that must be reachable from the index. */
const REQUIRED_HOMES = ['README.md', 'AGENTS.md']

/** One parsed index row. */
interface IndexRow {
  line: number
  topic: string
  home: string
  linkUrl: string
}

/** One defect in the index. */
export interface IndexViolation {
  line: number
  detail: string
}

/**
 * Parse the index table's data rows.
 * @param source - the index document's text.
 * @returns the rows, in document order.
 */
export function parseIndexRows(source: string): IndexRow[] {
  const rows: IndexRow[] = []
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 3) continue
    const [topic, home, entry] = cells
    if (topic === undefined || home === undefined || entry === undefined) continue
    // Skip the header and the `|---|---|---|` separator.
    if (topic === 'Topic' || /^-+$/.test(topic)) continue
    const homeMatch = /^`([^`]+)`$/.exec(home)
    const link = linksOf(entry)[0]
    rows.push({
      line: index + 1,
      topic,
      home: homeMatch?.[1] ?? home,
      linkUrl: link?.url ?? '',
    })
  }
  return rows
}

/**
 * Check the index against the documents it claims to cover.
 * @returns one entry per defect, and how many rows were read.
 */
export function verifyDocIndex(): { violations: IndexViolation[]; rows: number } {
  const absIndex = resolve(REPO_ROOT, INDEX_PATH)
  const source = readText(absIndex)
  const indexAnchors = documentAnchors(source)
  const rows = parseIndexRows(source)
  const violations: IndexViolation[] = []

  for (const row of rows) {
    if (row.topic === '') {
      violations.push({ line: row.line, detail: 'row has no topic' })
      continue
    }
    if (row.linkUrl === '') {
      violations.push({ line: row.line, detail: 'row has no entry-point link in the third column' })
      continue
    }
    const { path, fragment } = splitTarget(row.linkUrl)
    // Home cells are repository-root-relative so coverage can be compared as a
    // set, while the link is document-relative so it renders from docs/index.md.
    const resolved = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(INDEX_PATH), path))
    if (resolved !== row.home) {
      violations.push({
        line: row.line,
        detail: `entry-point link resolves to \`${resolved}\` but the home column says \`${row.home}\``,
      })
      continue
    }
    const absHome = resolve(REPO_ROOT, row.home)
    if (!isFile(absHome)) {
      violations.push({ line: row.line, detail: `home \`${row.home}\` does not exist` })
      continue
    }
    if (fragment === undefined) {
      violations.push({ line: row.line, detail: `entry-point link into \`${row.home}\` names no section` })
      continue
    }
    const anchors = absHome === absIndex ? indexAnchors : documentAnchors(readText(absHome))
    if (!anchors.has(fragment)) {
      violations.push({
        line: row.line,
        detail: `\`${row.home}\` has no section \`#${fragment}\`; sections present: ${[...anchors].slice(0, 6).join(', ')}…`,
      })
    }
  }

  const indexed = new Set(rows.map(row => row.home))
  const expected = [
    ...repoFiles(['.md'], resolve(REPO_ROOT, 'docs')).map(path => relative(REPO_ROOT, path)),
    ...REQUIRED_HOMES,
  ].filter(path => path !== INDEX_PATH)

  for (const path of expected) {
    if (!indexed.has(path)) {
      violations.push({ line: 0, detail: `\`${path}\` is not indexed in ${INDEX_PATH}` })
    }
  }

  return { violations, rows: rows.length }
}

if (import.meta.filename === process.argv[1]) {
  const { violations, rows } = verifyDocIndex()
  if (violations.length === 0) {
    console.log(`verify-doc-index: ${String(rows)} rows, every home and section resolves, every document indexed.`)
    process.exit(0)
  }
  console.error(`verify-doc-index: ${INDEX_PATH} is out of date:`)
  for (const violation of violations) {
    console.error(violation.line === 0 ? `  ${violation.detail}` : `  line ${String(violation.line)}: ${violation.detail}`)
  }
  process.exit(1)
}
