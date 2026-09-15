import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  detectE2EFramework,
  INDEX_FILE,
  INDEX_MARKDOWN,
  parseIndex,
  readIndex,
  renderAuthoringBrief,
  renderIndexMarkdown,
  syncE2EBranch,
  type E2EIndex,
} from '../../src/e2e/branch.ts'
import { e2eCommand, e2eSignature, parseFailedTests, runE2E } from '../../src/e2e/run.ts'

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

/** A repo with a bare origin, so push/fetch behave like the Action's checkout. */
function repoWithOrigin(): { dir: string; origin: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mig-e2e-'))
  const origin = join(root, 'origin.git')
  const dir = join(root, 'work')
  mkdirSync(dir, { recursive: true })
  git(root, ['init', '--bare', '--initial-branch=main', origin])
  git(dir, ['init', '--initial-branch=main'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['config', 'user.email', 'test@example.test'])
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/plugin' }))
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
  git(dir, ['remote', 'add', 'origin', origin])
  git(dir, ['push', '-u', 'origin', 'main'])
  return { dir, origin, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const INDEX: E2EIndex = {
  schema: 1,
  generatedFor: { dsh: 'dsh-v0.1.5-rc.1', plugin: '@acme/plugin' },
  framework: 'playwright',
  features: [
    {
      id: 'settings-panel',
      surface: 'web-client',
      entry: 'open settings',
      input: 'type foo',
      expect: 'list filters',
      checks: ['aria', 'geometry:overflow'],
      test: 'e2e/specs/settings.spec.ts',
      state: 'passing',
      lastPassedFor: 'dsh-v0.1.5-rc.1',
    },
  ],
}

test('an existing framework is discovered so it can be extended', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-fw-'))
  try {
    assert.equal(detectE2EFramework(dir), undefined)
    writeFileSync(join(dir, 'playwright.config.ts'), 'export default {}')
    assert.equal(detectE2EFramework(dir), 'playwright')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a test script alone counts as an existing framework', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-fw-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'node run.js' } }))
    assert.equal(detectE2EFramework(dir), 'npm-script:test:e2e')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the authoring brief tells the agent to extend when a framework exists', () => {
  const extend = renderAuthoringBrief({
    workdir: '/w',
    suiteDir: 'e2e',
    framework: 'cypress',
    dshTag: 'dsh-v0.1.5-rc.1',
    pluginName: '@acme/plugin',
    stagingDir: '/run/e2e-draft',
  })
  assert.match(extend, /already uses "cypress"/)
  assert.match(extend, /Do not introduce a second end-to-end stack/)
  assert.match(extend, /\/run\/e2e-draft/)

  const create = renderAuthoringBrief({
    workdir: '/w',
    suiteDir: 'e2e',
    framework: undefined,
    dshTag: 'dsh-v0.1.5-rc.1',
    pluginName: '@acme/plugin',
    stagingDir: '/run/e2e-draft',
  })
  assert.match(create, /No end-to-end framework was detected/)
  assert.match(create, /Playwright with Chromium/)
})

test('the brief forbids writing into the plugin tree and onto data-* selectors', () => {
  const brief = renderAuthoringBrief({
    workdir: '/w',
    suiteDir: 'e2e',
    framework: undefined,
    dshTag: 'dsh-v0.1.5-rc.1',
    pluginName: '@acme/plugin',
    stagingDir: '/run/e2e-draft',
  })
  assert.match(brief, /Nothing may be written into the plugin tree/)
  assert.match(brief, /never on the host's internal data-\* attributes/)
})

test('the index round-trips through markdown', () => {
  const markdown = renderIndexMarkdown(INDEX)
  assert.match(markdown, /\| `settings-panel` \| web-client \|/)
  assert.match(markdown, /lastPassedFor/)
})

test('a malformed index is rejected rather than half-applied', () => {
  assert.equal(parseIndex({ features: 'nope' }), undefined)
  assert.equal(parseIndex(null), undefined)
  const partial = parseIndex({ features: [{ id: 'a' }, { nope: true }] })
  assert.equal(partial?.features.length, 1)
  assert.equal(partial?.features[0]?.state, 'unknown')
})

test('the suite is transplanted onto its own branch and pushed', () => {
  const { dir, origin, cleanup } = repoWithOrigin()
  const staging = join(dir, '.dsh-migrate', 'e2e-draft')
  const worktree = join(dir, '.dsh-migrate', 'e2e-branch')
  try {
    mkdirSync(join(staging, 'e2e', 'specs'), { recursive: true })
    writeFileSync(join(staging, 'e2e', 'specs', 'settings.spec.ts'), 'export {}\n')
    writeFileSync(join(staging, INDEX_FILE), JSON.stringify(INDEX))

    const result = syncE2EBranch({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      baseRef: 'origin/main',
      defaultBranch: 'main',
      forceRebase: true,
      stagingDir: staging,
      worktreeDir: worktree,
      index: INDEX,
      tag: 'dsh-v0.1.5-rc.1',
    })
    assert.equal(result.ok, true)
    assert.equal(result.pushed, true)

    const branches = git(origin, ['branch', '--list']).out
    assert.match(branches, /dsh-migrate\/e2e/)
    const files = git(origin, ['ls-tree', '-r', '--name-only', 'dsh-migrate/e2e']).out
    assert.match(files, /e2e\/specs\/settings\.spec\.ts/)
    assert.match(files, new RegExp(INDEX_MARKDOWN.replace('.', '\\.')))
    // The plugin tree itself is untouched: nothing was written into it.
    assert.equal(git(dir, ['status', '--porcelain']).out.includes('e2e/specs'), false)
  } finally {
    cleanup()
  }
})

test('a vanished base ref falls back to the default branch', () => {
  const { dir, cleanup } = repoWithOrigin()
  const staging = join(dir, '.dsh-migrate', 'e2e-draft')
  try {
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'e2e.spec.ts'), 'export {}\n')
    const result = syncE2EBranch({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      baseRef: 'origin/dsh-migrate/gone-2026-01-01',
      defaultBranch: 'main',
      forceRebase: true,
      stagingDir: staging,
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-branch'),
      index: INDEX,
      tag: 'dsh-v0.1.5-rc.1',
    })
    assert.equal(result.ok, true)
    assert.equal(result.pushed, true)
  } finally {
    cleanup()
  }
})

test('an unresolvable base still publishes from the checked-out commit', () => {
  // Observed live: a repository with no origin/HEAD and no GITHUB_REF_NAME made
  // detectBaseBranch answer "master", which does not exist. HEAD always does.
  const { dir, cleanup } = repoWithOrigin()
  const staging = join(dir, '.dsh-migrate', 'e2e-draft')
  try {
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'e2e.spec.ts'), 'export {}\n')
    const result = syncE2EBranch({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      baseRef: undefined,
      defaultBranch: 'master',
      forceRebase: true,
      stagingDir: staging,
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-branch'),
      index: INDEX,
      tag: 'dsh-v0.1.5-rc.1',
    })
    assert.equal(result.reason, undefined)
    assert.equal(result.pushed, true)
  } finally {
    cleanup()
  }
})

test('no staged suite is reported instead of pushing an empty branch', () => {
  const { dir, cleanup } = repoWithOrigin()
  try {
    const result = syncE2EBranch({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      baseRef: 'origin/main',
      defaultBranch: 'main',
      forceRebase: true,
      stagingDir: join(dir, '.dsh-migrate', 'missing'),
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-branch'),
      index: INDEX,
      tag: 'dsh-v0.1.5-rc.1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no-draft')
  } finally {
    cleanup()
  }
})

test('an unchanged suite is not re-committed', () => {
  const { dir, cleanup } = repoWithOrigin()
  const staging = join(dir, '.dsh-migrate', 'e2e-draft')
  try {
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'e2e.spec.ts'), 'export {}\n')
    const input = {
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      baseRef: 'origin/main',
      defaultBranch: 'main',
      forceRebase: true,
      stagingDir: staging,
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-branch'),
      index: INDEX,
      tag: 'dsh-v0.1.5-rc.1',
    }
    assert.equal(syncE2EBranch(input).pushed, true)
    const second = syncE2EBranch(input)
    assert.equal(second.ok, true)
    assert.equal(second.pushed, false)
    assert.equal(second.reason, 'no-change')
  } finally {
    cleanup()
  }
})

test('the runner prefers the repository script, then a playwright config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-cmd-'))
  try {
    writeFileSync(join(dir, 'playwright.config.ts'), 'export default {}')
    assert.equal(e2eCommand(dir, 'full', []), 'npx playwright test')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'playwright test' } }))
    assert.equal(e2eCommand(dir, 'full', []), 'npm run test:e2e')
    assert.match(e2eCommand(dir, 'subset', ['settings panel']) ?? '', /-g "settings panel"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no framework means no runnable command, not a silent pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-cmd-'))
  try {
    assert.equal(e2eCommand(dir, 'full', []), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failing test names are extracted for the next subset round', () => {
  const output = [
    '  ✘  1 settings panel (1.2s)',
    '  1) settings panel › filters the list ',
    '  2 failed',
  ].join('\n')
  const failed = parseFailedTests(output)
  assert.ok(failed.some(item => /settings panel/.test(item)))
  assert.match(e2eSignature(output, failed, false), /^e2e: /)
})

test('a timeout has its own signature so it never looks like a test failure', () => {
  assert.equal(e2eSignature('', [], true), 'e2e-timeout')
})

test('without a suite branch the E2E layer reports skipped rather than failing', () => {
  const { dir, cleanup } = repoWithOrigin()
  try {
    const result = runE2E({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      mode: 'subset',
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-run'),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, true)
    assert.match(result.skipped ?? '', /no dsh-migrate\/e2e branch yet/)
  } finally {
    cleanup()
  }
})

test('the suite runs against the migrated tree overlaid on its branch', () => {
  const { dir, cleanup } = repoWithOrigin()
  const staging = join(dir, '.dsh-migrate', 'e2e-draft')
  try {
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: '@acme/plugin', scripts: { 'test:e2e': 'node check.js' } }))
    writeFileSync(join(staging, 'check.js'), 'process.exit(0)\n')
    syncE2EBranch({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      baseRef: 'origin/main',
      defaultBranch: 'main',
      forceRebase: true,
      stagingDir: staging,
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-branch'),
      index: INDEX,
      tag: 'dsh-v0.1.5-rc.1',
    })

    let observedCwd = ''
    const passing = runE2E({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      mode: 'full',
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-run'),
      timeoutMs: 5_000,
      runCommand: (command, options) => {
        observedCwd = options.cwd
        assert.equal(command, 'npm run test:e2e')
        assert.equal(readFileSync(join(options.cwd, 'check.js'), 'utf8'), 'process.exit(0)\n')
        return { code: 0, output: '1 passed', timedOut: false }
      },
    })
    assert.equal(passing.ok, true)
    assert.match(observedCwd, /e2e-run/)

    const failing = runE2E({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      mode: 'subset',
      failing: ['settings panel'],
      worktreeDir: join(dir, '.dsh-migrate', 'e2e-run'),
      timeoutMs: 5_000,
      runCommand: () => ({ code: 1, output: '  ✘  1 settings panel (0.4s)\n1 failed', timedOut: false }),
    })
    assert.equal(failing.ok, false)
    assert.deepEqual(failing.failedTests, ['settings panel'])
  } finally {
    cleanup()
  }
})

test('a staged index is read back from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-idx-'))
  try {
    writeFileSync(join(dir, INDEX_FILE), JSON.stringify(INDEX))
    assert.equal(readIndex(join(dir, INDEX_FILE))?.features.length, 1)
    assert.equal(readIndex(join(dir, 'nope.json')), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tag from outside cannot add a line to the suite commit subject', () => {
  // The subject is a commit message, and the tag is a resolved version: one line.
  const { dir, origin, cleanup } = repoWithOrigin()
  const staging = join(dir, '.dsh-migrate', 'e2e-draft')
  const worktree = join(dir, '.dsh-migrate', 'e2e-branch')
  try {
    mkdirSync(join(staging, 'e2e', 'specs'), { recursive: true })
    writeFileSync(join(staging, 'e2e', 'specs', 'settings.spec.ts'), 'export {}\n')
    writeFileSync(join(staging, INDEX_FILE), JSON.stringify(INDEX))

    const result = syncE2EBranch({
      workdir: dir,
      branch: 'dsh-migrate/e2e',
      baseRef: 'origin/main',
      defaultBranch: 'main',
      forceRebase: true,
      stagingDir: staging,
      worktreeDir: worktree,
      index: INDEX,
      tag: 'dsh-v0.1.5\n::add-mask::forged-by-a-tag',
    })
    assert.equal(result.ok, true, result.ok ? '' : result.detail)
    const subject = git(origin, ['log', '-1', '--format=%B', 'dsh-migrate/e2e']).out.trim()
    assert.match(subject, /^test\(e2e\): cover dsh-v0\.1\.5 ::add-mask::forged-by-a-tag \(\d+ features\)$/)
    assert.equal(subject.includes('\n'), false)
  } finally {
    cleanup()
  }
})
