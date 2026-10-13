import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { z } from 'zod'
import { inline } from '../render/text.ts'

/**
 * The upgrade skill's change cards, and the ledger a migration keeps of them.
 *
 * Each release file of the skill (`references/v<version>.md`) lists the
 * changes that release made a plugin face, one card per change:
 *
 *     ### DSH-0.1.2-A1-10 · New capability: support for registering third-party languages
 *
 *     - **Type**: capability
 *     - **Action level**: optional
 *     - **Migration recipe**: Replace custom i18n patches with …
 *
 * A migration from one release to another crosses every card of the releases
 * after the source up to the target. The reviews record, card by card, whether
 * it applies to the plugin, whether it must be done, and where it was; the
 * cards check holds the tree to that ledger. A plugin without tests of its own
 * otherwise has nothing that says a breaking change was left undone.
 */

export interface Card {
  id: string
  title: string
  /** The release whose file lists the card. */
  release: string
  type: string
  level: string
  appliesTo: string
  recipe: string
}

const CARD_HEADING = /^### (DSH-\S+) · (.+)$/
const CARD_FIELD = /^- \*\*([^*]+)\*\*: *(.*)$/
const RELEASE_FILE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.md$/

/** The cards of one release file. */
export function parseCards(text: string, release: string): Card[] {
  const cards: Card[] = []
  let current: { id: string; title: string; fields: Map<string, string> } | undefined
  const close = (): void => {
    if (current === undefined) return
    const field = (name: string): string => current?.fields.get(name) ?? ''
    cards.push({ id: current.id, title: current.title, release, type: field('Type'), level: field('Action level'), appliesTo: field('Applies to'), recipe: field('Migration recipe') })
  }
  for (const line of text.split('\n')) {
    const heading = CARD_HEADING.exec(line)
    if (heading !== null) {
      close()
      current = { id: heading[1] ?? '', title: (heading[2] ?? '').trim(), fields: new Map() }
      continue
    }
    if (line.startsWith('## ') || line.startsWith('### ')) {
      close()
      current = undefined
      continue
    }
    const field = CARD_FIELD.exec(line)
    if (current !== undefined && field !== null && !current.fields.has(field[1] ?? '')) current.fields.set(field[1] ?? '', (field[2] ?? '').trim())
  }
  close()
  return cards
}

/**
 * The cards a migration from `source` to `target` crosses: every release file
 * after the source, up to and including the target, in release order.
 * @param references - the skill's `references/` directory
 */
export function cardsInSpan(references: string, source: string, target: string): Card[] {
  if (!existsSync(references)) return []
  return readdirSync(references)
    .flatMap(name => {
      const release = RELEASE_FILE.exec(name)?.[1]
      return release !== undefined && semver.gt(release, source) && semver.lte(release, target) ? [release] : []
    })
    .sort(semver.compare)
    .flatMap(release => parseCards(readFileSync(join(references, `v${release}.md`), 'utf8'), release))
}

/** Where a run keeps its ledger: the run directory, which is never part of the tree. */
export const ledgerPathOf = (runDir: string): string => join(runDir, 'cards.json')

/** The cards, one line each, for a prompt or a failing check's output. */
export function renderCardList(cards: readonly Card[]): string {
  return cards.map(card => `- ${card.id} · ${inline(card.title, 160)} [${card.type}; ${card.level}] Applies to: ${inline(card.appliesTo, 200)} Recipe: ${inline(card.recipe, 300)}`).join('\n')
}

export const CARD_STATUSES = ['done', 'not-needed', 'open'] as const

export const ledgerSchema = z.strictObject({
  cards: z.array(z.strictObject({
    id: z.string(),
    applies: z.boolean().describe('Whether the change touches this plugin.'),
    required: z.boolean().describe('Whether this migration must act on it.'),
    status: z.enum(CARD_STATUSES),
    evidence: z.array(z.string()).describe('Where it was done: tree-relative paths, optionally `path:line`.'),
    note: z.string(),
  })),
})
export type CardLedger = z.infer<typeof ledgerSchema>

/** One way the ledger falls short of the tree. */
export interface LedgerProblem {
  id: string
  problem: string
}

/**
 * Hold a ledger to the cards it must cover and the tree it describes: every
 * card is accounted for, a required card is done, and what a done card
 * points to exists.
 */
export function checkLedger(cards: readonly Card[], ledger: CardLedger, exists: (path: string) => boolean): LedgerProblem[] {
  const entries = new Map(ledger.cards.map(entry => [entry.id, entry]))
  return cards.flatMap((card): LedgerProblem[] => {
    const entry = entries.get(card.id)
    if (entry === undefined) return [{ id: card.id, problem: 'not in the ledger' }]
    if (entry.required && !entry.applies) return [{ id: card.id, problem: 'required although it does not apply' }]
    if (entry.required && entry.status !== 'done') return [{ id: card.id, problem: `required and ${entry.status}` }]
    if (entry.status !== 'done') return []
    if (entry.evidence.length === 0) return [{ id: card.id, problem: 'done without evidence' }]
    const missing = entry.evidence.filter(path => !exists(path.replace(/:\d+(?::\d+)?$/, '')))
    return missing.length === 0 ? [] : [{ id: card.id, problem: `evidence not in the tree: ${missing.join(', ')}` }]
  })
}
