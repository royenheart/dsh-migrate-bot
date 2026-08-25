import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepseekPeak, priceDeepseekUsage } from '../../src/quota/deepseek-price.ts'
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
