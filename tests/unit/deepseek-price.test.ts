import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isDeepseekPeak,
  modelForPricing,
  priceDeepseekUsage,
  priceDeepseekUsageDetailed,
  ratesForModel,
} from '../../src/quota/deepseek-price.ts'
import { summarizeSessionEvents } from '../../src/agents/session-status.ts'
import { SESSION_USAGE_FIXTURES } from '../fixtures/session-usage.ts'

test('official peak window is weekday UTC 01:00-04:00 and 06:00-10:00', () => {
  assert.equal(isDeepseekPeak(new Date('2026-08-17T02:30:00.000Z')), true)
  assert.equal(isDeepseekPeak(new Date('2026-08-17T18:15:00.000Z')), false)
  assert.equal(isDeepseekPeak(new Date('2026-08-18T07:00:00.000Z')), true)
  assert.equal(isDeepseekPeak(new Date('2026-08-16T02:30:00.000Z')), false)
})

test('V4 Pro prices this-run samples at official peak/off-peak rates', () => {
  const peak = priceDeepseekUsage([
    { time: Date.parse('2026-08-17T10:30:00+08:00'), cacheMissTokens: 8000, cacheHitTokens: 2000, outputTokens: 400 },
  ], 'deepseek-v4-pro')
  assert.equal(peak, 8000 / 1e6 * 1.32 + 2000 / 1e6 * 0.044 + 400 / 1e6 * 3.96)

  const offPeak = priceDeepseekUsage([
    { time: Date.parse('2026-08-18T02:15:00+08:00'), cacheMissTokens: 500, cacheHitTokens: 12_000, outputTokens: 150 },
  ], 'deepseek-v4-pro')
  assert.equal(offPeak, 500 / 1e6 * 0.66 + 12_000 / 1e6 * 0.022 + 150 / 1e6 * 1.98)
})

test('session fixtures price as V4 Pro using event timestamps', () => {
  const peak = summarizeSessionEvents(SESSION_USAGE_FIXTURES.peakMissHeavy.events, 20, {
    model: 'deepseek-v4-pro',
  })
  const off = summarizeSessionEvents(SESSION_USAGE_FIXTURES.offPeakHitHeavy.events, 40, {
    model: 'deepseek-v4-pro',
  })
  const miss = summarizeSessionEvents(SESSION_USAGE_FIXTURES.missOnlyNoCacheFields.events, 12, {
    model: 'deepseek-v4-pro',
  })
  assert.equal(peak.costUsd, 8000 / 1e6 * 1.32 + 2000 / 1e6 * 0.044 + 400 / 1e6 * 3.96)
  assert.equal(off.costUsd, 500 / 1e6 * 0.66 + 12_000 / 1e6 * 0.022 + 150 / 1e6 * 1.98)
  assert.equal(miss.costUsd, 300 / 1e6 * 1.32 + 80 / 1e6 * 3.96)
})

test('unknown model has no published rate', () => {
  assert.equal(priceDeepseekUsage([
    { time: Date.parse('2026-08-17T10:30:00+08:00'), cacheMissTokens: 1, cacheHitTokens: 0, outputTokens: 1 },
  ], 'some-other-model'), undefined)
})

test('the vendored table carries the 2026-09-12 prices, not the retired ones', () => {
  const flash = ratesForModel('deepseek-flash')
  assert.deepEqual(flash, {
    cacheHit: { offPeak: 0.003, peak: 0.006 },
    cacheMiss: { offPeak: 0.15, peak: 0.3 },
    output: { offPeak: 0.6, peak: 1.2 },
  })
  // The retired alias routes to the current model and is billed at its rates.
  assert.deepEqual(ratesForModel('deepseek-v4-flash'), flash)
  assert.deepEqual(ratesForModel('deepseek-v4-flash-vision-exp'), flash)
})

test('the served model wins over the requested alias', () => {
  // DeepSeek answers `deepseek-v4-flash` with `model: deepseek-flash`.
  assert.equal(modelForPricing('deepseek-v4-flash', 'deepseek-flash'), 'deepseek-flash')
  assert.equal(modelForPricing('deepseek-v4-flash'), 'deepseek-v4-flash')
})

test('a dated routing override prices V4 Pro as Flash from 2026-09-14', () => {
  const before = new Date('2026-09-13T12:00:00Z')
  const after = new Date('2026-09-14T12:00:00Z')
  assert.equal(modelForPricing('deepseek-v4-pro', undefined, before), 'deepseek-v4-pro')
  assert.equal(modelForPricing('deepseek-v4-pro', undefined, after), 'deepseek-flash')
  // A served id still wins over the routing rule.
  assert.equal(modelForPricing('deepseek-v4-pro', 'deepseek-v4-pro', after), 'deepseek-v4-pro')
})

test('cost reporting names the table and its age instead of a bare number', () => {
  const rates = ratesForModel('deepseek-flash')
  assert.ok(rates)
  const now = new Date('2026-09-20T12:00:00Z')
  const priced = priceDeepseekUsageDetailed(
    [{ time: Date.parse('2026-09-20T12:00:00Z'), cacheMissTokens: 1_000_000, cacheHitTokens: 0, outputTokens: 0 }],
    'deepseek-flash',
    { now },
  )
  assert.equal(priced.status, 'ok')
  assert.equal(priced.model, 'deepseek-flash')
  assert.equal(priced.tableFetchedAt, '2026-09-12')
  assert.equal(priced.tableAgeDays, 8)
  assert.equal(priced.tier, 'off-peak')
  // 12:00 UTC is off-peak: one million cache-miss tokens at 0.15.
  assert.equal(priced.usd, 0.15)

  // A run recorded long after the snapshot was taken reports it as stale, and
  // still prices the requests it actually made.
  const stale = priceDeepseekUsageDetailed(
    [{ time: Date.parse('2026-09-20T12:00:00Z'), cacheMissTokens: 1_000_000, cacheHitTokens: 0, outputTokens: 0 }],
    'deepseek-flash',
    { now: new Date('2026-10-30T00:00:00Z') },
  )
  assert.equal(stale.status, 'stale-table')
  assert.match(stale.detail, /re-check/)
  assert.equal(stale.usd, 0.15)

  // Nothing to price is not the same as a model with no rate.
  const empty = priceDeepseekUsageDetailed([], 'deepseek-flash', { now: new Date('2026-09-20T00:00:00Z') })
  assert.equal(empty.status, 'ok')
  assert.equal(empty.usd, 0)
})

test('an unknown model reports unknown-model rather than a zero cost', () => {
  const priced = priceDeepseekUsageDetailed([], 'some-other-model')
  assert.equal(priced.status, 'unknown-model')
  assert.equal(priced.usd, undefined)
  assert.equal(priceDeepseekUsage([], 'some-other-model'), undefined)
})
