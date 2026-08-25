import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeStatusLine,
  encodeStatusLine,
  formatSessionProgress,
  isInsufficientBalanceText,
  summarizeSessionEvents,
  usageUnits,
} from '../../src/agents/session-status.ts'
import { SESSION_USAGE_FIXTURES } from '../fixtures/session-usage.ts'

for (const fixture of Object.values(SESSION_USAGE_FIXTURES)) {
  test(`session status: ${fixture.name} at ${fixture.time}`, () => {
    const progress = summarizeSessionEvents(fixture.events, 48)
    assert.equal(progress.turns, fixture.expected.turns)
    assert.equal(progress.steps, fixture.expected.steps)
    assert.equal(progress.inputTokens, fixture.expected.inputTokens)
    assert.equal(progress.outputTokens, fixture.expected.outputTokens)
    assert.equal(progress.cacheHitTokens, fixture.expected.cacheHitTokens)
    assert.equal(progress.cacheMissTokens, fixture.expected.cacheMissTokens)
    assert.equal(progress.elapsedSeconds, 48)
  })
}

test('sums two DeepSeek-shaped steps without reading message text', () => {
  const events = [
    ...SESSION_USAGE_FIXTURES.peakMissHeavy.events,
    ...SESSION_USAGE_FIXTURES.offPeakHitHeavy.events,
  ]
  const progress = summarizeSessionEvents(events, 90)
  assert.equal(progress.turns, 2)
  assert.equal(progress.steps, 2)
  assert.equal(progress.inputTokens, 8500)
  assert.equal(progress.outputTokens, 550)
  assert.equal(progress.cacheHitTokens, 14000)
  assert.equal(progress.cacheMissTokens, 8500)
  const priced = summarizeSessionEvents(events, 90, { model: 'deepseek-v4-pro' })
  assert.match(formatSessionProgress(progress), /2 turns \/ 2 steps \/ 90s/)
  assert.equal(usageUnits(progress), 0)
  assert.ok((priced.costUsd ?? 0) > 0)
  assert.equal(usageUnits(priced), priced.costUsd)
})

test('status line round-trips and ignores assistant text', () => {
  const line = encodeStatusLine({
    turns: 1,
    steps: 2,
    elapsedSeconds: 10,
    inputTokens: 3,
    outputTokens: 4,
    cacheHitTokens: 5,
    cacheMissTokens: 3,
  })
  assert.equal(decodeStatusLine(line)?.steps, 2)
  assert.equal(decodeStatusLine('# secret report\n') , undefined)
})

test('detects official-style insufficient balance wording', () => {
  assert.equal(isInsufficientBalanceText('dsh-migrate: QUOTA: account credits exhausted'), true)
  assert.equal(isInsufficientBalanceText('insufficient_quota'), true)
  assert.equal(isInsufficientBalanceText('HTTP 429: rate limit reached'), false)
})
