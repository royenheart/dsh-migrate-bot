import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySelfTest } from '../../src/agents/self-test.ts'

const MISSING = 'dsh-migrate: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"'

test('a session that stops at the credential check passes', () => {
  assert.equal(classifySelfTest({ code: 1, stdout: '', stderr: MISSING }).ok, true)
})

test('a profile entry that fails to import fails the self-test', () => {
  const stderr = `dsh: warning: 1 entry did not activate\nagent-presets: failed to import\n${MISSING}`
  const result = classifySelfTest({ code: 1, stdout: '', stderr })
  assert.equal(result.ok, false)
  assert.match(result.detail, /did not activate/)
})

test('a runtime that crashes before the session fails the self-test', () => {
  // The 2026-09-29 outage: a transitive release removed a service the profile needs.
  const stderr = 'Error: dsh: user patch-layer watching requires the Cordis HMR service'
  const result = classifySelfTest({ code: 1, stdout: '', stderr })
  assert.equal(result.ok, false)
  assert.match(result.detail, /credential check/)
})
