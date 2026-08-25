import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideWatch, describeWatchDecision } from '../../src/watch/gate.ts'

const current = { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' }
const previous = { tag: 'dsh-v0.1.0-rc.8', version: '0.1.0-rc.8', recordedAt: '2026-01-01T00:00:00.000Z' }

test('first run with no saved state proceeds', () => {
  const decision = decideWatch({
    watchEnabled: true,
    force: false,
    mechanicalOnly: false,
    current,
    previous: undefined,
  })
  assert.deepEqual(decision, { action: 'run', reason: 'first-run' })
  assert.match(describeWatchDecision(decision, current), /first run/)
})

test('same dsh version is skipped', () => {
  const decision = decideWatch({
    watchEnabled: true,
    force: false,
    mechanicalOnly: false,
    current,
    previous: { ...previous, tag: current.tag, version: current.version },
  })
  assert.equal(decision.action, 'skip')
  if (decision.action === 'skip') {
    assert.equal(decision.reason, 'unchanged')
    assert.equal(decision.previous.version, current.version)
  }
  assert.match(describeWatchDecision(decision, current), /unchanged/)
})

test('a newer dsh version proceeds', () => {
  const decision = decideWatch({
    watchEnabled: true,
    force: false,
    mechanicalOnly: false,
    current,
    previous,
  })
  assert.deepEqual(decision, { action: 'run', reason: 'updated' })
})

test('force and mechanical-only bypass the unchanged gate', () => {
  const same = { ...previous, tag: current.tag, version: current.version }
  assert.equal(decideWatch({
    watchEnabled: true,
    force: true,
    mechanicalOnly: false,
    current,
    previous: same,
  }).reason, 'forced')
  assert.equal(decideWatch({
    watchEnabled: true,
    force: false,
    mechanicalOnly: true,
    current,
    previous: same,
  }).reason, 'mechanical-only')
  assert.equal(decideWatch({
    watchEnabled: false,
    force: false,
    mechanicalOnly: false,
    current,
    previous: same,
  }).reason, 'watch-disabled')
})
