import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderStepSummary, statusOf, writeStepSummary } from '../../src/github/summary.ts'
import { input, proposal, proposedEvents, settings, viewOf } from '../support/migration.ts'

test('a proposed migration names its status, the attempts and the proposal', () => {
  const view = viewOf(input(), proposedEvents(proposal(9)))
  assert.equal(statusOf(view.state), 'proposed')
  const summary = renderStepSummary({ view, pluginName: '@acme/plugin', logStreamUrl: 'https://deploy.example/runs/1' })
  assert.match(summary, /^## dsh-migrate: proposed/)
  assert.match(summary, /Repair attempts: 0/)
  assert.match(summary, /Proposal: https:\/\/github\.com\/acme\/plugin\/pull\/9/)
  assert.match(summary, /Run log stream: https:\/\/deploy\.example\/runs\/1/)
})

test('a failed migration names the failing check and why it stopped', () => {
  const view = viewOf(input('0.2.0', { settings: settings({ maxAttempts: 1 }) }), [
    { type: 'check.done', result: { check: 'mechanical', outcome: 'fail', fingerprint: 'mechanical: TS2304', detail: '' } },
    { type: 'session.done', kind: 'overlap', outcome: 'completed', blocker: 'none', detail: '' },
    { type: 'session.done', kind: 'extension-points', outcome: 'completed', blocker: 'none', detail: '' },
    { type: 'check.done', result: { check: 'mechanical', outcome: 'fail', fingerprint: 'mechanical: TS2551', detail: '' } },
    { type: 'session.done', kind: 'repair', outcome: 'completed', blocker: 'none', detail: '' },
    { type: 'check.done', result: { check: 'mechanical', outcome: 'fail', fingerprint: 'mechanical: TS2551 again', detail: '' } },
  ])
  const summary = renderStepSummary({ view, pluginName: 'p' })
  assert.match(summary, /dsh-migrate: failed/)
  assert.match(summary, /stopped: attempt-limit/)
  assert.match(summary, /Failing check: mechanical \(mechanical: TS2551 again\)/)
})

test('a value from outside cannot forge a line of the summary', () => {
  const view = viewOf(input(), proposedEvents())
  const summary = renderStepSummary({ view, pluginName: 'x\n::add-mask::y', logStreamUrl: 'javascript:alert(1)' })
  assert.equal(summary.split('\n').some(line => line.startsWith('::')), false)
  assert.doesNotMatch(summary, /javascript:/)
})

test('the summary is appended to the step summary file, and nothing happens without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-summary-'))
  try {
    const file = join(dir, 'summary.md')
    writeStepSummary('one\n', { GITHUB_STEP_SUMMARY: file })
    writeStepSummary('two\n', { GITHUB_STEP_SUMMARY: file })
    assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\n')
    writeStepSummary('three\n', {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
