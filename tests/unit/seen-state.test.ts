import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isWorktreeDirty } from '../../src/git/worktree.ts'
import { badgeFromSeenState, serializeBadge, UNVERIFIED_BADGE } from '../../src/watch/badge.ts'
import {
  applyPullRequestToSeenState,
  applyRunToSeenState,
  parseSeenState,
  persistSeenState,
  persistStateBranch,
  readSeenState,
  serializeSeenState,
  BADGE_FILE,
  STATE_BRANCH,
  STATE_FILE,
} from '../../src/watch/seen.ts'
import { retryLostRace } from '../../src/watch/sync.ts'
import { commandRecorded } from '../../src/commands/idempotency.ts'
import type { SeenState } from '../../src/watch/seen.ts'

const recordedAt = '2026-08-25T00:00:00.000Z'
const now = new Date(recordedAt)
const v1 = { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' }
const v2 = { tag: 'dsh-v0.1.2', version: '0.1.2' }

test('parseSeenState accepts a complete blob and rejects junk', () => {
  const ok = parseSeenState(serializeSeenState({
    tag: v1.tag,
    version: v1.version,
    recordedAt,
    verified: v1,
    pending: { ...v2, pr: 42, prUrl: 'https://github.com/acme/p/pull/42' },
  }))
  assert.equal(ok?.version, v1.version)
  assert.equal(ok?.verified?.tag, v1.tag)
  assert.equal(ok?.pending?.pr, 42)
  assert.equal(parseSeenState(''), undefined)
  assert.equal(parseSeenState('{"tag":"x"}'), undefined)
  assert.equal(parseSeenState('not-json'), undefined)
})

test('parseSeenState keeps a legacy processed-only blob', () => {
  const ok = parseSeenState(serializeSeenState({
    tag: v1.tag,
    version: v1.version,
    recordedAt,
  }))
  assert.equal(ok?.verified, undefined)
  assert.equal(ok?.pending, undefined)
})

test('applyRunToSeenState splits compatible (verified) from migrated (pending)', () => {
  const compatible = applyRunToSeenState(undefined, {
    target: v1,
    status: 'compatible',
    now,
  })
  assert.deepEqual(compatible?.verified, v1)
  assert.equal(compatible?.pending, undefined)
  assert.equal(badgeFromSeenState(compatible).message, v1.tag)

  const migrated = applyRunToSeenState(compatible, {
    target: v2,
    status: 'migrated',
    pullRequest: { number: 7, url: 'https://github.com/acme/p/pull/7' },
    now,
  })
  assert.deepEqual(migrated?.verified, v1)
  assert.equal(migrated?.version, v2.version)
  assert.equal(migrated?.pending?.pr, 7)
  assert.equal(badgeFromSeenState(migrated).message, v1.tag)

  assert.equal(applyRunToSeenState(compatible, { target: v2, status: 'failed', now }), compatible)
})

test('applyPullRequestToSeenState promotes merge and drops a closed PR', () => {
  const pending = applyRunToSeenState(undefined, {
    target: v1,
    status: 'migrated',
    pullRequest: { number: 3 },
    now,
  })
  assert.ok(pending)
  assert.equal(badgeFromSeenState(pending).message, 'pending')

  const merged = applyPullRequestToSeenState(pending, 'merged')
  assert.deepEqual(merged.verified, v1)
  assert.equal(merged.pending, undefined)
  assert.equal(badgeFromSeenState(merged).message, v1.tag)

  const closed = applyPullRequestToSeenState(pending, 'closed')
  assert.equal(closed.verified, undefined)
  assert.equal(closed.pending, undefined)
  assert.deepEqual(badgeFromSeenState(closed), UNVERIFIED_BADGE)

  assert.equal(applyPullRequestToSeenState(pending, 'open'), pending)
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
}

test('missing state branch is first-run; persist writes seen.json and badge.json', () => {
  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-mig-work-'))
  try {
    git(bare, ['init', '--bare'])
    git(work, ['init'])
    git(work, ['config', 'user.name', 'test'])
    git(work, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(work, 'plugin.js'), 'export {}\n')
    git(work, ['add', 'plugin.js'])
    git(work, ['commit', '-m', 'init'])
    git(work, ['remote', 'add', 'origin', bare])
    git(work, ['push', '-u', 'origin', 'HEAD:master'])

    assert.equal(readSeenState(work), undefined)

    const firstState = applyRunToSeenState(undefined, { target: v1, status: 'compatible', now })
    assert.ok(firstState)
    const first = persistSeenState(work, firstState)
    assert.equal(first.ok, true, first.ok ? '' : first.detail)
    assert.equal(isWorktreeDirty(work), false)

    const listed = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    const seen = parseSeenState(listed.stdout)
    assert.equal(seen?.tag, v1.tag)
    assert.deepEqual(seen?.verified, v1)

    const badge = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${BADGE_FILE}`], { encoding: 'utf8' })
    assert.equal(badge.status, 0, badge.stderr)
    assert.equal(badge.stdout, serializeBadge(badgeFromSeenState(firstState)))

    const loaded = readSeenState(work)
    assert.equal(loaded?.version, v1.version)

    const secondState = applyRunToSeenState(loaded, {
      target: v2,
      status: 'migrated',
      pullRequest: { number: 9 },
    })
    assert.ok(secondState)
    const second = persistSeenState(work, secondState)
    assert.equal(second.ok, true, second.ok ? '' : second.detail)
    assert.equal(readSeenState(work)?.pending?.pr, 9)
    assert.equal(isWorktreeDirty(work), false)

    const log = spawnSync('git', ['-C', bare, 'log', '--oneline', STATE_BRANCH], { encoding: 'utf8' })
    assert.equal(log.status, 0, log.stderr)
    assert.equal(log.stdout.trim().split('\n').length, 2)
  } finally {
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('readSeenState is undefined without git or origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-nongit-'))
  try {
    writeFileSync(join(dir, 'x.txt'), 'x\n')
    assert.equal(readSeenState(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistSeenState refuses a repo with no origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-noremote-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(dir, 'plugin.js'), 'export {}\n')
    git(dir, ['add', 'plugin.js'])
    git(dir, ['commit', '-m', 'init'])
    const result = persistSeenState(dir, {
      tag: v1.tag,
      version: v1.version,
      recordedAt,
      verified: v1,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'no-remote')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistStateBranch can seed an unverified badge without seen.json', () => {
  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-badge-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-mig-badge-work-'))
  try {
    git(bare, ['init', '--bare'])
    git(work, ['init'])
    git(work, ['config', 'user.name', 'test'])
    git(work, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(work, 'plugin.js'), 'export {}\n')
    git(work, ['add', 'plugin.js'])
    git(work, ['commit', '-m', 'init'])
    git(work, ['remote', 'add', 'origin', bare])
    git(work, ['push', '-u', 'origin', 'HEAD:master'])

    const seeded = persistStateBranch(work, { badge: UNVERIFIED_BADGE }, { message: 'dsh-migrate: refresh badge' })
    assert.equal(seeded.ok, true, seeded.ok ? '' : seeded.detail)
    assert.equal(readSeenState(work), undefined)
    const badge = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${BADGE_FILE}`], { encoding: 'utf8' })
    assert.equal(badge.stdout, serializeBadge(UNVERIFIED_BADGE))
  } finally {
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('a state write that lost a race is retried, and nothing else is', () => {
  const attempts: number[] = []
  const retried = retryLostRace(() => {
    attempts.push(1)
    return attempts.length < 3
      ? { ok: false as const, reason: 'push-failed' as const, detail: 'non-fast-forward' }
      : { ok: true as const, commit: 'abc' }
  }, { attempts: 3, log: () => {} })
  assert.equal(retried.ok, true)
  assert.equal(attempts.length, 3)

  // A reason that will not have healed comes back after one try.
  const hopeless: string[] = []
  const failed = retryLostRace(() => {
    hopeless.push('try')
    return { ok: false as const, reason: 'no-remote' as const, detail: 'no remote origin' }
  }, { attempts: 3, log: () => {} })
  assert.equal(failed.ok, false)
  assert.equal(hopeless.length, 1)

  // And a first-attempt success is a single attempt, not a retry loop.
  const once: number[] = []
  const ok = retryLostRace(() => {
    once.push(1)
    return { ok: true as const, commit: 'def' }
  }, { attempts: 3, log: () => {} })
  assert.equal(ok.ok, true)
  assert.equal(once.length, 1)
})

/**
 * A badge-only write replaces the whole state file, so it must not be the thing
 * that decides the ledger is empty. The *timing* case — a run whose state was
 * read before a command recorded itself — is covered by the merge's own unit test
 * and by the record-write race test; this pins the observable half.
 */
test('a badge write keeps the ledger the branch already holds', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { STATE_BRANCH, STATE_FILE } = await import('../../src/watch/seen.ts')

  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-merge-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-mig-merge-work-'))
  try {
    const git = (args: string[], cwd = work): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    git(['init'])
    git(['config', 'user.name', 'test'])
    git(['config', 'user.email', 'test@example.test'])
    writeFileSync(join(work, 'plugin.js'), 'export {}\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    git(['remote', 'add', 'origin', bare])
    git(['push', '-u', 'origin', 'HEAD:master'])

    const withCommand: SeenState = {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      commands: [{ key: 'me/plugin#7:redeploy:comment=99', verb: 'redeploy', at: '2026-09-14T02:00:00.000Z' }],
    }
    assert.equal(persistStateBranch(work, { seen: withCommand, badge: badgeFromSeenState(withCommand) }).ok, true)

    // The badge job writes the whole file back; the command's record must survive.
    const child = spawnSync(process.execPath, ['dist/src/cli.js', 'refresh-badge', '--workdir', work], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_REPOSITORY: 'me/plugin' },
    })
    assert.equal(child.status, 0, child.stderr)

    const shown = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    const after = parseSeenState(shown.stdout)
    assert.notEqual(commandRecorded(after?.commands ?? [], 'me/plugin#7:redeploy:comment=99'), undefined)
    assert.equal(after?.tag, 'dsh-v0.1.5')
  } finally {
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('a state write names the tag it recorded without letting it add a line', async () => {
  const { writeStateBranch } = await import('../../src/watch/sync.ts')
  const { persistStateBranch } = await import('../../src/watch/seen.ts')
  const { badgeFromSeenState } = await import('../../src/watch/badge.ts')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const work = mkdtempSync(join(tmpdir(), 'dsh-state-message-'))
  const bare = mkdtempSync(join(tmpdir(), 'dsh-state-message-bare-'))
  const git = (args: string[]): void => {
    const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8' })
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
  }
  try {
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    git(['init'])
    git(['config', 'user.name', 'test'])
    git(['config', 'user.email', 'test@example.test'])
    git(['commit', '--allow-empty', '-m', 'init'])
    git(['branch', '-M', 'main'])
    git(['remote', 'add', 'origin', bare])
    git(['push', '-u', 'origin', 'main'])

    const state = {
      tag: 'dsh-v0.1.5\n::add-mask::not-a-secret',
      version: '0.1.5',
      recordedAt: '2026-01-01T00:00:00.000Z',
    }
    // The default subject names the tag, so a tag that carries a newline would
    // otherwise write a second line into the commit message.
    const written = persistStateBranch(work, { seen: state, badge: { schemaVersion: 1, label: 'dsh', message: 'x', color: 'lightgrey' } })
    assert.equal(written.ok, true, written.ok ? '' : written.detail)
    const message = spawnSync('git', ['-C', bare, 'log', '-1', '--format=%B', state.recordedAt ? 'dsh-migrate/state' : 'main'], { encoding: 'utf8' }).stdout.trim()
    assert.match(message, /^dsh-migrate: record dsh-v0\.1\.5 ::add-mask::not-a-secret$/)
    assert.equal(message.includes('\n'), false)

    // The badge-only write goes through the same path with its own subject.
    assert.equal(writeStateBranch(work, undefined, 'dsh-migrate: refresh badge').ok, true)
  } finally {
    for (const dir of [work, bare]) rmSync(dir, { recursive: true, force: true })
  }
})
