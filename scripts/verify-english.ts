/**
 * Gate: every tracked text file is written in English.
 *
 * A letter outside the Latin script — Chinese, Cyrillic, Greek — fails the
 * gate, wherever it is: code, comments, documents, templates, fixtures.
 * Punctuation and symbols (`—`, `→`, `≥`, `×`) are not letters and pass. The
 * Unicode script property decides, so no list of ranges is maintained here.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, THIRD_PARTY } from './repo.ts'

export interface EnglishViolation {
  file: string
  line: number
  detail: string
}

const LETTER = /\p{L}/gu
const LATIN = /\p{Script=Latin}/u

/** Every letter of a text that is not Latin, with its line. */
export function nonLatinLetters(file: string, text: string): EnglishViolation[] {
  return text.split('\n').flatMap((line, index) => {
    const letters = [...line.matchAll(LETTER)].map(match => match[0]).filter(letter => !LATIN.test(letter))
    return letters.length === 0 ? [] : [{ file, line: index + 1, detail: `non-English letters ${[...new Set(letters)].join('')}` }]
  })
}

export function verifyEnglish(): EnglishViolation[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
  return files.filter(file => !THIRD_PARTY.test(file)).flatMap((file) => {
    const path = join(REPO_ROOT, file)
    // A submodule is listed as a directory; its files are someone else's.
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return []
    const bytes = readFileSync(path)
    return bytes.includes(0) ? [] : nonLatinLetters(file, bytes.toString('utf8'))
  })
}
