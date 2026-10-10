import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMechanicalErrors } from '../../src/mechanical/errors.ts'

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
