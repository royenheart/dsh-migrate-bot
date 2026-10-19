/**
 * Gate: a Markdown paragraph is one physical line.
 *
 * Hard-wrapped paragraphs turn every edit into a reflow of its neighbours, so
 * a diff no longer shows what changed. A paragraph line is a line of prose
 * that is not a heading, list item, table row, quotation, HTML or thematic
 * break; two in a row are one paragraph wrapped. An indented line continues a
 * list item and is not counted. The gate covers the documents this repository
 * writes: `README.md`, `AGENTS.md` and `docs/`; the changelog is generated and
 * fixtures are test data.
 */

import { proseLines } from './md.ts'
import { join } from 'node:path'
import { readText, rel, repoFiles, REPO_ROOT } from './repo.ts'

export interface WrapViolation {
  file: string
  line: number
}

const STRUCTURE = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|<|---|\*\*\*|___|\[[^\]]+\]:)/

const isParagraph = (text: string): boolean => text.trim() !== '' && !/^\s/.test(text) && !STRUCTURE.test(text)

export function wrappedLines(file: string, source: string): WrapViolation[] {
  const prose = proseLines(source)
  return prose.flatMap((current, index) => {
    const previous = prose[index - 1]
    return previous !== undefined && previous.line === current.line - 1 && isParagraph(previous.text) && isParagraph(current.text) ? [{ file, line: current.line }] : []
  })
}

export function verifyMarkdownWrap(): WrapViolation[] {
  const documents = [join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'AGENTS.md'), ...repoFiles(['.md'], join(REPO_ROOT, 'docs'))]
  return documents.flatMap(path => wrappedLines(rel(path), readText(path)))
}
