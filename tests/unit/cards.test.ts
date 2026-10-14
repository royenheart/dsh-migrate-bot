import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckRunner } from '../../src/activities/checks.ts'
import { parseConfig } from '../../src/config/load.ts'
import { appRootFrom } from '../../src/paths.ts'
import { cardsInSpan, checkLedger, ledgerPathOf, parseCards, type CardLedger } from '../../src/skills/cards.ts'

const RELEASE_FILE = `# dsh-v0.1.2-alpha.1

## Index

- DSH-0.1.2-A1-10 · New capability: support for registering third-party languages

---

### DSH-0.1.2-A1-10 · New capability: support for registering third-party languages

- **Type**: capability
- **Applies to**: UI plugins that provide localization resources
- **Action level**: optional
- **Migration recipe**: Replace custom i18n patches with the target tag's public language-registration API.

### DSH-0.1.2-A1-25 · \`@deepseek-ai/dsh-client-runtime\` package removed

- **Type**: breaking
- **Action level**: required-if-hit
- **Migration recipe**: Import client symbols from their domain packages.
`

test('a release file reads as its cards, each with its level and recipe', () => {
  const cards = parseCards(RELEASE_FILE, '0.1.2-alpha.1')
  assert.deepEqual(cards.map(card => [card.id, card.type, card.level]), [
    ['DSH-0.1.2-A1-10', 'capability', 'optional'],
    ['DSH-0.1.2-A1-25', 'breaking', 'required-if-hit'],
  ])
  assert.equal(cards[0]?.appliesTo, 'UI plugins that provide localization resources')
  assert.equal(cards[1]?.appliesTo, '')
})

test('a migration crosses the cards after its source up to its target, in release order', () => {
  const references = join(appRootFrom(import.meta.url), 'vendor', 'dsh-plugin-upgrade-skill', 'skills', 'plugin-upgrade', 'references')
  const cards = cardsInSpan(references, '0.1.0-rc.8', '0.1.2-alpha.2')
  assert.deepEqual([...new Set(cards.map(card => card.release))], ['0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.1', '0.1.2-alpha.2'])
  assert.ok(cards.some(card => card.id === 'DSH-0.1.2-A1-25'))
  assert.ok(cards.every(card => card.level !== '' && card.type !== ''), 'every card of the skill has a type and an action level')
  assert.deepEqual(cardsInSpan(references, '0.2.0-rc.1', '0.2.0-rc.1'), [])
})

test('the ledger accounts for every card, finishes the required ones, and points into the tree', () => {
  const cards = parseCards(RELEASE_FILE, '0.1.2-alpha.1')
  const entry = (id: string, fields: Partial<CardLedger['cards'][number]>): CardLedger['cards'][number] =>
    ({ id, applies: true, required: true, status: 'done', evidence: ['src/locale.ts:12'], note: '', ...fields })
  const tree = new Set(['src/locale.ts'])
  const exists = (path: string): boolean => tree.has(path)
  assert.deepEqual(checkLedger(cards, { cards: [entry('DSH-0.1.2-A1-10', {}), entry('DSH-0.1.2-A1-25', { applies: false, required: false, status: 'not-needed', evidence: [] })] }, exists), [])
  assert.deepEqual(checkLedger(cards, { cards: [entry('DSH-0.1.2-A1-10', { status: 'open' })] }, exists), [
    { id: 'DSH-0.1.2-A1-10', problem: 'required and open' },
    { id: 'DSH-0.1.2-A1-25', problem: 'not in the ledger' },
  ])
  assert.deepEqual(checkLedger(cards, { cards: [entry('DSH-0.1.2-A1-10', { evidence: ['src/gone.ts'] }), entry('DSH-0.1.2-A1-25', { applies: false })] }, exists), [
    { id: 'DSH-0.1.2-A1-10', problem: 'evidence not in the tree: src/gone.ts' },
    { id: 'DSH-0.1.2-A1-25', problem: 'required although it does not apply' },
  ])
})

test('the cards check holds the tree to the ledger the sessions keep, and needs a span to do it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mig-cards-'))
  try {
    const references = join(root, 'references')
    mkdirSync(references)
    writeFileSync(join(references, 'v0.1.2-alpha.1.md'), RELEASE_FILE)
    const workdir = join(root, 'plugin')
    mkdirSync(join(workdir, 'src'), { recursive: true })
    writeFileSync(join(workdir, 'src', 'locale.ts'), '')
    const runDir = join(root, 'run')
    const runner = new CheckRunner({ workdir, config: parseConfig({}), cacheDir: join(root, 'dsh'), runDir, cardsDir: references })
    const release = { tag: 'dsh-v0.1.2-alpha.2', version: '0.1.2-alpha.2' }
    const check = (source: string | undefined) => runner.run({ activity: 'check', check: 'cards', release: 'target', e2eBaseline: [], source }, release)

    assert.equal((await check(undefined)).outcome, 'skipped')
    assert.deepEqual([(await check('0.1.1-rc.2')).fingerprint], ['cards: no card ledger at <path>'])
    mkdirSync(runDir, { recursive: true })
    writeFileSync(ledgerPathOf(runDir), JSON.stringify({ cards: [
      { id: 'DSH-0.1.2-A1-10', applies: true, required: true, status: 'open', evidence: [], note: 'the plugin patches LocaleRuntime' },
      { id: 'DSH-0.1.2-A1-25', applies: true, required: true, status: 'done', evidence: ['src/locale.ts'], note: '' },
    ] }))
    const open = await check('0.1.1-rc.2')
    assert.equal(open.fingerprint, 'cards: DSH-0.1.2-A1-10')
    assert.match(open.detail, /Recipe: Replace custom i18n patches/)
    // Shapes sessions write: one evidence path as a string, no note, keys the check does not read.
    writeFileSync(ledgerPathOf(runDir), JSON.stringify({ plugin: '@acme/web', cards: [
      { id: 'DSH-0.1.2-A1-10', applies: true, required: true, status: 'done', evidence: 'src/locale.ts:3', corridor: 'A1' },
      { id: 'DSH-0.1.2-A1-25', applies: false, required: false, status: 'not-needed' },
    ] }))
    assert.equal((await check('0.1.1-rc.2')).outcome, 'pass')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
