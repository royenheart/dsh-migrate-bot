import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorSummary, extractMechanicalErrors } from '../../src/mechanical/errors.ts'

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

test('npm errors are kept, and the summary names the packages in conflict rather than a warning', () => {
  // Shape of npm 11's output for the un-migrated dsh-router fixture.
  const output = [
    'npm warn ERESOLVE overriding peer dependency',
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
    'npm error',
    'npm error While resolving: dsh-router-core@0.4.2',
    'npm error Found: @deepseek-ai/schemastery@3.18.4',
  ].join('\n')
  const errors = extractMechanicalErrors(output)
  assert.doesNotMatch(errors, /npm warn/)
  assert.equal(errorSummary(errors), 'npm error ERESOLVE unable to resolve dependency tree | npm error While resolving: dsh-router-core@0.4.2 | npm error Found: @deepseek-ai/schemastery@3.18.4')
})
