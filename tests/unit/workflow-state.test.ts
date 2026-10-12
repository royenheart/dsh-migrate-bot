import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideStart } from '../../src/workflow/start.ts'
import { badgeOf } from '../../src/workflow/badge.ts'
import { input, logOf, proposal, proposedEvents, projectionOf, settings } from '../support/migration.ts'
import type { MigrationEvent } from '../../src/workflow/model.ts'

const compatible: MigrationEvent[] = [
  { type: 'check.done', result: { check: 'mechanical', outcome: 'pass', fingerprint: '', detail: '' } },
  { type: 'tree.inspected', changed: false, files: 0 },
]
const merged = (number: number): MigrationEvent => ({ type: 'pull-request.closed', number, merged: true })
const release = (version: string) => ({ tag: `dsh-v${version}`, version })

test('the projection derives processed, verified and the open proposal from the logs', () => {
  const projection = projectionOf({
    '0.1.6': logOf(input('0.1.6'), compatible),
    '0.1.7': logOf(input('0.1.7'), [...proposedEvents(proposal(5)), merged(5)]),
    '0.2.0': logOf(input('0.2.0'), proposedEvents(proposal(9))),
    '0.2.1': logOf(input('0.2.1'), [{ type: 'activity.error', activity: 'check', detail: 'npm down' }]),
  })
  assert.deepEqual(projection.migrations.map(view => `${view.id}:${view.state}`), ['0.2.1:error', '0.2.0:awaitingMerge', '0.1.7:accepted', '0.1.6:compatible'])
  // An error is not processed: the next scheduled run retries that release.
  assert.equal(projection.processed?.id, '0.2.0')
  assert.equal(projection.verified?.version, '0.1.7')
  assert.equal(projection.open?.context.proposal?.pullRequest.number, 9)
})

test('I2 a release is verified only by a compatible migration or a merged proposal', () => {
  const projection = projectionOf({
    '0.2.0': logOf(input('0.2.0'), [...proposedEvents(proposal(9)), { type: 'pull-request.closed', number: 9, merged: false }]),
    '0.1.0': logOf(input('0.1.0'), proposedEvents(proposal(3))),
  })
  assert.equal(projection.verified, undefined)
  assert.equal(projection.processed?.state, 'rejected')
})

test('an unchanged target release is skipped unless the run is forced', () => {
  const projection = projectionOf({ '0.2.0': logOf(input('0.2.0'), compatible) })
  const skipped = decideStart({ target: release('0.2.0'), projection, force: false, maintainerCommits: 0 })
  assert.equal(skipped.action, 'skip')
  assert.equal(skipped.action === 'skip' && skipped.reason, 'unchanged-release')
  assert.deepEqual(decideStart({ target: release('0.2.0'), projection, force: true, maintainerCommits: 0 }), { action: 'start' })
  assert.deepEqual(decideStart({ target: release('0.2.1'), projection, force: false, maintainerCommits: 0 }), { action: 'start' })
})

test('I1 a new release takes over the open proposal instead of opening a second one', () => {
  const open = proposal(9)
  const projection = projectionOf({ '0.2.0': logOf(input('0.2.0'), proposedEvents(open)) })
  assert.deepEqual(decideStart({ target: release('0.2.1'), projection, force: false, maintainerCommits: 0 }), {
    action: 'start',
    proposal: open,
    supersedes: '0.2.0',
  })
  // A forced re-run of the same release keeps the proposal and supersedes nothing.
  assert.deepEqual(decideStart({ target: release('0.2.0'), projection, force: true, maintainerCommits: 0 }), { action: 'start', proposal: open })
})

test('a proposal with maintainer commits is never taken over', () => {
  const projection = projectionOf({ '0.2.0': logOf(input('0.2.0'), proposedEvents(proposal(9))) })
  const decision = decideStart({ target: release('0.2.1'), projection, force: false, maintainerCommits: 2 })
  assert.equal(decision.action === 'skip' && decision.reason, 'proposal-has-maintainer-commits')
})

test('the badge shows the verified release and what happened to a newer one', () => {
  assert.deepEqual(badgeOf(projectionOf({})), { schemaVersion: 1, label: 'dsh', message: 'unverified', color: 'lightgrey' })
  assert.equal(badgeOf(projectionOf({ '0.2.0': logOf(input('0.2.0'), compatible) })).message, 'dsh-v0.2.0')
  const proposed = badgeOf(projectionOf({
    '0.1.7': logOf(input('0.1.7'), compatible),
    '0.2.0': logOf(input('0.2.0'), proposedEvents()),
  }))
  assert.deepEqual([proposed.message, proposed.color], ['dsh-v0.1.7 | dsh-v0.2.0 proposed', 'yellow'])
})

test('the end-to-end suite is published after the proposal, which stays open meanwhile', () => {
  const withSuite = input('0.2.0', { settings: settings({ checks: { boot: false, web: false, e2e: true } }) })
  const proposed = proposedEvents(proposal(9)).map(event => event.type === 'check.done' && event.result.outcome === 'pass'
    ? [event, { type: 'check.done' as const, result: { check: 'e2e' as const, outcome: 'pass' as const, fingerprint: '', detail: '' } }]
    : [event]).flat()
  const publishing = projectionOf({ '0.2.0': logOf(withSuite, proposed) })
  assert.equal(publishing.migrations[0]?.state, 'publishingE2E')
  assert.equal(publishing.open?.context.proposal?.pullRequest.number, 9)
  const settled = projectionOf({ '0.2.0': logOf(withSuite, [...proposed, { type: 'e2e.published', outcome: 'failed', detail: 'push refused' }]) })
  assert.equal(settled.migrations[0]?.state, 'awaitingMerge')
  assert.deepEqual(settled.migrations[0]?.context.warnings, ['end-to-end suite not updated: push refused'])
})
