import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { changedPaths, excludeIgnoredPaths, isIgnoredPath, isTreeChanged, stageChanges } from '../../src/git/worktree.ts'

test('report and secrets paths are ignored paths', () => {
  assert.equal(isIgnoredPath('.dsh-migrate/'), true)
  assert.equal(isIgnoredPath('.dsh-migrate/runs/x/A.md'), true)
  assert.equal(isIgnoredPath('.secrets.local.json'), true)
  assert.equal(isIgnoredPath('src/index.ts'), false)
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('a tree that only grew .dsh-migrate is not changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-wt-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(dir, 'keep.txt'), 'ok\n')
    git(dir, ['add', 'keep.txt'])
    git(dir, ['commit', '-m', 'init'])
    excludeIgnoredPaths(dir)
    mkdirSync(join(dir, '.dsh-migrate', 'runs', 'x'), { recursive: true })
    writeFileSync(join(dir, '.dsh-migrate', 'runs', 'x', 'A.md'), '# A\n')
    assert.equal(isTreeChanged(dir), false)
    writeFileSync(join(dir, 'plugin.js'), 'export {}\n')
    assert.equal(isTreeChanged(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function stagedNames(cwd: string): string[] {
  const result = spawnSync('git', ['-c', 'safe.directory=*', 'diff', '--cached', '--name-only'], {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split(/\r?\n/).filter(line => line !== '')
}

test('stageChanges ignores .dsh-migrate after info/exclude (the Action add failure)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-add-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(dir, 'keep.txt'), 'ok\n')
    git(dir, ['add', 'keep.txt'])
    git(dir, ['commit', '-m', 'init'])
    excludeIgnoredPaths(dir)
    mkdirSync(join(dir, '.dsh-migrate', 'patch-reports', 'pre-step'), { recursive: true })
    writeFileSync(join(dir, '.dsh-migrate', 'patch-reports', 'pre-step', 'report.md'), '# draft\n')
    writeFileSync(join(dir, 'plugin.js'), 'export {}\n')
    const excluded = spawnSync(
      'git',
      ['-c', 'safe.directory=*', 'add', '-A', '--', '.', ':!.dsh-migrate', ':!.secrets.local.json'],
      { cwd: dir, encoding: 'utf8' },
    )
    assert.notEqual(excluded.status, 0)
    assert.match(excluded.stderr, /\.dsh-migrate/)
    stageChanges(dir)
    assert.deepEqual(stagedNames(dir), ['plugin.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stageChanges unstages .dsh-migrate even when it is not ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-add2-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(dir, 'keep.txt'), 'ok\n')
    git(dir, ['add', 'keep.txt'])
    git(dir, ['commit', '-m', 'init'])
    mkdirSync(join(dir, '.dsh-migrate'), { recursive: true })
    writeFileSync(join(dir, '.dsh-migrate', 'A.md'), '# A\n')
    writeFileSync(join(dir, 'src.js'), 'export const n = 1\n')
    stageChanges(dir)
    assert.deepEqual(stagedNames(dir), ['src.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Agent Notes are ignored paths, not migration content', () => {
  // Belt and braces behind the prompt: a live run left
  // `.agents/notes/implemented/architecture/…md` in the plugin tree, and the
  // mechanical publish path would have committed it into the migration PR.
  assert.equal(isIgnoredPath('.agents/notes'), true)
  assert.equal(isIgnoredPath('.agents/notes/'), true)
  assert.equal(isIgnoredPath('.agents/notes/implemented/architecture/2026-09-10-x.md'), true)
  // Only the notes tree is excluded; a plugin may legitimately ship its own
  // agent configuration or skills.
  assert.equal(isIgnoredPath('.agents/skills/my-skill/SKILL.md'), false)
  assert.equal(isIgnoredPath('.agents/config.yml'), false)
  assert.equal(isIgnoredPath('src/index.ts'), false)
})

test('dependencies the checks installed are never a change or part of the proposal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-deps-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(dir, 'index.js'), 'export {}\n')
    git(dir, ['add', 'index.js'])
    git(dir, ['commit', '-m', 'init'])
    excludeIgnoredPaths(dir)
    for (const nested of ['node_modules/x', 'packages/ui/node_modules/y']) {
      mkdirSync(join(dir, nested), { recursive: true })
      writeFileSync(join(dir, nested, 'index.js'), 'module.exports = 1\n')
    }
    assert.equal(isTreeChanged(dir), false)
    writeFileSync(join(dir, 'index.js'), 'export const migrated = true\n')
    assert.deepEqual(changedPaths(dir), ['index.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tree that only grew Agent Notes is not changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-notes-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    writeFileSync(join(dir, 'keep.txt'), 'ok\n')
    git(dir, ['add', 'keep.txt'])
    git(dir, ['commit', '-m', 'init'])
    excludeIgnoredPaths(dir)
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'architecture'), { recursive: true })
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'architecture', '2026-09-10-x.md'), '# note\n')
    assert.equal(isTreeChanged(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the exclude file hides Agent Notes from git without a committed .gitignore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-excl-'))
  try {
    git(dir, ['init'])
    excludeIgnoredPaths(dir)
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /^\.dsh-migrate\/$/m)
    assert.match(exclude, /^\.agents\/notes\/$/m)
    // Idempotent: a second call must not duplicate lines.
    excludeIgnoredPaths(dir)
    const again = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(again.split('\n').filter((line: string) => line.trim() === '.agents/notes/').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Agent Notes never reach the staged set even when the plugin tracks them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-track-'))
  try {
    git(dir, ['init'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'user.email', 'test@example.test'])
    mkdirSync(join(dir, '.agents', 'notes', 'implemented'), { recursive: true })
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'x.md'), 'original\n')
    writeFileSync(join(dir, 'src.ts'), 'export {}\n')
    git(dir, ['add', '-f', '-A'])
    git(dir, ['commit', '-m', 'init'])
    // The agent edits a tracked note and a real source file.
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'x.md'), 'rewritten by the agent\n')
    writeFileSync(join(dir, 'src.ts'), 'export const a = 1\n')
    stageChanges(dir)
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).stdout
    assert.match(staged, /src\.ts/)
    assert.doesNotMatch(staged, /\.agents\/notes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
