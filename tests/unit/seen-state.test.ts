import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isWorktreeDirty } from '../../src/git/worktree.ts'
import {
  parseSeenState,
  persistSeenState,
  readSeenState,
  serializeSeenState,
  STATE_BRANCH,
  STATE_FILE,
} from '../../src/watch/seen.ts'

test('parseSeenState accepts a complete blob and rejects junk', () => {
  const ok = parseSeenState(serializeSeenState({
    tag: 'dsh-v0.1.1-rc.2',
    version: '0.1.1-rc.2',
    recordedAt: '2026-08-25T00:00:00.000Z',
  }))
  assert.equal(ok?.version, '0.1.1-rc.2')
  assert.equal(parseSeenState(''), undefined)
  assert.equal(parseSeenState('{"tag":"x"}'), undefined)
  assert.equal(parseSeenState('not-json'), undefined)
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
}

test('missing state branch is first-run; persist does not dirty the plugin tree', () => {
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

    const target = { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' }
    const first = persistSeenState(work, target, { now: new Date('2026-08-25T00:00:00.000Z') })
    assert.equal(first.ok, true, first.ok ? '' : first.detail)
    assert.equal(isWorktreeDirty(work), false)

    const listed = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    const seen = parseSeenState(listed.stdout)
    assert.equal(seen?.tag, target.tag)
    assert.equal(seen?.version, target.version)

    const loaded = readSeenState(work)
    assert.equal(loaded?.version, target.version)

    const second = persistSeenState(work, { tag: 'dsh-v0.1.2', version: '0.1.2' })
    assert.equal(second.ok, true, second.ok ? '' : second.detail)
    assert.equal(readSeenState(work)?.version, '0.1.2')
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
    const result = persistSeenState(dir, { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'no-remote')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
