import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InJobEngine, type ActivityRunner } from '../../src/engine.ts'
import { BADGE_FILE, logPath, serializeLog, StateStore, STATE_BRANCH } from '../../src/state/store.ts'
import { checkout, type Checkout } from '../support/repository.ts'
import { input, logOf, proposal, proposedEvents, settings } from '../support/migration.ts'
import type { ActivityRequest } from '../../src/workflow/machine.ts'
import type { Proposal } from '../../src/workflow/model.ts'

/** Activities that pass every check, change the tree, and publish the given proposal. */
function scripted(published: Proposal, calls: ActivityRequest[] = []): ActivityRunner {
  return async (request) => {
    calls.push(request)
    switch (request.activity) {
      case 'check':
        return { event: { type: 'check.done', result: { check: request.check, outcome: 'pass', fingerprint: '', detail: '' } } }
      case 'session':
        return {
          event: { type: 'session.done', kind: request.kind, outcome: 'completed', blocker: 'none', detail: '', report: `reports/${request.kind}.md` },
          files: new Map([[`reports/${request.kind}.md`, `# ${request.kind}\n`]]),
        }
      case 'characterize':
        return { event: { type: 'e2e.characterized', outcome: 'skipped', baseline: [], detail: '' } }
      case 'publishE2E':
        return { event: { type: 'e2e.published', outcome: 'unchanged', detail: '' } }
      case 'inspectTree':
        return { event: { type: 'tree.inspected', changed: true, files: 1 } }
      case 'publishProposal':
        return { event: { type: 'proposal.published', proposal: published } }
      case 'deliverReport':
        return { event: { type: 'report.done', channel: request.channel, outcome: 'delivered', detail: '', url: `https://example.test/${request.channel}` } }
    }
  }
}

function engine(repo: Checkout, activities: ActivityRunner, cwd = repo.work): InJobEngine {
  return new InJobEngine({ store: new StateStore(cwd), activities, run: 'test-run', log: () => {}, now: () => new Date('2026-10-10T00:00:00Z') })
}

const always = input('0.2.0', { settings: settings({ reviewPolicy: 'always', reportChannels: ['migrate-bot', 'upgrade-skill'] }) })

test('a migration runs to its proposal and the state branch holds its log, reports and badge', async () => {
  const repo = checkout()
  try {
    const calls: ActivityRequest[] = []
    const view = await engine(repo, scripted(proposal(9), calls)).start('0.2.0', always)
    assert.equal(view.state, 'awaitingMerge')
    assert.deepEqual(calls.map(call => call.activity), ['session', 'session', 'check', 'inspectTree', 'publishProposal'])

    const reader = new StateStore(repo.clone())
    const state = reader.read()
    assert.equal(state.logs.get('0.2.0')?.length, 1 + calls.length)
    assert.equal(reader.readFile('migrations/0.2.0/reports/overlap.md'), '# overlap\n')
    assert.match(reader.readFile(BADGE_FILE) ?? '', /"message": "unverified \| dsh-v0\.2\.0 proposed"/)
    // The log was pushed right after the effect; the final write had nothing new.
    const subjects = repo.git(['log', '--format=%s', STATE_BRANCH], repo.remote).split('\n')
    assert.deepEqual(subjects, ['dsh-migrate: 0.2.0 publishProposal'])
  } finally {
    repo.cleanup()
  }
})

test('a merged proposal is reported to every enabled channel and verifies the release', async () => {
  const repo = checkout()
  try {
    await engine(repo, scripted(proposal(9))).start('0.2.0', always)
    const later = engine(repo, scripted(proposal(9)), repo.clone())
    const view = await later.deliver('0.2.0', { type: 'pull-request.closed', number: 9, merged: true, mergeSha: 'b'.repeat(40) })
    assert.equal(view.state, 'accepted')
    assert.deepEqual(view.context.delivered, ['migrate-bot', 'upgrade-skill'])
    assert.equal(later.status().verified?.tag, 'dsh-v0.2.0')
  } finally {
    repo.cleanup()
  }
})

test('a newer release takes over the open proposal and the old migration ends superseded', async () => {
  const repo = checkout()
  try {
    const first = proposal(9)
    await engine(repo, scripted(first)).start('0.2.0', always)
    const next = engine(repo, scripted(first), repo.clone())
    const view = await next.start('0.2.1', input('0.2.1', { settings: always.settings, proposal: first }), '0.2.0')
    assert.equal(view.state, 'awaitingMerge')
    const status = next.status()
    assert.equal(status.migrations.find(migration => migration.id === '0.2.0')?.state, 'superseded')
    assert.equal(status.open?.id, '0.2.1')
    assert.equal(status.migrations.filter(migration => migration.state === 'awaitingMerge').length, 1)
  } finally {
    repo.cleanup()
  }
})

for (const how of ['without an event', 'on an event its state ignores'] as const) {
  test(`a reporting pass cut short resumes where it stopped, ${how}`, async () => {
    const repo = checkout()
    try {
      const store = new StateStore(repo.work)
      const migration = input('0.2.0', { settings: settings({ reportChannels: ['migrate-bot', 'upgrade-skill'] }) })
      const cut = logOf(migration, [
        ...proposedEvents(proposal(9)),
        { type: 'pull-request.closed', number: 9, merged: true },
        { type: 'report.done', channel: 'migrate-bot', outcome: 'delivered', detail: '' },
      ])
      assert.ok(store.write(undefined, new Map([[logPath('0.2.0'), serializeLog(cut)]]), 'cut').ok)
      const calls: ActivityRequest[] = []
      const later = engine(repo, scripted(proposal(9), calls), repo.clone())
      const view = how === 'without an event'
        ? await later.resume('0.2.0')
        : await later.deliver('0.2.0', { type: 'pull-request.closed', number: 9, merged: true })
      assert.deepEqual(calls, [{ activity: 'deliverReport', channel: 'upgrade-skill' }])
      assert.equal(view.state, 'accepted')
    } finally {
      repo.cleanup()
    }
  })
}

test('an activity that throws ends the migration in error, and the error is recorded', async () => {
  const repo = checkout()
  try {
    const failing: ActivityRunner = async (request) => {
      if (request.activity === 'check') throw new Error('npm registry unreachable')
      return await scripted(proposal(9))(request, undefined as never)
    }
    const view = await engine(repo, failing).start('0.2.0', input('0.2.0'))
    assert.equal(view.state, 'error')
    const log = new StateStore(repo.clone()).read().logs.get('0.2.0') ?? []
    const last = log.at(-1)
    assert.equal(last?.kind === 'event' && last.event.type === 'activity.error' && last.event.detail, 'npm registry unreachable')
  } finally {
    repo.cleanup()
  }
})

test('an event for a migration the state branch does not hold is refused', async () => {
  const repo = checkout()
  try {
    await assert.rejects(engine(repo, scripted(proposal(9))).deliver('9.9.9', { type: 'pull-request.closed', number: 1, merged: true }), /no migration 9\.9\.9/)
  } finally {
    repo.cleanup()
  }
})
