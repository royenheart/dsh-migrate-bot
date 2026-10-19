import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nonLatinLetters } from '../../scripts/verify-english.ts'
import { wrappedLines } from '../../scripts/verify-md-wrap.ts'
import { verifyPriceTable } from '../../scripts/verify-price-table.ts'
import { checkModule, runtimeImports } from '../../scripts/verify-pure-core.ts'
import { readReleaseFiles, verifyRelease } from '../../scripts/verify-release.ts'
import { verifySkillsPin } from '../../scripts/verify-skills-pin.ts'
import { glossaryTerms, verifyTerms } from '../../scripts/verify-terms.ts'
import { REPO_ROOT } from '../../scripts/repo.ts'

const GLOSSARY = [
  '| Term | Definition | In code | Replaces |',
  '|---|---|---|---|',
  '| **proposal** | The branch, issue and pull request. | `Proposal` | migrate PR, migration pull request |',
  '| **deploy service** | The HTTP service. | `deploy.endpoint` | deploy target |',
].join('\n')

test('verify-terms reads each term and the words it replaces from the glossary table', () => {
  assert.deepEqual(glossaryTerms(GLOSSARY).map(entry => [entry.term, entry.replaces]), [['proposal', ['migrate PR', 'migration pull request']], ['deploy service', ['deploy target']]])
})

test('verify-terms rejects a replaced word in prose and accepts it in code', () => {
  const documents = new Map([
    ['docs/a.md', '# A\n\nOpen the Migrate PR on the deploy target.\n\n`deploy-target.ts` is a file name.\n\n```\nmigrate PR in a sample\n```\n'],
    ['action.yml', 'description: talks to the deploy target\n'],
  ])
  assert.deepEqual(verifyTerms(documents, GLOSSARY).map(v => `${v.file}:${String(v.line)} ${v.detail}`), [
    'docs/a.md:3 "migrate PR" is "proposal" in the glossary',
    'docs/a.md:3 "deploy target" is "deploy service" in the glossary',
    'action.yml:1 "deploy target" is "deploy service" in the glossary',
  ])
  assert.deepEqual(verifyTerms(new Map([['docs/b.md', 'The deploy targets list.\n']]), GLOSSARY), [])
})

test('verify-terms rejects a term defined twice', () => {
  const twice = `${GLOSSARY}\n| **Proposal** | Again. | — | — |`
  assert.deepEqual(verifyTerms(new Map(), twice).map(v => v.detail), ['**Proposal** is defined again (first on line 3)'])
})

test('verify-english rejects letters of other scripts and accepts symbols', () => {
  // The letters under test are escaped, or this file would fail the gate it tests.
  const chinese = '\u4e2d\u6587'
  const delta = '\u0394'
  assert.deepEqual(nonLatinLetters('a.ts', `const a = "naïve → ≥ — ×"\n// ${chinese}\nconst ${delta} = 1\n`).map(v => `${String(v.line)} ${v.detail}`), [`2 non-English letters ${chinese}`, `3 non-English letters ${delta}`])
})

test('verify-md-wrap rejects a hard-wrapped paragraph and accepts lists, tables and fences', () => {
  const source = ['---', 'kind: design', 'description: x', '---', '', '# Title', '', 'One line.', 'Wrapped line.', '', '- item', '  continued', '- item', '', '| a |', '| b |', '', '```', 'code', 'code', '```'].join('\n')
  assert.deepEqual(wrappedLines('d.md', source), [{ file: 'd.md', line: 9 }])
})

test('verify-release rejects a file that states another version', () => {
  const files = readReleaseFiles()
  assert.deepEqual(verifyRelease(files), [])
  const version = files.version.trim()
  const drifted = verifyRelease({ ...files, actionYml: files.actionYml.replace(`:v${version}`, ':v0.0.1') })
  assert.deepEqual(drifted, [`action.yml image says 0.0.1, VERSION says ${version}`])
  const workflow = verifyRelease({ ...files, migrateYml: files.migrateYml.replace(`dsh-migrate-bot@v${version}`, 'dsh-migrate-bot@v1') })
  assert.deepEqual(workflow, [`migrate.yml uses #1 says 1, VERSION says ${version}`])
})

test('verify-pure-core reads run-time imports and rejects one with side effects', () => {
  assert.deepEqual(runtimeImports("import type { A } from '../git/run.ts'\nimport { z } from 'zod'\nexport { b } from './b.ts'\nimport { readFileSync } from 'node:fs'\n"), ['zod', './b.ts', 'node:fs'])
  assert.deepEqual(checkModule('src/workflow/x.ts', "import { readFileSync } from 'node:fs'\nimport { git } from '../git/run.ts'\nimport { compareReleases } from '../domain/release.ts'\nimport { configSchema } from '../config/schema.ts'\n").map(v => v.detail), [
    'imports the package node:fs',
    'imports src/git/run.ts, which is not part of the pure core',
  ])
})

test('verify-skills-pin rejects an image pin that differs from the submodule', () => {
  assert.deepEqual(verifySkillsPin('a'.repeat(40), 'a'.repeat(40)).violations, [])
  assert.equal(verifySkillsPin('a'.repeat(40), 'b'.repeat(40)).violations.length, 1)
  assert.equal(verifySkillsPin(undefined, 'b'.repeat(40)).violations.length, 1)
})

test('verify-price-table rejects a data file that drifted from the runtime table', () => {
  const file = readFileSync(join(REPO_ROOT, 'pricing', 'deepseek.json'), 'utf8')
  assert.deepEqual(verifyPriceTable(() => file).violations, [])
  const drifted = JSON.parse(file) as { fetchedAt: string }
  drifted.fetchedAt = '2000-01-01'
  assert.equal(verifyPriceTable(() => JSON.stringify(drifted)).violations.length, 1)
  assert.equal(verifyPriceTable(() => '{').violations.length, 1)
})
