import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMechanicalErrors } from '../../src/mechanical/errors.ts'
import { assembleFixPrompt } from '../../src/prompts/defaults.ts'

test('keeps error lines and drops passing noise', () => {
  const excerpt = extractMechanicalErrors([
    'ok 1 fixture stays green',
    'error TS2322: Type string is not assignable',
    '    at Object.<anonymous> (test.js:3:1)',
    'All tests passed',
  ].join('\n'))
  assert.match(excerpt, /error TS2322/)
  assert.doesNotMatch(excerpt, /All tests passed/)
})

test('fix prompt includes A+B, errors only, and prior C reports', () => {
  const prompt = assembleFixPrompt({
    template: 'FIX',
    reportA: 'verdict: shrink',
    reportB: 'use official slot',
    errors: 'error: keyed slot missing key',
    priorFixes: ['touched client.js'],
  })
  assert.match(prompt, /verdict: shrink/)
  assert.match(prompt, /use official slot/)
  assert.match(prompt, /keyed slot missing key/)
  assert.match(prompt, /### C1/)
  assert.doesNotMatch(prompt, /full test log/)
})

test('fix prompt can append a harness checkout note', () => {
  const prompt = assembleFixPrompt({
    template: 'FIX',
    reportA: 'A',
    reportB: 'B',
    errors: 'error: x',
    priorFixes: [],
    harness: { path: '/tmp/harness', tag: 'dsh-v0.1.1-rc.2' },
  })
  assert.match(prompt, /\/tmp\/harness/)
  assert.match(prompt, /dsh-v0\.1\.1-rc\.2/)
  assert.match(prompt, /README/)
  assert.match(prompt, /official extension points/)
  assert.match(prompt, /patches\/ directory/)
  assert.match(prompt, /\.dsh-migrate\/patch-reports\//)
  assert.match(prompt, /deepseek-ai\/deepseek-harness/)
  assert.match(prompt, /\[Feature request\]/)
})

test('first fix has no prior C reports', () => {
  const prompt = assembleFixPrompt({
    template: 'FIX',
    reportA: 'A',
    reportB: 'B',
    errors: 'error: x',
    priorFixes: [],
  })
  assert.match(prompt, /this is C1/)
})
