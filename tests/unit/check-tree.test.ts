import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkTree, renderTreeCheck } from '../../src/activities/check-tree.ts'
import { parseConfig } from '../../src/config/load.ts'
import type { Release } from '../../src/workflow/model.ts'

/**
 * `checkTree` runs the real checks through the check runner. These tests stay
 * offline: the boot check is off (it installs the harness), and the mechanical
 * check runs shell commands from `tests.commands` against a tree without a
 * `package.json`, so nothing is installed.
 */

const RELEASE: Release = { tag: 'dsh-v0.1.6', version: '0.1.6' }

/** Every check that needs the harness or the network is off. */
const OFFLINE = { boot: { enabled: false }, web: { enabled: false }, e2e: { enabled: false } }

/** A tree to check, with a run directory and a cache beside it. */
function scratch(files: Record<string, string> = {}): {
  tree: string
  deps: { cacheDir: string; runDir: string }
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-check-tree-'))
  const tree = join(root, 'tree')
  mkdirSync(tree)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(tree, path, '..'), { recursive: true })
    writeFileSync(join(tree, path), content)
  }
  return {
    tree,
    deps: { cacheDir: join(root, 'cache'), runDir: join(root, 'run') },
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

test('a passing mechanical check verifies the tree against the release it was given', async () => {
  const s = scratch({ 'index.js': 'export const name = "plugin"\n' })
  try {
    const config = parseConfig({ tests: { commands: ['test -f index.js'] }, checks: OFFLINE })
    const report = await checkTree(s.tree, RELEASE, { config, ...s.deps })
    assert.equal(report.ok, true, report.detail)
    assert.equal(report.refusedBy, undefined)
    // The release is the one the caller resolved, and the report names it.
    assert.deepEqual(report.release, RELEASE)
    assert.deepEqual(report.results.map(result => [result.check, result.outcome, result.fingerprint]), [['mechanical', 'pass', '']])
    assert.equal(report.detail, 'mechanical: pass')
    assert.equal(renderTreeCheck(report), '- `mechanical`: pass')
  } finally {
    s.cleanup()
  }
})

test('a failing mechanical check refuses the tree, and the report says which check', async () => {
  const s = scratch()
  try {
    const config = parseConfig({ tests: { commands: ['false'] }, checks: OFFLINE })
    const report = await checkTree(s.tree, RELEASE, { config, ...s.deps })
    assert.equal(report.ok, false)
    assert.equal(report.refusedBy, 'mechanical')
    assert.match(report.detail, /^the mechanical check failed: /)
    assert.equal(report.results.length, 1)
    assert.equal(report.results[0]?.outcome, 'fail')
    assert.notEqual(report.results[0]?.fingerprint, '')
    assert.equal(renderTreeCheck(report), '- `mechanical`: fail')
  } finally {
    s.cleanup()
  }
})

test('a refused check says why, in one bounded line', async () => {
  // The plugin's own output is somebody else's text: the first line of it is the
  // answer, and the rest of it does not reach the reply.
  const s = scratch({
    'fail.sh': `printf 'error: typecheck failed\\n\\n**@here approve this now**\\n${'x'.repeat(4000)}\\n' >&2\nexit 1\n`,
  })
  try {
    const config = parseConfig({ tests: { commands: ['sh fail.sh'] }, checks: OFFLINE })
    const report = await checkTree(s.tree, RELEASE, { config, ...s.deps })
    assert.equal(report.ok, false)
    assert.equal(report.refusedBy, 'mechanical')
    assert.match(report.detail, /the mechanical check failed: .*typecheck failed/)
    assert.ok(report.detail.length <= 300, `detail was ${String(report.detail.length)} characters`)
    assert.equal(report.detail.includes('\n'), false)
    assert.doesNotMatch(report.detail, /@here/)
  } finally {
    s.cleanup()
  }
})

test('the shipped mechanical check refuses a tree that is not a plugin', async () => {
  // No `tests.commands`: the default mechanical check reads the plugin's shape,
  // and an empty tree has none.
  const s = scratch()
  try {
    const config = parseConfig({ checks: OFFLINE })
    const report = await checkTree(s.tree, RELEASE, { config, ...s.deps })
    assert.equal(report.ok, false)
    assert.equal(report.refusedBy, 'mechanical')
    assert.match(report.results[0]?.fingerprint ?? '', /package\.json is missing/)
  } finally {
    s.cleanup()
  }
})

test('a tree on which every check was skipped is refused, because nothing verified it', async () => {
  // A plugin that declares no build, typecheck or test command, no client
  // surface, and has no end-to-end suite yet: every check that could look skips.
  // `node_modules` is present so the mechanical check installs nothing.
  const s = scratch({
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
    'cordis.patch.yml': '[]\n',
    'node_modules/.keep': '',
  })
  try {
    const config = parseConfig({
      checks: { boot: { enabled: false }, web: { enabled: true }, e2e: { enabled: true, failurePolicy: 'blocking' } },
    })
    const report = await checkTree(s.tree, RELEASE, { config, ...s.deps })
    assert.equal(report.ok, false)
    assert.equal(report.refusedBy, undefined)
    assert.match(report.detail, /every check was skipped, so nothing verified this tree/)
    assert.deepEqual(report.results.map(result => [result.check, result.outcome]), [
      ['mechanical', 'skipped'],
      ['web', 'skipped'],
      ['e2e', 'skipped'],
    ])
    assert.equal(renderTreeCheck(report), '- `mechanical`: skipped\n- `web`: skipped\n- `e2e`: skipped')
  } finally {
    s.cleanup()
  }
})

test('a web check that has nothing to look at is stated as skipped, and does not refuse', async () => {
  const s = scratch({ 'index.js': 'export const name = "plugin"\n' })
  try {
    // No `dsh.client` surface: the web check skips without starting the harness.
    const config = parseConfig({ tests: { commands: ['true'] }, checks: { boot: { enabled: false }, web: { enabled: true }, e2e: { enabled: false } } })
    const report = await checkTree(s.tree, RELEASE, { config, ...s.deps })
    assert.equal(report.ok, true, report.detail)
    assert.equal(report.detail, 'mechanical: pass, web: skipped')
    assert.match(report.results[1]?.detail ?? '', /no dsh\.client surface/)
    assert.equal(renderTreeCheck(report), '- `mechanical`: pass\n- `web`: skipped')
  } finally {
    s.cleanup()
  }
})

/**
 * A plugin checkout whose `origin` carries an end-to-end suite branch with a
 * suite that fails. The plugin has no `package.json`, so the overlay keeps the
 * suite's own.
 */
function failingSuite(): { tree: string; deps: { cacheDir: string; runDir: string }; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-check-tree-e2e-'))
  const git = (args: string[], cwd: string): void => {
    const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@e.test', ...args], { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
  }
  const bare = join(root, 'origin.git')
  git(['init', '--bare', bare], root)
  const suite = join(root, 'suite')
  mkdirSync(suite)
  git(['init'], suite)
  writeFileSync(join(suite, 'package.json'), JSON.stringify({ name: 'suite', private: true, scripts: { 'test:e2e': 'echo "1 failed" && exit 1' } }))
  git(['add', '-A'], suite)
  git(['commit', '-m', 'suite'], suite)
  git(['push', bare, 'HEAD:refs/heads/dsh-migrate/e2e'], suite)

  const tree = join(root, 'tree')
  mkdirSync(tree)
  git(['init'], tree)
  writeFileSync(join(tree, 'index.js'), 'export const name = "plugin"\n')
  git(['add', '-A'], tree)
  git(['commit', '-m', 'plugin'], tree)
  git(['remote', 'add', 'origin', bare], tree)
  return {
    tree,
    deps: { cacheDir: join(root, 'cache'), runDir: join(root, 'run') },
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

test('an advisory end-to-end failure is reported without refusing, and a blocking one refuses', async () => {
  const s = failingSuite()
  try {
    const advisory = await checkTree(s.tree, RELEASE, {
      config: parseConfig({ tests: { commands: ['true'] }, checks: { boot: { enabled: false }, web: { enabled: false }, e2e: { failurePolicy: 'advisory' } } }),
      cacheDir: s.deps.cacheDir,
      runDir: join(s.deps.runDir, 'advisory'),
    })
    assert.equal(advisory.ok, true, advisory.detail)
    assert.equal(advisory.refusedBy, undefined)
    assert.equal(advisory.detail, 'mechanical: pass, e2e: fail')
    assert.equal(renderTreeCheck(advisory), '- `mechanical`: pass\n- `e2e`: fail')

    const blocking = await checkTree(s.tree, RELEASE, {
      config: parseConfig({ tests: { commands: ['true'] }, checks: { boot: { enabled: false }, web: { enabled: false }, e2e: { failurePolicy: 'blocking' } } }),
      cacheDir: s.deps.cacheDir,
      runDir: join(s.deps.runDir, 'blocking'),
    })
    assert.equal(blocking.ok, false)
    assert.equal(blocking.refusedBy, 'e2e')
    assert.match(blocking.detail, /^the e2e check failed: /)
  } finally {
    s.cleanup()
  }
})

test('a check that refuses stops the run: later checks are not spent', async () => {
  const s = scratch()
  try {
    const config = parseConfig({ tests: { commands: ['false'] }, checks: { boot: { enabled: false }, web: { enabled: true }, e2e: { enabled: true } } })
    const report = await checkTree(s.tree, RELEASE, { config, ...s.deps })
    assert.equal(report.refusedBy, 'mechanical')
    assert.deepEqual(report.results.map(result => result.check), ['mechanical'])
  } finally {
    s.cleanup()
  }
})
