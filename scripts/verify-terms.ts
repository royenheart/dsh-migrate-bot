/**
 * Gate: the words the glossary replaces do not appear in prose.
 *
 * `docs/glossary.md` defines every project term once and lists, per term, the
 * words older documents used for it. This gate reads those lists from the
 * glossary itself and searches the prose of every Markdown document, of
 * `action.yml` and of `examples/` for them, whole words and case-insensitive.
 * Code spans and fenced blocks are skipped: an identifier such as
 * `handback.ts` names a file, not a concept. The glossary also must define each
 * term once.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { proseLines } from './md.ts'
import { readText, rel, repoFiles, REPO_ROOT } from './repo.ts'

export const GLOSSARY = join(REPO_ROOT, 'docs', 'glossary.md')
/** Documents whose subject is the old words themselves. */
const EXEMPT = new Set([GLOSSARY, join(REPO_ROOT, 'CHANGELOG.md')])

export interface TermViolation {
  file: string
  line: number
  detail: string
}

/** The terms of the glossary and the words each replaces, from its table rows. */
export function glossaryTerms(source: string): Array<{ term: string; replaces: string[]; line: number }> {
  return source.split('\n').flatMap((row, index) => {
    const cells = row.split('|').map(cell => cell.trim())
    const term = /^\*\*(.+)\*\*$/.exec(cells[1] ?? '')?.[1]
    if (term === undefined || cells.length !== 6) return []
    const replaces = cells[4] === '—' ? [] : (cells[4] ?? '').split(',').map(word => word.trim()).filter(Boolean)
    return [{ term, replaces, line: index + 1 }]
  })
}

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param documents - path → text of every document to search.
 * @param glossary - the glossary text.
 */
export function verifyTerms(documents: ReadonlyMap<string, string>, glossary: string): TermViolation[] {
  const terms = glossaryTerms(glossary)
  const violations: TermViolation[] = []
  const seen = new Map<string, number>()
  for (const { term, line } of terms) {
    const first = seen.get(term.toLowerCase())
    if (first !== undefined) violations.push({ file: 'docs/glossary.md', line, detail: `**${term}** is defined again (first on line ${String(first)})` })
    seen.set(term.toLowerCase(), line)
  }
  const banned = terms.flatMap(({ term, replaces }) => replaces.map(word => ({ term, word, pattern: new RegExp(`(?<![\\w-])${escape(word)}(?![\\w-])`, 'i') })))
  for (const [file, text] of documents) {
    const prose = file.endsWith('.md') ? proseLines(text) : text.split('\n').map((line, index) => ({ line: index + 1, text: line }))
    for (const { line, text: content } of prose) {
      for (const { term, word, pattern } of banned) {
        if (pattern.test(content)) violations.push({ file, line, detail: `"${word}" is "${term}" in the glossary` })
      }
    }
  }
  return violations
}

/** The documents the gate searches, by repository-relative path. */
export function termDocuments(): Map<string, string> {
  const files = [
    ...repoFiles(['.md']).filter(path => !EXEMPT.has(path)),
    join(REPO_ROOT, 'action.yml'),
    ...readdirSync(join(REPO_ROOT, 'examples')).map(name => join(REPO_ROOT, 'examples', name)),
  ]
  return new Map(files.map(path => [rel(path), readText(path)]))
}
