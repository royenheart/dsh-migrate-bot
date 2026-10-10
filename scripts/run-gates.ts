/**
 * Run every repository gate and report one summary.
 *
 *   npm run gates
 *
 * Each gate is a pure function over the working tree, so they run in-process and
 * the exit status is the only signal CI needs. Gates are cheap and independent
 * of the build's output, which is why they are a separate command from `test`:
 * a documentation defect fails here in seconds rather than after a full build.
 */

import { verifyChangelog } from './verify-changelog.ts'
import { verifyDocIndex } from './verify-doc-index.ts'
import { verifyMarkdownLinks } from './verify-md-links.ts'
import { verifySkillsPin } from './verify-skills-pin.ts'
import { verifyPriceTable } from './verify-price-table.ts'
import { staleReferences } from './references.ts'
import { verifyEnglish } from './verify-english.ts'
import { verifyMarkdownWrap } from './verify-md-wrap.ts'
import { verifyPureCore } from './verify-pure-core.ts'
import { readReleaseFiles, verifyRelease } from './verify-release.ts'
import { GLOSSARY, termDocuments, verifyTerms } from './verify-terms.ts'
import { readText } from './repo.ts'

/** What one gate reported. */
interface GateResult {
  name: string
  ok: boolean
  detail: string
}

/** A gate whose result is a list of problems. */
function listed(name: string, passed: string, problems: string[]): GateResult {
  return { name, ok: problems.length === 0, detail: problems.length === 0 ? passed : problems.join('; ') }
}

/**
 * Run the documentation gates.
 * @returns one result per gate.
 */
export function runGates(): GateResult[] {
  const index = verifyDocIndex()
  const links = verifyMarkdownLinks()
  const changelog = verifyChangelog()
  const skillsPin = verifySkillsPin()
  const priceTable = verifyPriceTable()
  return [
    {
      name: 'changelog',
      ok: changelog.violations.length === 0,
      detail:
        changelog.violations.length === 0
          ? `one header, ${String(changelog.releases)} release section(s)`
          : changelog.violations.map(v => v.detail).join('; '),
    },
    {
      name: 'doc-index',
      ok: index.violations.length === 0,
      detail:
        index.violations.length === 0
          ? `${String(index.rows)} rows resolve and cover every document`
          : index.violations.map(v => v.detail).join('; '),
    },
    {
      name: 'md-links',
      ok: links.violations.length === 0,
      detail:
        links.violations.length === 0
          ? `${String(links.checked)} file(s) checked`
          : links.violations.map(v => `${v.file}:${String(v.line)} ${v.url} [${v.reason}]`).join('; '),
    },
    {
      name: 'skills-pin',
      ok: skillsPin.violations.length === 0,
      detail:
        skillsPin.violations.length === 0
          ? 'the image and the submodule pin the same skills commit'
          : skillsPin.violations.map(v => v.detail).join('; '),
    },
    {
      name: 'price-table',
      ok: priceTable.violations.length === 0,
      detail:
        priceTable.violations.length === 0
          ? `pricing/deepseek.json matches the runtime table (${String(priceTable.ageDays)} days old)`
          : priceTable.violations.map(v => v.detail).join('; '),
    },
    listed('terms', 'no replaced word in prose, every term defined once', verifyTerms(termDocuments(), readText(GLOSSARY)).map(v => `${v.file}:${String(v.line)} ${v.detail}`)),
    listed('english', 'every tracked text file is English', verifyEnglish().map(v => `${v.file}:${String(v.line)} ${v.detail}`)),
    listed('md-wrap', 'every Markdown paragraph is one line', verifyMarkdownWrap().map(v => `${v.file}:${String(v.line)} continues a paragraph`)),
    listed('release', 'every file states the version in VERSION', verifyRelease(readReleaseFiles())),
    listed('pure-core', 'src/workflow and src/domain import nothing with side effects', verifyPureCore().map(v => `${v.file} ${v.detail}`)),
    (() => {
      const stale = staleReferences()
      return {
        name: 'references',
        ok: stale.length === 0,
        detail: stale.length === 0 ? 'docs/reference matches the code it is generated from' : `stale: ${stale.join(', ')}; run node dist/scripts/references.js --write`,
      }
    })(),
  ]
}

if (import.meta.filename === process.argv[1]) {
  const results = runGates()
  for (const result of results) {
    console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}: ${result.detail}`)
  }
  const failed = results.filter(result => !result.ok)
  if (failed.length > 0) {
    console.error(`run-gates: ${String(failed.length)} of ${String(results.length)} gate(s) failed.`)
    process.exit(1)
  }
  console.log(`run-gates: all ${String(results.length)} gate(s) passed.`)
}
