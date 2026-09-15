import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideOpenPullRequest, decideWatch, describeWatchDecision } from '../../src/watch/gate.ts'

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

test('an open migrate pull request blocks a run that would open a second one', () => {
  const previous = {
    tag: 'dsh-v0.1.5',
    version: '0.1.5',
    recordedAt: '2026-09-14T00:00:00Z',
    pending: { tag: 'dsh-v0.1.6', version: '0.1.6', pr: 12 },
  }
  const blocked = decideOpenPullRequest({ previous, allowSecond: false, mechanicalOnly: false })
  assert.equal(blocked.action, 'skip')
  assert.match(blocked.action === 'skip' ? blocked.reason : '', /#12 is open/)
  // The tag that the second run would move past is named, because the state
  // holds one pending row and the first pull request's would be overwritten.
  assert.equal(blocked.action === 'skip' ? blocked.pending.pr : 0, 12)

  // The override is its own input, and it says what it costs.
  const forced = decideOpenPullRequest({ previous, allowSecond: true, mechanicalOnly: false })
  assert.equal(forced.action, 'proceed')
  assert.match(forced.action === 'proceed' ? forced.note ?? '' : '', /will open a second one/)

  // Nothing to publish, nothing to block.
  assert.equal(decideOpenPullRequest({ previous, allowSecond: false, mechanicalOnly: true }).action, 'proceed')
  const { pending: _open, ...settled } = previous
  assert.equal(decideOpenPullRequest({ previous: settled, allowSecond: false, mechanicalOnly: false }).action, 'proceed')
  assert.equal(decideOpenPullRequest({ previous: undefined, allowSecond: false, mechanicalOnly: false }).action, 'proceed')
})

test('a tag from the state branch cannot add a line to what the runner reads', () => {
  // A log line is written to stdout unprefixed, so a newline in a tag read back
  // out of `seen.json` would start a line at column 0 — where the Actions runner
  // parses workflow commands.
  const poisoned = { tag: 'dsh-v0.1.5\n::add-mask::not-a-secret', version: '0.1.5', recordedAt: '2026-01-01T00:00:00.000Z' }
  const skip = decideWatch({
    watchEnabled: true,
    force: false,
    mechanicalOnly: false,
    current: { tag: 'dsh-v0.1.5\n::add-mask::not-a-secret', version: '0.1.5' },
    previous: poisoned,
  })
  assert.equal(skip.action, 'skip')
  const message = describeWatchDecision(skip, { tag: 'dsh-v0.1.5\n::add-mask::not-a-secret', version: '0.1.5' })
  assert.equal(message.split('\n').length, 1)
  assert.equal(message.includes('::add-mask::\n'), false)
  assert.match(message, /dsh-v0\.1\.5 ::add-mask::not-a-secret/)

  // Every branch that names the version, not only the one an unchanged version
  // takes: the first-run line is what every new install logs.
  const next = { tag: 'dsh-v0.1.6\n::add-mask::forged', version: '0.1.6' }
  const branches = [
    decideWatch({ watchEnabled: true, force: false, mechanicalOnly: false, current: next, previous: undefined }),
    decideWatch({ watchEnabled: true, force: false, mechanicalOnly: false, current: next, previous }),
    decideWatch({ watchEnabled: true, force: true, mechanicalOnly: false, current: next, previous }),
    decideWatch({ watchEnabled: false, force: false, mechanicalOnly: false, current: next, previous }),
  ]
  for (const decision of branches) {
    const line = describeWatchDecision(decision, next)
    assert.equal(line.split('\n').length, 1, `${decision.reason} forged a line: ${JSON.stringify(line)}`)
    assert.equal(line.startsWith('::'), false, `${decision.reason} starts with a workflow command`)
  }
})

test('a merge report does not let a tag from the state branch rewrite the line', async () => {
  const { reconcilePendingState } = await import('../../src/watch/sync.ts')
  const lines: string[] = []
  const state = {
    tag: 'dsh-v0.1.5',
    version: '0.1.5',
    recordedAt: '2026-01-01T00:00:00.000Z',
    pending: { tag: 'dsh-v0.1.5\n::set-env name=PATH::/tmp', version: '0.1.5', pr: 12 },
  }
  await reconcilePendingState(
    process.cwd(),
    state,
    'ghs_token',
    (message: string) => lines.push(message),
    async () => new Response(JSON.stringify({ state: 'closed', merged: true, merged_at: '2026-01-02T00:00:00Z' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.split('\n').length, 1)
  assert.match(lines[0] ?? '', /verified dsh-v0\.1\.5 ::set-env name=PATH::\/tmp/)
})
