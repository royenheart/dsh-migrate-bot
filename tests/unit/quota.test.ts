import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDeepseekBalance } from '../../src/quota/deepseek.ts'
import { createQuotaQuery } from '../../src/quota/query.ts'
import { decideQuota } from '../../src/quota/check.ts'
import { DEEPSEEK_BALANCE_FIXTURES } from '../fixtures/quota-balance.ts'

test('parses official DeepSeek balance: available CNY', () => {
  const fixture = DEEPSEEK_BALANCE_FIXTURES.availableCny
  const snapshot = parseDeepseekBalance(fixture.body, {
    provider: 'deepseek-official',
    queriedAt: fixture.queriedAt,
  })
  assert.deepEqual(snapshot, {
    kind: 'available',
    provider: 'deepseek-official',
    queriedAt: '2026-08-17T02:30:00.000Z',
    remaining: 12.5,
    currency: 'CNY',
    granted: 2,
    toppedUp: 10.5,
  })
})

test('parses official DeepSeek balance: insufficient', () => {
  const fixture = DEEPSEEK_BALANCE_FIXTURES.insufficient
  const snapshot = parseDeepseekBalance(fixture.body, {
    provider: 'deepseek-official',
    queriedAt: fixture.queriedAt,
  })
  assert.equal(snapshot.kind, 'unavailable')
  assert.equal(snapshot.remaining, 0)
  const decision = decideQuota({ snapshot })
  assert.equal(decision.action, 'abort')
  assert.equal(decision.reason, 'insufficient_balance')
  assert.match(decision.message, /insufficient balance/)
})

test('parses official DeepSeek balance: USD wallet', () => {
  const fixture = DEEPSEEK_BALANCE_FIXTURES.availableUsd
  const snapshot = parseDeepseekBalance(fixture.body, {
    provider: 'deepseek-official',
    queriedAt: fixture.queriedAt,
  })
  assert.equal(snapshot.kind, 'available')
  assert.equal(snapshot.currency, 'USD')
  assert.equal(snapshot.remaining, 3)
})

test('quota.limit is this Action run\'s official USD estimate, not account-wide spend', () => {
  const snapshot = parseDeepseekBalance(DEEPSEEK_BALANCE_FIXTURES.availableCny.body, {
    provider: 'deepseek-official',
    queriedAt: DEEPSEEK_BALANCE_FIXTURES.availableCny.queriedAt,
  })
  const over = decideQuota({ snapshot, used: 0.02, limit: 0.01 })
  assert.equal(over.action, 'abort')
  assert.equal(over.reason, 'limit_exceeded')
  assert.equal(over.spent, 0.02)
  const under = decideQuota({ snapshot, used: 0.008, limit: 0.01 })
  assert.equal(under.action, 'continue')
  assert.equal(under.spent, 0.008)
})

test('createQuotaQuery uses the official balance URL for deepseek-official', async () => {
  const fixture = DEEPSEEK_BALANCE_FIXTURES.lowRemaining
  let url = ''
  let auth = ''
  const query = createQuotaQuery({
    provider: 'deepseek-official',
    fetchImpl: async (input, init) => {
      url = String(input)
      auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
      return new Response(JSON.stringify(fixture.body), { status: 200 })
    },
  })
  const snapshot = await query.query({
    apiKey: 'sk-test',
    now: new Date(fixture.queriedAt),
  })
  assert.equal(url, 'https://api.deepseek.com/user/balance')
  assert.equal(auth, 'Bearer sk-test')
  assert.equal(snapshot.kind, 'available')
  assert.equal(snapshot.remaining, 1.2)
  assert.equal(snapshot.queriedAt, fixture.queriedAt)
})

test('non-DeepSeek providers are unimplemented', async () => {
  const query = createQuotaQuery({
    provider: 'openai',
    fetchImpl: async () => {
      throw new Error('must not call a network')
    },
  })
  const snapshot = await query.query({ apiKey: 'x', now: new Date('2026-08-17T00:00:00.000Z') })
  assert.equal(snapshot.kind, 'unimplemented')
  assert.equal(snapshot.provider, 'openai')
  const decision = decideQuota({ snapshot, limit: 1 })
  assert.equal(decision.action, 'continue')
})

test('HTTP failure on the official balance API is a query error', async () => {
  const query = createQuotaQuery({
    provider: 'deepseek-official',
    fetchImpl: async () => new Response('nope', { status: 401 }),
  })
  await assert.rejects(() => query.query({ apiKey: 'bad' }), /HTTP 401/)
})
