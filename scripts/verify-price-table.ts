/**
 * Gate: the compiled price table and its data home agree.
 *
 * `pricing/deepseek.json` is the home for the published rates: the Python
 * benchmark summarizer reads it to price a recorded run, and the TypeScript
 * runtime keeps the same numbers compiled in so a run needs no file read. Two
 * copies of one fact drift, so this gate compares them field by field and also
 * reports the snapshot's age, which is the number a reader needs to judge any
 * cost derived from it.
 *
 * The gate is deliberately quiet about age: an old table is a warning a reader
 * should see in the record, not a build failure. What fails the build is the
 * table disagreeing with itself.
 */

import { resolve } from 'node:path'
import { readText, REPO_ROOT } from './repo.ts'
import {
  DEEPSEEK_RATES,
  DEEPSEEK_ROUTE_OVERRIDES,
  PRICE_TABLE_FETCHED_AT,
  PRICE_TABLE_SOURCE,
  priceTableAgeDays,
} from '../src/quota/deepseek-price.ts'

/** The data home for the published rates. */
export const PRICE_TABLE_PATH = 'pricing/deepseek.json'

/** One defect in the table. */
export interface PriceViolation {
  detail: string
}

interface RateRow {
  cacheHit: { offPeak: number; peak: number }
  cacheMiss: { offPeak: number; peak: number }
  output: { offPeak: number; peak: number }
}

/**
 * Compare the data file with the runtime table.
 * @returns one entry per disagreement, and the snapshot's age in days.
 */
export function verifyPriceTable(): { violations: PriceViolation[]; ageDays: number } {
  const violations: PriceViolation[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(readText(resolve(REPO_ROOT, PRICE_TABLE_PATH)))
  } catch (error) {
    return {
      violations: [{ detail: `${PRICE_TABLE_PATH} is unreadable: ${error instanceof Error ? error.message : String(error)}` }],
      ageDays: 0,
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { violations: [{ detail: `${PRICE_TABLE_PATH} must be a JSON object` }], ageDays: 0 }
  }
  const table = parsed as {
    source?: unknown
    fetchedAt?: unknown
    models?: unknown
    routeOverrides?: unknown
  }
  if (table.source !== PRICE_TABLE_SOURCE) {
    violations.push({ detail: `pricing source is ${String(table.source)}, runtime says ${PRICE_TABLE_SOURCE}` })
  }
  if (table.fetchedAt !== PRICE_TABLE_FETCHED_AT) {
    violations.push({ detail: `pricing fetchedAt is ${String(table.fetchedAt)}, runtime says ${PRICE_TABLE_FETCHED_AT}` })
  }

  const models = typeof table.models === 'object' && table.models !== null
    ? (table.models as Record<string, Partial<RateRow>>)
    : {}
  for (const [id, rates] of Object.entries(DEEPSEEK_RATES)) {
    const file = models[id]
    if (file === undefined) {
      violations.push({ detail: `${PRICE_TABLE_PATH} has no entry for \`${id}\`` })
      continue
    }
    for (const field of ['cacheHit', 'cacheMiss', 'output'] as const) {
      const fromFile = file[field]
      if (fromFile === undefined || fromFile.offPeak !== rates[field].offPeak || fromFile.peak !== rates[field].peak) {
        violations.push({
          detail: `${id}.${field} differs: file ${JSON.stringify(fromFile ?? null)} vs runtime ${JSON.stringify(rates[field])}`,
        })
      }
    }
  }
  for (const id of Object.keys(models)) {
    if (!(id in DEEPSEEK_RATES)) {
      violations.push({ detail: `${PRICE_TABLE_PATH} lists \`${id}\`, which the runtime table does not price` })
    }
  }

  const overrides = Array.isArray(table.routeOverrides) ? table.routeOverrides : []
  if (overrides.length !== DEEPSEEK_ROUTE_OVERRIDES.length) {
    violations.push({
      detail: `${PRICE_TABLE_PATH} declares ${String(overrides.length)} route override(s), runtime has ${String(DEEPSEEK_ROUTE_OVERRIDES.length)}`,
    })
  }
  return { violations, ageDays: priceTableAgeDays() }
}

if (import.meta.filename === process.argv[1]) {
  const { violations, ageDays } = verifyPriceTable()
  if (violations.length > 0) {
    console.error('verify-price-table: the price table disagrees with its data home:')
    for (const violation of violations) console.error(`  ${violation.detail}`)
    process.exit(1)
  }
  console.log(`verify-price-table: pricing/deepseek.json and the runtime table agree (${String(ageDays)} days old).`)
}
