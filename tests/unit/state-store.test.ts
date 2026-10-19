import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BADGE_FILE, logPath, migrationFile, parseLog, serializeLog, StateLogError, StateStore, STATE_BRANCH } from '../../src/state/store.ts'
import { checkout } from '../support/repository.ts'
import { input, logOf, proposedEvents } from '../support/migration.ts'

test('a repository without a state branch reads as empty, and the first write creates it', () => {
  const repo = checkout()
  try {
    const store = new StateStore(repo.work)
    const empty = store.read()
    assert.equal(empty.tip, undefined)
    assert.equal(empty.logs.size, 0)
    const log = logOf(input('0.2.0'), proposedEvents())
    const written = store.write(undefined, new Map([[logPath('0.2.0'), serializeLog(log)], [BADGE_FILE, '{}\n']]), 'dsh-migrate: 0.2.0')
    assert.equal(written.ok, true)
    const again = new StateStore(repo.clone()).read()
    assert.deepEqual(again.logs.get('0.2.0'), log)
    assert.equal(repo.git(['log', '-1', '--format=%an %s', STATE_BRANCH], repo.remote), 'dsh-migrate[bot] dsh-migrate: 0.2.0')
    // The plugin checkout itself is untouched.
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
  } finally {
    repo.cleanup()
  }
})

test('a write that changes nothing makes no commit', () => {
  const repo = checkout()
  try {
    const store = new StateStore(repo.work)
    const first = store.write(undefined, new Map([[BADGE_FILE, '{}\n']]), 'one')
    assert.ok(first.ok && first.commit !== 'unchanged')
    const second = store.write(first.ok ? first.commit : undefined, new Map([[BADGE_FILE, '{}\n']]), 'two')
    assert.deepEqual(second, { ok: true, commit: 'unchanged' })
  } finally {
    repo.cleanup()
  }
})

test('a writer that lost a race to another migration is rebuilt on the new tip', () => {
  const repo = checkout()
  try {
    const mine = new StateStore(repo.work)
    const base = mine.write(undefined, new Map([[BADGE_FILE, 'a\n']]), 'base')
    assert.ok(base.ok)
    const tip = base.ok ? base.commit : undefined
    const other = new StateStore(repo.clone())
    other.read()
    assert.ok(other.write(tip, new Map([[migrationFile('0.1.0', 'reports/overlap.md'), 'x\n'], [BADGE_FILE, 'b\n']]), 'other').ok)
    const written = mine.write(tip, new Map([[migrationFile('0.2.0', 'reports/overlap.md'), 'y\n'], [BADGE_FILE, 'c\n']]), 'mine')
    assert.equal(written.ok, true)
    const reader = new StateStore(repo.clone())
    reader.read()
    assert.equal(reader.readFile(migrationFile('0.1.0', 'reports/overlap.md')), 'x\n')
    assert.equal(reader.readFile(migrationFile('0.2.0', 'reports/overlap.md')), 'y\n')
  } finally {
    repo.cleanup()
  }
})

test('a writer whose own files another writer changed is refused, never merged', () => {
  const repo = checkout()
  try {
    const mine = new StateStore(repo.work)
    const base = mine.write(undefined, new Map([[migrationFile('0.2.0', 'reports/overlap.md'), 'a\n']]), 'base')
    const tip = base.ok ? base.commit : undefined
    const other = new StateStore(repo.clone())
    other.read()
    assert.ok(other.write(tip, new Map([[migrationFile('0.2.0', 'reports/overlap.md'), 'other\n']]), 'other').ok)
    const written = mine.write(tip, new Map([[migrationFile('0.2.0', 'reports/overlap.md'), 'mine\n']]), 'mine')
    assert.equal(written.ok, false)
    assert.equal(!written.ok && written.reason, 'conflict')
  } finally {
    repo.cleanup()
  }
})

test('a log line that does not validate stops the read instead of being skipped', () => {
  assert.throws(() => parseLog('migrations/0.2.0/events.jsonl', '{"kind":"started"}\n'), StateLogError)
  assert.throws(() => parseLog('x', 'not json\n'), /x:1 is not JSON/)
  assert.deepEqual(parseLog('x', '\n'), [])
})

test('a checkout without a remote keeps the state branch as a local ref', () => {
  const repo = checkout()
  try {
    repo.git(['remote', 'remove', 'origin'])
    const store = new StateStore(repo.work)
    const written = store.write(store.read().tip, new Map([[BADGE_FILE, '{}\n']]), 'local')
    assert.ok(written.ok && written.commit !== 'unchanged')
    assert.equal(repo.git(['rev-parse', STATE_BRANCH]), written.ok ? written.commit : '')
    assert.equal(new StateStore(repo.work).readFile(BADGE_FILE), '{}\n')
    // A write built on a stale tip is refused rather than moving the ref.
    const stale = store.write(undefined, new Map([[BADGE_FILE, 'x\n']]), 'stale')
    assert.equal(stale.ok, false)
  } finally {
    repo.cleanup()
  }
})
