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
