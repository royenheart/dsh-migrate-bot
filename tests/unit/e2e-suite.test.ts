import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { characterize } from '../../src/activities/e2e-suite.ts'
import { parseConfig } from '../../src/config/load.ts'
import { excludeIgnoredPaths } from '../../src/git/worktree.ts'
import { publishSuite, readReport, readSuite, renderAuthoringBrief, renderIndexMarkdown, PLAYWRIGHT_VERSION } from '../../src/e2e/suite.ts'
import { contextOf, input } from '../support/migration.ts'

const git = (args: string[], cwd: string): string => {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@e.test', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
  return result.stdout.trim()
}

function repository(): { root: string; tree: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-suite-'))
  const tree = join(root, 'tree')
  mkdirSync(tree)
  git(['init', '--quiet'], tree)
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: '@acme/web', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }))
  git(['add', '-A'], tree)
  git(['commit', '--quiet', '-m', 'plugin'], tree)
  return { root, tree }
}

function suite(dir: string, spec = 'test("opens", () => {})\n'): void {
  mkdirSync(join(dir, 'specs'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, devDependencies: { '@playwright/test': PLAYWRIGHT_VERSION } }))
  writeFileSync(join(dir, 'specs', 'panel.spec.ts'), spec)
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '')
}

test('Playwright tests are read by their title path, a test is passing only when every run of it passed', () => {
  const report = JSON.stringify({
    suites: [{
      title: 'specs/panel.spec.ts',
      specs: [{ title: 'opens', tests: [{ status: 'expected' }] }, { title: 'is gone', tests: [{ status: 'skipped' }] }],
      suites: [{ title: 'settings', specs: [{ title: 'saves', tests: [{ status: 'unexpected', results: [{ error: { message: '\u001b[31mError:\u001b[39m expect(locator).toBeVisible() failed\n\nLocator: getByRole(\'button\', { name: \'Save\' })' } }] }] }, { title: 'flakes', tests: [{ status: 'flaky' }] }] }],
    }],
  })
  assert.deepEqual(readReport(report), {
    passed: ['specs/panel.spec.ts › opens'],
    failed: ['specs/panel.spec.ts › settings › saves', 'specs/panel.spec.ts › settings › flakes'],
    errors: { 'specs/panel.spec.ts › settings › saves': "Error: expect(locator).toBeVisible() failed Locator: getByRole('button', { name: 'Save' })" },
  })
  assert.equal(readReport('Error: no config'), undefined)
})

test('the suite is committed as its directory on a branch of its own, and read back without what it installed', () => {
  const { root, tree } = repository()
  try {
    // The Action's checkout ignores node_modules itself, which git must not be asked to name.
    excludeIgnoredPaths(tree)
    const draft = join(root, 'draft')
    suite(draft)
    const first = publishSuite({ workdir: tree, branch: 'dsh-migrate/e2e', dir: 'e2e', suiteDir: draft, message: 'test(e2e): the suite' })
    assert.equal(first.outcome, 'pushed')
    assert.deepEqual(git(['ls-tree', '-r', '--name-only', 'dsh-migrate/e2e'], tree).split('\n'), ['e2e/package.json', 'e2e/specs/panel.spec.ts'])
    assert.equal(publishSuite({ workdir: tree, branch: 'dsh-migrate/e2e', dir: 'e2e', suiteDir: draft, message: 'again' }).outcome, 'unchanged')
    // The plugin's own branch is untouched.
    assert.equal(git(['status', '--porcelain'], tree), '')
    const copy = join(root, 'copy')
    assert.equal(readSuite({ workdir: tree, branch: 'dsh-migrate/e2e', dir: 'e2e', dest: copy }), true)
    assert.equal(readFileSync(join(copy, 'specs', 'panel.spec.ts'), 'utf8'), 'test("opens", () => {})\n')
    assert.equal(existsSync(join(copy, 'node_modules')), false)
    assert.equal(readSuite({ workdir: tree, branch: 'no-such-branch', dir: 'e2e', dest: join(root, 'none') }), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('with a remote, the suite branch is pushed there and read from there', () => {
  const { root, tree } = repository()
  try {
    const bare = join(root, 'origin.git')
    git(['init', '--quiet', '--bare', bare], root)
    git(['remote', 'add', 'origin', bare], tree)
    const draft = join(root, 'draft')
    suite(draft)
    assert.equal(publishSuite({ workdir: tree, branch: 'dsh-migrate/e2e', dir: 'tests/e2e', suiteDir: draft, message: 'test(e2e): the suite' }).outcome, 'pushed')
    assert.match(git(['ls-tree', '-r', '--name-only', 'dsh-migrate/e2e'], bare), /^tests\/e2e\/package\.json$/m)
    assert.equal(readSuite({ workdir: tree, branch: 'dsh-migrate/e2e', dir: 'tests/e2e', dest: join(root, 'copy') }), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no baseline is recorded without a source release, without a browser half, or when the source does not install', async () => {
  const { root, tree } = repository()
  try {
    const deps = (install: () => { bin: string } | { failure: string }) => ({
      workdir: tree,
      config: parseConfig({}),
      agent: { run: async () => { throw new Error('no session may start') } },
      apiKey: 'k',
      runDir: join(root, 'run'),
      install,
    })
    const withSource = input('0.2.0', { source: { release: { tag: 'dsh-v0.1.7', version: '0.1.7' }, origin: 'verified' } })
    const noSource = await characterize(deps(() => ({ bin: 'dsh' })), contextOf(input('0.2.0'), []))
    assert.deepEqual([noSource.type, 'outcome' in noSource && noSource.outcome], ['e2e.characterized', 'skipped'])
    const uninstallable = await characterize(deps(() => ({ failure: 'could not install dsh 0.1.7' })), contextOf(withSource, []))
    assert.equal('detail' in uninstallable && uninstallable.detail, 'could not install dsh 0.1.7')
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: '@acme/host', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    const headless = await characterize(deps(() => ({ bin: 'dsh' })), contextOf(withSource, []))
    assert.match('detail' in headless ? headless.detail : '', /no plugin has a browser half/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the brief keeps the suite self-contained and pointed at the served URL', () => {
  const brief = renderAuthoringBrief({ suiteDir: '/run/e2e-suite', plugins: '@acme/web', release: 'dsh-v0.1.7', existing: false })
  assert.match(brief, /DSH_MIGRATE_WEB_URL/)
  assert.match(brief, /never start dsh itself/)
  assert.match(brief, new RegExp(`"@playwright/test": "${PLAYWRIGHT_VERSION.replaceAll('.', '\\.')}"`))
  assert.match(renderIndexMarkdown({ features: [{ id: 'panel', entry: 'Sidebar | Panel', expect: 'it opens', test: 'specs/panel.spec.ts' }] }, 'dsh-v0.1.7'), /\| `panel` \| Sidebar \\\| Panel \| it opens \|/)
})
