import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureMigrateGitExclude, isMigrateNoisePath, isWorktreeDirty } from '../../src/git/worktree.ts'

test('report and secrets paths are migrate noise', () => {
  assert.equal(isMigrateNoisePath('.dsh-migrate/'), true)
  assert.equal(isMigrateNoisePath('.dsh-migrate/runs/x/A.md'), true)
  assert.equal(isMigrateNoisePath('.secrets.local.json'), true)
  assert.equal(isMigrateNoisePath('src/index.ts'), false)
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('a tree that only grew .dsh-migrate is not dirty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-wt-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(dir, 'keep.txt'), 'ok\n')
    git(dir, ['add', 'keep.txt'])
    git(dir, ['commit', '-m', 'init'])
    ensureMigrateGitExclude(dir)
    mkdirSync(join(dir, '.dsh-migrate', 'runs', 'x'), { recursive: true })
    writeFileSync(join(dir, '.dsh-migrate', 'runs', 'x', 'A.md'), '# A\n')
    assert.equal(isWorktreeDirty(dir), false)
    writeFileSync(join(dir, 'plugin.js'), 'export {}\n')
    assert.equal(isWorktreeDirty(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
