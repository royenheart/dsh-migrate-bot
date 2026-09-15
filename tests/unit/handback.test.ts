import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  applyHandback,
  invalidPublishTarget,
  publishSubject,
  type HandbackInput,
} from '../../src/deploy/handback.ts'
import { createGateRunner, renderGateReport } from '../../src/verify/gates.ts'
import { parseCommand } from '../../src/commands/parse.ts'
import { runCommand } from '../../src/commands/run.ts'
import type { BootOutcome } from '../../src/verify/boot.ts'
import { parseConfig } from '../../src/config/load.ts'

/**
 * A plugin repository with a pull request branch on a bare remote: the shape a
 * publish has to land in, with nothing stubbed except the gates.
 */
function fixture(): {
  bare: string
  work: string
  headSha: string
  branch: string
  diff: { text: string; applyTo: string }
  git: (args: string[]) => void
  cleanup: () => void
} {
  const bare = mkdtempSync(join(tmpdir(), 'dsh-handback-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-handback-work-'))
  const git = (args: string[], cwd = work): void => {
    const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
  }
  spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
  git(['init'])
  git(['config', 'user.name', 'test'])
  git(['config', 'user.email', 'test@example.test'])
  writeFileSync(join(work, 'index.js'), 'export const name = "plugin"\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])
  git(['remote', 'add', 'origin', bare])
  git(['push', '-u', 'origin', 'HEAD:master'])

  // The pull request branch the preview was built from.
  git(['checkout', '-b', 'dsh-migrate/0.1.6'])
  writeFileSync(join(work, 'index.js'), 'export const name = "plugin"\nexport const migrated = true\n')
  git(['add', '.'])
  git(['commit', '-m', 'migrate'])
  git(['push', '-u', 'origin', 'dsh-migrate/0.1.6'])
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout.trim()
  git(['checkout', 'master'])

  // A scratch diff on top of that head, as a target would serve it.
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-handback-scratch-'))
  git(['worktree', 'add', '--detach', scratch, headSha])
  writeFileSync(join(scratch, 'index.js'), 'export const name = "plugin"\nexport const migrated = true\nexport const tried = "scratch"\n')
  const diffText = spawnSync('git', ['diff', '--no-color'], { cwd: scratch, encoding: 'utf8' }).stdout
  git(['worktree', 'remove', '--force', scratch])
  rmSync(scratch, { recursive: true, force: true })

  return {
    bare,
    work,
    headSha,
    branch: 'dsh-migrate/0.1.6',
    diff: { text: diffText, applyTo: headSha },
    git,
    cleanup: () => {
      rmSync(bare, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    },
  }
}

const PASSING = async () => ({ ok: true, steps: [{ layer: 'mechanical' as const, ok: true, detail: 'passed' }], detail: 'mechanical: pass' })

function input(f: ReturnType<typeof fixture>, overrides: Partial<HandbackInput> = {}): HandbackInput {
  return {
    workdir: f.work,
    branch: f.branch,
    headSha: f.headSha,
    revision: 'rev-1',
    diff: f.diff.text,
    repository: 'me/plugin',
    pullRequest: 12,
    treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
    runGates: PASSING,
    log: () => {},
    ...overrides,
  }
}

test('a frozen revision is applied, gated, and pushed to the pull request branch', async () => {
  const f = fixture()
  try {
    const before = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    const result = await applyHandback(input(f))
    assert.equal(result.ok, true, result.ok ? '' : result.detail)
    assert.equal(result.ok && result.alreadyPublished, false)

    const after = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.notEqual(after, before)
    // The branch carries the change, on top of the head the target froze.
    const shown = spawnSync('git', ['-C', f.bare, 'show', `${f.branch}:index.js`], { encoding: 'utf8' }).stdout
    assert.match(shown, /tried = "scratch"/)
    const parent = spawnSync('git', ['-C', f.bare, 'rev-parse', `${f.branch}^`], { encoding: 'utf8' }).stdout.trim()
    assert.equal(parent, f.headSha)
    // The worktree does not survive the publish.
    const listed = spawnSync('git', ['-C', f.work, 'worktree', 'list'], { encoding: 'utf8' }).stdout
    assert.doesNotMatch(listed, /publish-tree/)
  } finally {
    f.cleanup()
  }
})

test('a failing gate leaves the branch exactly where it was', async () => {
  const f = fixture()
  try {
    const before = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    const result = await applyHandback(input(f, {
      runGates: async () => ({
        ok: false,
        steps: [{ layer: 'boot' as const, ok: false, detail: 'the plugin throws on load' }],
        refusedBy: 'boot' as const,
        detail: 'the plugin does not load',
      }),
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'gates')
    const after = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.equal(after, before)
    // The gate's own verdict is what the refused publish reports.
    assert.match(result.ok ? '' : renderGateReport(result.gates ?? { ok: false, steps: [], detail: '' }), /boot`: fail/)
  } finally {
    f.cleanup()
  }
})

test('a revision already on the branch is not applied twice', async () => {
  const f = fixture()
  try {
    const first = await applyHandback(input(f))
    assert.equal(first.ok, true, first.ok ? '' : first.detail)
    // The same revision arrives again: a retry of a publish whose reply never
    // reached the thread. It must not conflict with what it already pushed.
    let gated = 0
    const second = await applyHandback(input(f, {
      runGates: async () => {
        gated += 1
        return PASSING()
      },
    }))
    assert.equal(second.ok, true, second.ok ? '' : second.detail)
    assert.equal(second.ok && second.alreadyPublished, true)
    assert.equal(second.ok && second.commit, first.ok ? first.commit : '')
    assert.equal(gated, 0)
  } finally {
    f.cleanup()
  }
})

test('a diff that does not apply is refused without touching the branch', async () => {
  const f = fixture()
  try {
    const before = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    const result = await applyHandback(input(f, {
      diff: 'diff --git a/nothing.js b/nothing.js\n--- a/nothing.js\n+++ b/nothing.js\n@@ -1 +1 @@\n-nope\n+nope\n',
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'apply')
    const after = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.equal(after, before)
  } finally {
    f.cleanup()
  }
})

/** Push a competing commit onto the fixture's pull request branch. */
function compete(f: ReturnType<typeof fixture>, name: string): void {
  const git = (args: string[], cwd: string): void => {
    const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const other = mkdtempSync(join(tmpdir(), `dsh-handback-${name}-`))
  git(['clone', '--branch', f.branch, f.bare, other], tmpdir())
  git(['config', 'user.name', 'other'], other)
  git(['config', 'user.email', 'other@example.test'], other)
  writeFileSync(join(other, `${name}.js`), `export const ${name} = true\n`)
  git(['add', '.'], other)
  git(['commit', '-m', `${name} change`], other)
  git(['push', 'origin', f.branch], other)
  rmSync(other, { recursive: true, force: true })
}

test('a branch that moved since the freeze is refused before the gates are spent', async () => {
  const f = fixture()
  try {
    compete(f, 'theirs')
    let gated = 0
    const result = await applyHandback(input(f, {
      runGates: async () => {
        gated += 1
        return PASSING()
      },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'base')
    // The remedy is the one the contract names, and the gate run was not spent.
    assert.match(result.ok ? '' : result.detail, /rebuild scratch onto the new head and publish again/)
    assert.equal(gated, 0)
    // Nothing of the target's reached the branch.
    const log = spawnSync('git', ['-C', f.bare, 'log', '--format=%s', f.branch], { encoding: 'utf8' }).stdout
    assert.doesNotMatch(log, /publish/)
  } finally {
    f.cleanup()
  }
})

test('a branch that moves while the gates run is refused, not pushed', async () => {
  const f = fixture()
  try {
    const result = await applyHandback(input(f, {
      runGates: async () => {
        // The window a publish can lose the branch in: the gates take minutes,
        // and somebody else pushes in the meantime.
        compete(f, 'raced')
        return PASSING()
      },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'push')
    assert.match(result.ok ? '' : result.detail, /non-fast-forward|rejected|fetch first/i)
    // Their commit is still there, and ours never landed.
    const log = spawnSync('git', ['-C', f.bare, 'log', '--format=%s', f.branch], { encoding: 'utf8' }).stdout
    assert.match(log, /raced change/)
    assert.doesNotMatch(log, /publish/)
  } finally {
    f.cleanup()
  }
})

test('what a gate leaves behind is not what gets pushed', async () => {
  const f = fixture()
  try {
    let gated = ''
    const result = await applyHandback(input(f, {
      runGates: async (tree: string) => {
        gated = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).stdout.trim()
        // The gates run the plugin's own code: `npm install` creates
        // `node_modules` and can rewrite a lockfile, and a script of the user's
        // can commit. None of it is the change under review.
        const git = (args: string[]): void => {
          const out = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd: tree, encoding: 'utf8' })
          assert.equal(out.status, 0, out.stderr)
        }
        writeFileSync(join(tree, 'gate-fix.js'), 'export const fixed = true\n')
        mkdirSync(join(tree, 'node_modules', 'left-pad'), { recursive: true })
        writeFileSync(join(tree, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
        git(['add', '-A'])
        git(['commit', '-m', 'the gate committed its own fix'])
        return PASSING()
      },
    }))
    // The commit was taken before the gates ran and the push names it, so what
    // reached the branch is the tree that was verified — nothing the gates wrote.
    assert.equal(result.ok, true, result.ok ? '' : result.detail)
    assert.equal(result.ok && result.commit, gated)
    const shown = spawnSync('git', ['-C', f.bare, 'show', `${f.branch}:index.js`], { encoding: 'utf8' }).stdout
    assert.match(shown, /tried = "scratch"/)
    const tree = spawnSync('git', ['-C', f.bare, 'ls-tree', '--name-only', f.branch], { encoding: 'utf8' }).stdout
    assert.doesNotMatch(tree, /gate-fix\.js/)
    assert.doesNotMatch(tree, /node_modules/)
  } finally {
    f.cleanup()
  }
})

test('a gate that reports no layer at all cannot land a publish', async () => {
  const f = fixture()
  try {
    const result = await applyHandback(input(f, {
      runGates: async () => ({ ok: true, steps: [], detail: '' }),
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'gates')
    assert.match(result.ok ? '' : result.detail, /returned no layer verdict/)
    const log = spawnSync('git', ['-C', f.bare, 'log', '--format=%s', f.branch], { encoding: 'utf8' }).stdout
    assert.doesNotMatch(log, /publish/)
  } finally {
    f.cleanup()
  }
})

test('a revision the target cannot spell safely is refused', async () => {
  const f = fixture()
  try {
    // A NUL cannot be passed to a process at all; a newline forges a comment;
    // a backtick would let the target author the account of what happened.
    for (const revision of ['rev\u0000nul', 'rev\nbreak', 'rev` @here **landed**', 'x'.repeat(500)]) {
      const result = await applyHandback(input(f, { revision }))
      assert.equal(result.ok, false, `revision ${JSON.stringify(revision.slice(0, 20))} was accepted`)
      assert.equal(result.ok ? '' : result.stage, 'apply')
      assert.match(result.ok ? '' : result.detail, /cannot be used in a commit message or a report/)
    }
  } finally {
    f.cleanup()
  }
})

test('a remote that cannot be read is not reported as a push failure', async () => {
  const f = fixture()
  try {
    f.git(['remote', 'set-url', 'origin', join(tmpdir(), 'dsh-handback-nowhere')])
    const result = await applyHandback(input(f))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'remote')
    assert.match(result.ok ? '' : result.detail, /could not be read/)
    assert.doesNotMatch(result.ok ? '' : result.detail, /^could not fetch \S+: $/)
  } finally {
    f.cleanup()
  }
})

test('a checkout whose origin is another repository is refused', async () => {
  const f = fixture()
  try {
    f.git(['remote', 'set-url', 'origin', 'https://github.com/someone/else.git'])
    const result = await applyHandback(input(f, { repository: 'me/plugin' }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'remote')
    assert.match(result.ok ? '' : result.detail, /not `me\/plugin`/)
  } finally {
    f.cleanup()
  }
})

test('two publishes in one checkout do not destroy each other', async () => {
  const f = fixture()
  try {
    let firstTree = ''
    const [a, b] = await Promise.all([
      applyHandback(input(f, {
        revision: 'rev-a',
        runGates: async (tree: string) => {
          firstTree = tree
          // Long enough for the other publish to run its own worktree setup.
          await new Promise(resolve => { setTimeout(resolve, 300) })
          assert.equal(existsSync(tree), true, "the gate's tree was deleted by the other publish")
          return PASSING()
        },
      })),
      applyHandback(input(f, { revision: 'rev-b' })),
    ])
    const outcomes = [a, b]
    // One of them lands; whichever loses says why rather than reporting success.
    assert.equal(outcomes.some(result => result.ok), true)
    for (const result of outcomes) {
      if (!result.ok) assert.notEqual(result.detail, '')
    }
    assert.notEqual(firstTree, '')
    assert.equal(existsSync(firstTree), false)
  } finally {
    f.cleanup()
  }
})

test('a branch name or commit a target chose is refused before it reaches git', async () => {
  assert.equal(invalidPublishTarget({ branch: 'dsh-migrate/0.1.6', headSha: 'a'.repeat(40), revision: 'r' }), undefined)
  assert.match(invalidPublishTarget({ branch: '--force', headSha: 'a'.repeat(40), revision: 'r' }) ?? '', /not a branch name/)
  assert.match(invalidPublishTarget({ branch: 'a..b', headSha: 'a'.repeat(40), revision: 'r' }) ?? '', /not a branch name/)
  assert.match(invalidPublishTarget({ branch: 'main', headSha: 'HEAD~1', revision: 'r' }) ?? '', /not a commit/)
  assert.match(invalidPublishTarget({ branch: 'main', headSha: 'a'.repeat(40), revision: 'r\nx' }) ?? '', /commit message/)

  const f = fixture()
  try {
    const result = await applyHandback(input(f, { branch: '--upload-pack=touch /tmp/pwned' }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'apply')
  } finally {
    f.cleanup()
  }
})

test('the gate runner refuses on mechanical, on boot, and on a blocking suite', async () => {
  const config = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
  const runner = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: false, errors: 'tests failed: 3' }),
  })
  const refused = await runner('/tmp/tree')
  assert.equal(refused.ok, false)
  assert.equal(refused.refusedBy, 'mechanical')
  assert.match(renderGateReport(refused), /mechanical`: fail/)

  const boot = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true }),
    boot: async () => ({ outcome: 'fail', signature: 'load: throws', detail: 'stack' }),
  })
  const bootRefused = await boot('/tmp/tree')
  assert.equal(bootRefused.refusedBy, 'boot')

  // An advisory suite reports its verdict without refusing.
  const advisory = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true }),
    boot: async () => ({ outcome: 'pass', signature: 'loaded', detail: '' }),
    e2e: () => ({ ok: false, layer: 'e2e', signature: 'e2e: 1 failed', detail: 'one test failed' }),
  })
  const advisoryReport = await advisory('/tmp/tree')
  assert.equal(advisoryReport.ok, true)
  assert.match(renderGateReport(advisoryReport), /e2e`: fail/)

  const blocking = createGateRunner({
    config: parseConfig({ e2e: { gate: 'blocking' } }),
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true }),
    boot: async () => ({ outcome: 'pass', signature: 'loaded', detail: '' }),
    e2e: () => ({ ok: false, layer: 'e2e', signature: 'e2e: 1 failed', detail: 'one test failed' }),
  })
  const blockingReport = await blocking('/tmp/tree')
  assert.equal(blockingReport.ok, false)
  assert.equal(blockingReport.refusedBy, 'e2e')
})

test('the commit a publish makes is identifiable by its revision', () => {
  assert.equal(publishSubject('rev-1', 12), 'dsh-migrate: publish rev-1 (PR #12)')
})

test('the fixture is a pull request branch plus a scratch diff on top of it', () => {
  const f = fixture()
  try {
    assert.match(f.diff.text, /^diff --git/)
    assert.match(f.diff.text, /tried = "scratch"/)
    // The worktree is back on the default branch; the pull request branch lives
    // on the remote, which is where a publish pushes.
    const onBranch = spawnSync('git', ['-C', f.bare, 'show', `${f.branch}:index.js`], { encoding: 'utf8' }).stdout
    assert.match(onBranch, /migrated = true/)
    assert.doesNotMatch(readFileSync(join(f.work, 'index.js'), 'utf8'), /migrated = true/)
  } finally {
    f.cleanup()
  }
})

/** A target that freezes a revision, serves it as a diff, and reports a preview. */
function publishTarget(f: ReturnType<typeof fixture>, options: { freeze?: unknown; diff?: string } = {}): {
  fetchImpl: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.startsWith('https://api.github.com/repos/me/plugin/pulls/12')) {
      return new Response(JSON.stringify({
        number: 12,
        state: 'open',
        merged: false,
        html_url: 'https://github.com/me/plugin/pull/12',
        title: 'migrate',
        body: '',
        head: { ref: f.branch, sha: f.headSha },
      }), { status: 200 })
    }
    if (url.includes('/scratch')) {
      return new Response(options.diff ?? JSON.stringify({ diff: f.diff.text }), {
        status: 200,
        headers: { 'content-type': options.diff === undefined ? 'application/json' : 'text/x-patch' },
      })
    }
    if (url.includes('/previews/')) {
      return new Response(JSON.stringify(options.freeze ?? {
        revision: 'rev-1',
        baseSha: f.headSha,
        headSha: f.headSha,
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return { fetchImpl, calls }
}

async function runPublish(
  f: ReturnType<typeof fixture>,
  overrides: {
    freeze?: unknown
    diff?: string
    gates?: HandbackInput['runGates']
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<{ outcome: Awaited<ReturnType<typeof runCommand>>; calls: string[] }> {
  const { fetchImpl, calls } = publishTarget(f, {
    ...(overrides.freeze === undefined ? {} : { freeze: overrides.freeze }),
    ...(overrides.diff === undefined ? {} : { diff: overrides.diff }),
  })
  const parsed = parseCommand('/dsh-migrate publish')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: {
      DSH_MIGRATE_DEPLOY_TOKEN: 'secret',
      GITHUB_TOKEN: 'ghs_read',
      GITHUB_REPOSITORY: 'me/plugin',
      ...overrides.env,
    },
    workdir: f.work,
    pullRequest: 12,
    commentId: '42',
    log: () => {},
    gates: overrides.gates ?? PASSING,
    treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
    fetchImpl,
  })
  return { outcome, calls }
}

test('publish freezes, fetches, applies, gates, and pushes through the Action', async () => {
  const f = fixture()
  try {
    const before = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    const { outcome, calls } = await runPublish(f)
    assert.equal(outcome.ok, true, outcome.reply)
    assert.match(outcome.reply, /`publish` landed\./)
    assert.match(outcome.reply, /`mechanical`: pass/)
    // The effectful success is handed back to be recorded, like any other verb.
    assert.equal(outcome.record?.verb, 'publish')

    // Everything that can refuse is read first — the pull request, so the branch
    // is known — and only then is the target asked to freeze a revision.
    assert.match(calls[0] ?? '', /^GET https:\/\/api\.github\.com\/repos\/me\/plugin\/pulls\/12/)
    assert.match(calls[1] ?? '', /^POST https:\/\/deploy\.test\/previews\//)
    assert.match(calls[2] ?? '', /GET https:\/\/deploy\.test\/previews\/.+\/scratch\?revision=rev-1/)

    const after = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.notEqual(after, before)
    const shown = spawnSync('git', ['-C', f.bare, 'show', `${f.branch}:index.js`], { encoding: 'utf8' }).stdout
    assert.match(shown, /tried = "scratch"/)
  } finally {
    f.cleanup()
  }
})

test('a target that only acknowledges the request is told what it owes', async () => {
  const f = fixture()
  try {
    const { outcome, calls } = await runPublish(f, { freeze: { ok: true } })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /acknowledged the request without freezing a revision/)
    assert.match(outcome.reply, /the-publish-hand-back/)
    // Nothing was fetched and nothing reached the branch: there was no revision.
    assert.equal(calls.filter(call => call.includes('/scratch')).length, 0)
    assert.equal(spawnSync('git', ['-C', f.bare, 'log', '--oneline', f.branch], { encoding: 'utf8' }).stdout.trim().split('\n').length, 2)
  } finally {
    f.cleanup()
  }
})

test('an empty scratch diff is refused rather than pushed as a change', async () => {
  const f = fixture()
  try {
    const { outcome } = await runPublish(f, { diff: '' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /empty diff/)
  } finally {
    f.cleanup()
  }
})

test('a patch served as a plain body is applied just as a JSON one is', async () => {
  const f = fixture()
  try {
    const { outcome } = await runPublish(f, { diff: f.diff.text })
    assert.equal(outcome.ok, true, outcome.reply)
    const shown = spawnSync('git', ['-C', f.bare, 'show', `${f.branch}:index.js`], { encoding: 'utf8' }).stdout
    assert.match(shown, /tried = "scratch"/)
  } finally {
    f.cleanup()
  }
})

test('a publish without a GitHub token refuses instead of guessing the branch', async () => {
  const f = fixture()
  try {
    const { outcome } = await runPublish(f, { env: { GITHUB_TOKEN: '' } })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /`GITHUB_TOKEN` is not set/)
  } finally {
    f.cleanup()
  }
})

test('a failing gate refuses the publish and leaves the branch alone', async () => {
  const f = fixture()
  try {
    const before = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    const { outcome } = await runPublish(f, {
      gates: async () => ({
        ok: false,
        steps: [{ layer: 'boot', ok: false, detail: 'the plugin throws on load' }],
        refusedBy: 'boot',
        detail: 'the plugin does not load',
      }),
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /`publish` was refused:\*\* the gates refused it/)
    assert.match(outcome.reply, /`boot`: fail/)
    assert.equal(outcome.record, undefined, 'a refused publish is not recorded, so it stays retryable')
    const after = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.equal(after, before)
  } finally {
    f.cleanup()
  }
})

test('a publish this invocation cannot verify refuses instead of pushing ungated', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      fetchImpl,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /cannot run the gate stack/)
  } finally {
    f.cleanup()
  }
})

test('a publish that cannot gate never asks the target to freeze anything', async () => {
  const f = fixture()
  try {
    const { fetchImpl, calls } = publishTarget(f)
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      fetchImpl,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /cannot run the gate stack/)
    assert.deepEqual(calls, [], 'the target was asked nothing')
  } finally {
    f.cleanup()
  }
})

test('a blocking suite this invocation cannot run refuses instead of passing quietly', async () => {
  const config = parseConfig({ e2e: { gate: 'blocking' } })
  const runner = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true }),
    boot: async () => ({ outcome: 'pass', signature: 'loaded', detail: '' }),
    // No `e2e` port: this invocation cannot run the suite the user made blocking.
  })
  const report = await runner('/tmp/tree')
  assert.equal(report.ok, false)
  assert.equal(report.refusedBy, 'e2e')
  assert.match(report.detail, /cannot be verified/)
  assert.match(renderGateReport(report), /e2e`: skipped \(no end-to-end runner in this invocation\)/)
})

test('a layer that throws is a refusal, never a pass', async () => {
  const config = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
  const mechanical = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => { throw new Error('the install command is missing') },
  })
  const first = await mechanical('/tmp/tree')
  assert.equal(first.ok, false)
  assert.equal(first.refusedBy, 'mechanical')
  assert.match(first.detail, /could not run: the install command is missing/)

  const boot = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true }),
    boot: async () => { throw new Error('npm registry unreachable') },
  })
  const second = await boot('/tmp/tree')
  assert.equal(second.refusedBy, 'boot')
  assert.match(second.detail, /could not run: npm registry unreachable/)
})

test('the tag is resolved once per gate run, and a failure to resolve refuses the whole stack', async () => {
  const config = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
  let resolved = 0
  const runner = createGateRunner({
    config,
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    dshTag: async () => {
      resolved += 1
      throw new Error('no dsh-v* tag found')
    },
    // The mechanical layer is injected, so nothing needs the tag at all.
    mechanical: () => ({ ok: true }),
    boot: async () => ({ outcome: 'pass', signature: 'loaded', detail: '' }),
  })
  // A resolver that fails is the whole stack's problem, and the report says so
  // rather than blaming the layer that happened to call it first.
  const refusedByTag = await runner('/tmp/tree')
  assert.equal(refusedByTag.ok, false)
  assert.match(refusedByTag.detail, /harness version to verify against could not be resolved/)
  assert.equal(resolved, 1)

  // A resolver that answers is used once, and named in the report.
  const answered = createGateRunner({
    config,
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    dshTag: async () => 'dsh-v0.1.6',
    mechanical: () => ({ ok: true, checks: 1 }),
    boot: async () => ({ outcome: 'pass', signature: 'loaded', detail: '' }),
  })
  const report = await answered('/tmp/tree')
  assert.equal(report.ok, true)
  assert.equal(report.tag, 'dsh-v0.1.6')
})

test('a similar subject on the branch never makes a publish a no-op', async () => {
  const f = fixture()
  try {
    // An unrelated commit whose subject quotes a near-miss revision.
    const git = (args: string[], cwd: string): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-handback-subject-'))
    git(['clone', '--branch', f.branch, f.bare, scratch], tmpdir())
    git(['config', 'user.name', 'other'], scratch)
    git(['config', 'user.email', 'other@example.test'], scratch)
    writeFileSync(join(scratch, 'other.js'), 'export const other = true\n')
    git(['add', '.'], scratch)
    git(['commit', '-m', 'dsh-migrate: publish rev-12 (PR #12)'], scratch)
    git(['push', 'origin', f.branch], scratch)
    rmSync(scratch, { recursive: true, force: true })

    const result = await applyHandback(input(f, { revision: 'rev-1' }))
    // Not a no-op: the similar subject is not this revision. It is refused
    // because the branch moved while the diff was being prepared.
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'base')
  } finally {
    f.cleanup()
  }
})

test('a reverted publish is not reported as already landed', async () => {
  const f = fixture()
  try {
    const first = await applyHandback(input(f, { revision: 'rev-1' }))
    assert.equal(first.ok, true, first.ok ? '' : first.detail)
    assert.equal(first.ok && first.alreadyPublished, false)

    // A maintainer reverts it: the commit that carries the subject is still in
    // the history, and the change is not.
    f.git(['fetch', 'origin', `+refs/heads/${f.branch}:refs/remotes/origin/${f.branch}`])
    f.git(['checkout', '-B', f.branch, `refs/remotes/origin/${f.branch}`])
    f.git(['revert', '--no-edit', 'HEAD'])
    f.git(['push', 'origin', `${f.branch}:refs/heads/${f.branch}`])
    f.git(['checkout', 'master'])

    const again = await applyHandback(input(f, { revision: 'rev-1' }))
    assert.equal(again.ok, false)
    assert.equal(again.ok ? '' : again.stage, 'base')
    // Nothing claims the revision is on the branch.
    assert.doesNotMatch(again.ok ? '' : again.detail, /already on/)
  } finally {
    f.cleanup()
  }
})

test('a pull request whose head lives in a fork is refused, not pushed to the wrong branch', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const forked: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/repos/me/plugin/pulls/12')) {
        return new Response(JSON.stringify({
          number: 12,
          state: 'open',
          merged: false,
          html_url: 'https://github.com/me/plugin/pull/12',
          title: 'from a fork',
          body: '',
          head: { ref: 'patch-1', sha: f.headSha, repo: { full_name: 'stranger/plugin' } },
        }), { status: 200 })
      }
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: forked,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /has its head in `stranger\/plugin`/)
    assert.match(outcome.reply, /does not write to a fork/)
  } finally {
    f.cleanup()
  }
})

test('a leftover worktree registration does not break the next publish', async () => {
  const f = fixture()
  const treeBase = join(f.work, '.dsh-migrate', 'publish-tree')
  try {
    // The damage a `kill -9` leaves: a registration whose directory is gone.
    mkdirSync(dirname(treeBase), { recursive: true })
    f.git(['worktree', 'add', '--force', '--detach', treeBase, f.headSha])
    rmSync(treeBase, { recursive: true, force: true })
    const before = spawnSync('git', ['-C', f.work, 'worktree', 'list'], { encoding: 'utf8' }).stdout
      .split('\n').filter(line => line.includes('publish-tree')).length
    assert.equal(before, 1)

    const result = await applyHandback(input(f, { treeDir: treeBase, revision: 'rev-leftover' }))
    assert.equal(result.ok, true, result.ok ? '' : result.detail)
    // The killed run's registration is pruned rather than tolerated: nothing of
    // the failed publish is left in the consumer's repository.
    const after = spawnSync('git', ['-C', f.work, 'worktree', 'list'], { encoding: 'utf8' }).stdout
      .split('\n').filter(line => line.includes('publish-tree')).length
    assert.equal(after, 0)
    const shown = spawnSync('git', ['-C', f.bare, 'show', `${f.branch}:index.js`], { encoding: 'utf8' }).stdout
    assert.match(shown, /tried = "scratch"/)
  } finally {
    f.cleanup()
  }
})

test('the gate runner refuses a boot probe that timed out, and a stack that ran nothing', async () => {
  const config = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
  const timedOut = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true, checks: 2 }),
    boot: async () => ({ outcome: 'timeout', signature: 'timeout: boot did not finish', detail: 'the host never printed ready' }),
  })
  const hung = await timedOut('/tmp/tree')
  // A probe that never finished says nothing about the plugin, and counting it
  // as loaded is how a hung boot would reach a branch.
  assert.equal(hung.ok, false)
  assert.equal(hung.refusedBy, 'boot')
  assert.match(hung.detail, /never observed to load/)
  assert.match(renderGateReport(hung), /boot`: fail/)

  const unchecked = createGateRunner({
    config: parseConfig({ verify: { boot: { enabled: false } }, e2e: { enabled: false } }),
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    // A plugin with no declared build, typecheck or test command: the mechanical
    // layer ran only its installs.
    mechanical: () => ({ ok: true, checks: 0 }),
  })
  const nothing = await unchecked('/tmp/tree')
  assert.equal(nothing.ok, false)
  assert.match(nothing.detail, /no gate layer ran/)
  assert.match(renderGateReport(nothing), /boot`: skipped/)
})

test('the web smoke is a layer of the stack, and its absence is stated', async () => {
  const config = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
  const failing = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true, checks: 1 }),
    boot: async () => ({ outcome: 'pass', signature: 'loaded', detail: '' }),
    web: () => ({ ok: false, layer: 'web', signature: 'web: the client bundle never became ready', detail: 'timeout' }),
  })
  const refused = await failing('/tmp/tree')
  assert.equal(refused.ok, false)
  assert.equal(refused.refusedBy, 'web')

  const absent = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    mechanical: () => ({ ok: true, checks: 1 }),
    boot: async () => ({ outcome: 'pass', signature: 'loaded', detail: '' }),
  })
  const stated = await absent('/tmp/tree')
  assert.equal(stated.ok, true)
  assert.match(renderGateReport(stated), /web`: skipped \(no web smoke in this invocation\)/)
})

test('a tag the state branch carries cannot forge a line of the publish reply', async () => {
  // The tag is the recorded one when the run read it from the state branch, and
  // the reply is a comment: one line of it, like every other value from outside
  // this invocation.
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    // What the target is told is part of the same record: the tag it receives is
    // collapsed the way the reply's is.
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).includes('publish-result')) bodies.push(String(init?.body ?? ''))
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: async () => ({
        ok: true,
        steps: [{ layer: 'mechanical' as const, ok: true, detail: 'passed' }],
        tag: 'dsh-v0.1.5\n- @everyone approved this migration',
        detail: 'mechanical: pass',
      }),
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(outcome.ok, true, outcome.reply)
    assert.equal(outcome.reply.split('\n').filter(line => line.startsWith('- @everyone')).length, 0)
    assert.match(outcome.reply, /Verified against `dsh-v0\.1\.5 - @everyone approved this migration`/)
    assert.equal(bodies.length, 1)
    const reported = JSON.parse(bodies[0] ?? '{}') as { tag?: string }
    assert.equal(reported.tag, 'dsh-v0.1.5 - @everyone approved this migration')
  } finally {
    f.cleanup()
  }
})

test('the reply names the tag the gates verified against', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: async () => ({
        ok: true,
        steps: [{ layer: 'mechanical' as const, ok: true, detail: 'passed' }],
        tag: 'dsh-v0.1.6',
        detail: 'mechanical: pass',
      }),
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl,
    })
    assert.equal(outcome.ok, true, outcome.reply)
    assert.match(outcome.reply, /Verified against `dsh-v0\.1\.6`/)
  } finally {
    f.cleanup()
  }
})

test('a hand-back that throws still answers on the thread', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      // A gate that throws where the runner cannot catch it (it is the runner).
      gates: () => { throw new Error('the gate runner itself exploded') },
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /the gate runner itself exploded/)
  } finally {
    f.cleanup()
  }
})

test('the target is told how the publish ended, including which gate refused', async () => {
  const f = fixture()
  try {
    const { fetchImpl, calls } = publishTarget(f)
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) {
        bodies.push(typeof init?.body === 'string' ? init.body : '')
      }
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(outcome.ok, true, outcome.reply)
    assert.equal(bodies.length, 1)
    const reported = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    assert.equal(reported.outcome, 'published')
    assert.equal(reported.revision, 'rev-1')
    assert.equal(reported.branch, f.branch)
    assert.match(String(reported.commit), /^[0-9a-f]{7,40}$/)
    assert.deepEqual(reported.gates, [{ layer: 'mechanical', ok: true, detail: 'passed' }])
    // The call is on the preview path, and it carries no idempotency key: it is
    // a report about a request, not a request.
    assert.match(calls.filter(call => call.includes('publish-result'))[0] ?? '', /POST https:\/\/deploy\.test\/previews\/.+\/publish-result/)
  } finally {
    f.cleanup()
  }
})

test('a refused publish is reported with the stage that refused it', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) {
        bodies.push(typeof init?.body === 'string' ? init.body : '')
      }
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: async () => ({
        ok: false,
        steps: [{ layer: 'boot' as const, ok: false, detail: 'the plugin throws on load' }],
        refusedBy: 'boot' as const,
        detail: 'the plugin does not load',
      }),
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(outcome.ok, false)
    assert.equal(bodies.length, 1)
    const reported = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    assert.equal(reported.outcome, 'refused')
    assert.equal(reported.stage, 'gates')
    assert.equal(reported.commit, undefined)
  } finally {
    f.cleanup()
  }
})

test('a target that cannot be told does not fail the publish', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const refusing: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) return new Response('nope', { status: 404 })
      return await fetchImpl(input, init)
    }
    const lines: string[] = []
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: (message: string) => lines.push(message),
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: refusing,
    })
    // The change landed; the missing endpoint is a line in the log.
    assert.equal(outcome.ok, true, outcome.reply)
    assert.match(lines.join('\n'), /the target was not told how it ended/)
  } finally {
    f.cleanup()
  }
})

test('a hand-back that stops with an error says so on the thread and at the target', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) {
        bodies.push(typeof init?.body === 'string' ? init.body : '')
      }
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: () => { throw new Error('the gate runner exploded') },
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /the gate runner exploded/)
    // The preview is not left waiting for an outcome that will never come.
    assert.equal(bodies.length, 1)
    const reported = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    assert.equal(reported.outcome, 'refused')
    assert.equal(reported.stage, 'error')
    assert.match(String(reported.detail), /the gate runner exploded/)
  } finally {
    f.cleanup()
  }
})

test('a git that cannot even start is a refusal with its own reason', async () => {
  const f = fixture()
  try {
    // A checkout that is gone: `spawnSync` cannot start, which is not a git
    // exit code, and an empty reason would be the only thing the thread sees.
    const result = await applyHandback(input(f, { workdir: join(f.work, 'gone', 'deeper') }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'remote')
    assert.notEqual(result.ok ? '' : result.detail, '')
    assert.match(result.ok ? '' : result.detail, /git could not run|could not be read|no `origin` remote/)
  } finally {
    f.cleanup()
  }
})

test('the preview state parser reads what a target sends and nothing else', async () => {
  const { parsePreviewState, parseFrozenRevision } = await import('../../src/deploy/client.ts')
  assert.deepEqual(parsePreviewState(undefined), {})
  assert.deepEqual(parsePreviewState('running'), {})
  assert.deepEqual(parsePreviewState([{ state: 'running' }]), {})
  assert.deepEqual(parsePreviewState({ state: 'running', url: 'https://x.test', safe_url: 'https://x.test/safe' }), {
    state: 'running',
    url: 'https://x.test',
    safeUrl: 'https://x.test/safe',
  })
  assert.deepEqual(parsePreviewState({ status: 'stopped' }), { state: 'stopped' })
  // A number where a string belongs is ignored rather than coerced.
  assert.deepEqual(parsePreviewState({ extendedDays: '7' }), {})
  assert.deepEqual(parsePreviewState({ extendedDays: 7 }), { extendedDays: 7 })
  assert.deepEqual(parsePreviewState({ headSha: '', revision: '' }), {})
  // A publish answer without a revision is an acknowledgement, not a hand-back.
  assert.equal(parseFrozenRevision({ ok: true }), undefined)
  assert.equal(parseFrozenRevision('rev'), undefined)
  assert.deepEqual(parseFrozenRevision({ revision: 'rev-1', headSha: 'a'.repeat(40) }), {
    revision: 'rev-1',
    headSha: 'a'.repeat(40),
  })
})

test('a publish whose diff only touches a non-ASCII path is still a publish', async () => {
  const f = fixture()
  try {
    // git quotes a path that is not plain ASCII in `--name-only`, and the quoted
    // string matches no pathspec: the survival check has to read the names
    // unquoted or a reverted publish looks like a landed one.
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-handback-unicode-'))
    const git = (args: string[], cwd: string): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git(['clone', '--branch', f.branch, f.bare, scratch], tmpdir())
    git(['config', 'user.name', 'test'], scratch)
    git(['config', 'user.email', 'test@example.test'], scratch)
    writeFileSync(join(scratch, 'café.js'), 'export const café = 1\n')
    git(['add', '.'], scratch)
    git(['commit', '-m', 'the frozen head'], scratch)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout.trim()
    // The frozen head is the branch tip; the scratch change is on top of it and
    // has not been pushed anywhere.
    git(['push', 'origin', `${f.branch}:refs/heads/${f.branch}`], scratch)
    writeFileSync(join(scratch, 'café.js'), 'export const café = 2\n')
    git(['add', '.'], scratch)
    git(['commit', '-m', 'scratch'], scratch)
    const diff = spawnSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout

    const first = await applyHandback(input(f, { revision: 'rev-uni', headSha: head, diff }))
    assert.equal(first.ok, true, first.ok ? '' : first.detail)

    // The maintainer reverts the published commit, and the same revision is
    // delivered again.
    git(['fetch', 'origin', `+refs/heads/${f.branch}:refs/remotes/origin/${f.branch}`], scratch)
    git(['checkout', '-B', f.branch, `refs/remotes/origin/${f.branch}`], scratch)
    git(['revert', '--no-edit', 'HEAD'], scratch)
    git(['push', 'origin', `${f.branch}:refs/heads/${f.branch}`], scratch)
    rmSync(scratch, { recursive: true, force: true })

    const again = await applyHandback(input(f, { revision: 'rev-uni', headSha: head, diff }))
    assert.equal(again.ok, false)
    // Whatever it refuses for, it must not claim the revision is on the branch:
    // that was the defect.
    assert.doesNotMatch(again.ok ? '' : again.detail, /already on/)
  } finally {
    f.cleanup()
  }
})

test('the remote a checkout points at is read as a repository, or not at all', async () => {
  const { remoteRepository } = await import('../../src/deploy/handback.ts')
  assert.equal(remoteRepository('https://github.com/me/plugin.git'), 'me/plugin')
  assert.equal(remoteRepository('git@github.com:me/plugin.git'), 'me/plugin')
  assert.equal(remoteRepository('ssh://git@github.com:22/me/plugin.git'), 'me/plugin')
  assert.equal(remoteRepository('https://github.com:443/me/plugin'), 'me/plugin')
  assert.equal(remoteRepository('https://github.com/me/plugin/'), 'me/plugin')
  // A host that merely contains github.com is not GitHub, and a non-GitHub
  // remote is not something to make a claim about either way.
  assert.equal(remoteRepository('https://github.com.evil.example/me/plugin.git'), undefined)
  assert.equal(remoteRepository('https://mirror.example/github.com/me/plugin.git'), undefined)
  assert.equal(remoteRepository('/tmp/somewhere/bare.git'), undefined)
  assert.equal(remoteRepository(''), undefined)
})
test('a checkout URL with a port, and a host that only looks like GitHub', async () => {
  const f = fixture()
  try {
    // A genuine mismatch is refused before anything is fetched.
    f.git(['remote', 'set-url', 'origin', 'https://github.com/someone/else.git'])
    const mismatch = await applyHandback(input(f, { repository: 'me/plugin' }))
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.ok ? '' : mismatch.detail, /not `me\/plugin`/)
  } finally {
    f.cleanup()
  }
})

test('the CLI drives a publish end to end: freeze, diff, gates, push, report', async () => {
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const f = fixture()
  // The tree a publish gates is the pull request branch, so the fixture plugin
  // has to be on it — and the frozen head is then that branch's tip.
  writeFileSync(join(f.work, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(f.work, 'package.json'), JSON.stringify({
    name: 'fixture-plugin',
    version: '1.0.0',
    scripts: { test: 'echo ok' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  f.git(['checkout', f.branch])
  f.git(['add', '-A'])
  f.git(['commit', '-m', 'the plugin on the branch'])
  f.git(['push', 'origin', f.branch])
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.work, encoding: 'utf8' }).stdout.trim()
  f.git(['checkout', 'master'])
  const calls: string[] = []
  const reported: string[] = []
  const server = createServer((request, response) => {
    calls.push(`${request.method ?? ''} ${request.url ?? ''}`)
    const url = request.url ?? ''
    const json = (value: unknown): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      if (url.startsWith('/repos/me/plugin/pulls/12')) {
        json({ number: 12, state: 'open', merged: false, html_url: 'https://github.com/me/plugin/pull/12', title: 'migrate', body: '', head: { ref: f.branch, sha: headSha, repo: { full_name: 'me/plugin' } } })
        return
      }
      if (url.includes('/scratch')) {
        json({ diff: f.diff.text })
        return
      }
      if (url.endsWith('/publish-result')) {
        reported.push(body)
        json({ ok: true })
        return
      }
      if (url.includes('/previews/')) {
        json({ revision: 'rev-cli', baseSha: headSha, headSha })
        return
      }
      json({})
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    // A plugin the mechanical layer can actually run: one cheap check and no
    // dependencies, so the gate is the real one and the run stays offline.
    writeFileSync(
      join(f.work, '.dsh-migrate.yml'),
      [
        // Pinned, so the gate stack resolves the harness without a release lookup.
        'dshVersion: 0.1.6',
        'deploy:',
        '  enabled: true',
        `  endpoint: http://127.0.0.1:${String(port)}`,
        'verify:',
        '  boot:',
        '    enabled: false',
        '  web:',
        '    enabled: false',
        'e2e:',
        '  enabled: false',
        '',
      ].join('\n'),
    )
    f.git(['add', '-A'])
    f.git(['commit', '-m', 'fixture'])

    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'command',
      '--workdir', f.work,
      '--config', '.dsh-migrate.yml',
      '--comment-body', '/dsh-migrate publish',
      '--comment-id', '77',
      '--comment-author', 'me',
      '--comment-author-association', 'OWNER',
      '--issue-number', '12',
      '--pull-request', '12',
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DSH_MIGRATE_DEPLOY_TOKEN: 'secret',
        GITHUB_TOKEN: 'ghs_read',
        GITHUB_REPOSITORY: 'me/plugin',
        // The GitHub API the CLI talks to is the stub above.
        GITHUB_API_URL: `http://127.0.0.1:${String(port)}`,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const status = await new Promise<number | null>(resolve => { child.on('close', code => { resolve(code) }) })
    assert.equal(status, 0, stderr)
    assert.match(stdout, /`publish` landed\./)
    assert.match(stdout, /`mechanical`: pass/)

    // The order is the contract: freeze, then the diff, then the report — and the
    // reply on the thread comes last, from the CLI.
    const preview = calls.filter(call => call.startsWith('POST /previews/') || call.startsWith('GET /previews/'))
    assert.match(preview[0] ?? '', /^POST \/previews\/me%2Fplugin\/12$/)
    assert.match(preview[1] ?? '', /^GET \/previews\/.*\/scratch\?revision=rev-cli/)
    assert.match(preview[2] ?? '', /^POST \/previews\/.*\/publish-result/)
    assert.match(calls.at(-1) ?? '', /^POST \/repos\/me\/plugin\/issues\/12\/comments/)
    const outcome = JSON.parse(reported[0] ?? '{}') as Record<string, unknown>
    assert.equal(outcome.outcome, 'published')
    assert.equal(outcome.revision, 'rev-cli')

    const shown = spawnSync('git', ['-C', f.bare, 'show', `${f.branch}:index.js`], { encoding: 'utf8' }).stdout
    assert.match(shown, /tried = "scratch"/)
    // And the command was recorded, so its redelivery is a repeat.
    const branch = spawnSync('git', ['-C', f.bare, 'show', 'dsh-migrate/state:seen.json'], { encoding: 'utf8' })
    if (branch.status === 0) assert.match(branch.stdout, /publish:comment=77/)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    f.cleanup()
  }
})

test('a refusal after the freeze still tells the target, so the preview is not left waiting', async () => {
  const f = fixture()
  try {
    // The target freezes a revision and then serves an empty diff: the Action
    // cannot apply it, and the preview has to hear that rather than wait.
    const { fetchImpl } = publishTarget(f, { diff: '' })
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) bodies.push(typeof init?.body === 'string' ? init.body : '')
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /empty diff/)
    assert.equal(bodies.length, 1)
    const reported = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    assert.equal(reported.outcome, 'refused')
    assert.equal(reported.revision, 'rev-1')
  } finally {
    f.cleanup()
  }
})

test('a revision the target cannot spell is refused and reported, not logged raw', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f, { freeze: { revision: 'rev\nbreak', headSha: f.headSha } })
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) bodies.push(typeof init?.body === 'string' ? init.body : '')
      return await fetchImpl(input, init)
    }
    const lines: string[] = []
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: (message: string) => lines.push(message),
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /cannot be used in a commit message or a report/)
    // The revision is never echoed, so it cannot forge a log or live-view line.
    assert.doesNotMatch(lines.join('\n'), /rev\nbreak/)
    assert.equal(lines.filter(line => line.includes('frozen revision')).length, 0)
    assert.equal(bodies.length, 1)
  } finally {
    f.cleanup()
  }
})

test('a publish on a pull request that is not open is refused', async () => {
  const f = fixture()
  try {
    for (const state of ['merged', 'closed']) {
      const { fetchImpl } = publishTarget(f)
      const stub: typeof fetch = async (input, init) => {
        if (String(input).startsWith('https://api.github.com/repos/me/plugin/pulls/12')) {
          return new Response(JSON.stringify({
            number: 12,
            state,
            merged: state === 'merged',
            html_url: 'https://github.com/me/plugin/pull/12',
            title: 'migrate',
            body: '',
            head: { ref: f.branch, sha: f.headSha, repo: { full_name: 'me/plugin' } },
          }), { status: 200 })
        }
        return await fetchImpl(input, init)
      }
      const parsed = parseCommand('/dsh-migrate publish')
      const outcome = await runCommand({
        command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
        config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
        env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
        workdir: f.work,
        pullRequest: 12,
        commentId: '42',
        log: () => {},
        gates: PASSING,
        treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
        fetchImpl: stub,
      })
      assert.equal(outcome.ok, false, `${state} was accepted`)
      assert.match(outcome.reply, new RegExp(`pull request #12 is ${state}`))
    }
  } finally {
    f.cleanup()
  }
})

test('a view URL a target chose is linked or dropped, never republished as-is', async () => {
  const { externalUrl } = await import('../../src/render/text.ts')
  assert.equal(externalUrl('https://deploy.test/view/abc'), 'https://deploy.test/view/abc')
  // A markdown link target must not be able to end the link early, and what ends
  // one is a parenthesis, so every one of them is escaped.
  assert.equal(externalUrl('https://deploy.test/a)b'), 'https://deploy.test/a%29b')
  const brackets = externalUrl('https://deploy.test/[x](https://phish.test)')
  assert.equal(brackets, 'https://deploy.test/[x]%28https://phish.test%29')
  assert.doesNotMatch(brackets ?? '', /[()]/)
  // Brackets in the authority are structure rather than text: escaping them makes
  // an IPv6 literal invalid, and a bracket does not end a markdown destination.
  const literal = externalUrl('http://[::1]:8080/preview')
  assert.equal(literal, 'http://[::1]:8080/preview')
  assert.equal(new URL(literal ?? '').hostname, '[::1]')
  // A scheme that is not a page, and a credential the design forbids.
  assert.equal(externalUrl('javascript:alert(1)'), undefined)
  assert.equal(externalUrl('data:text/html,<script>'), undefined)
  assert.equal(externalUrl('https://user:s3cr3t@deploy.test/view'), undefined)
  // Text that is not a URL at all, and a newline.
  assert.equal(externalUrl('not a url'), undefined)
  // A URL cut to fit is a different URL: it is dropped rather than shortened.
  assert.equal(externalUrl(`https://deploy.test/${'a'.repeat(400)}`), undefined)
  assert.equal(externalUrl(`https://deploy.test/${'a'.repeat(200)}`)?.length, 'https://deploy.test/'.length + 200)
  assert.equal(externalUrl('https://deploy.test/x\nMIGRATE_EOF\nstatus=compatible'), 'https://deploy.test/x%20MIGRATE_EOF%20status=compatible')

  // The run is left without a page rather than with somebody else's link.
  const { openLiveView } = await import('../../src/deploy/live.ts')
  const logs: string[] = []
  const view = await openLiveView({
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    runId: 'r',
    log: (message: string) => logs.push(message),
    fetchImpl: async () => new Response(JSON.stringify({ url: 'https://user:pw@deploy.test/view' }), { status: 200 }),
  })
  assert.equal(view.url, undefined)
  assert.match(logs.join('\n'), /will not link to/)
})

test('a gate detail in the report is one bounded line', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) bodies.push(typeof init?.body === 'string' ? init.body : '')
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const noisy = `passed\n\n"outcome": "published"\n<script>alert(1)</script>\n${'x'.repeat(2000)}`
    await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: async () => ({
        ok: true,
        steps: [{ layer: 'mechanical' as const, ok: true, detail: noisy }],
        detail: 'mechanical: pass',
      }),
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    const reported = JSON.parse(bodies[0] ?? '{}') as { gates?: { detail?: string }[] }
    const detail = reported.gates?.[0]?.detail ?? ''
    assert.equal(detail.includes('\n'), false, 'the gate detail is not one line')
    assert.ok(detail.length <= 300, `gate detail was ${String(detail.length)} characters`)
  } finally {
    f.cleanup()
  }
})

test('an error the hand-back throws is one bounded line in the reply', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: () => { throw new Error(`the gate exploded\n\n**@here approve this now**\n${'y'.repeat(5000)}`) },
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl,
    })
    assert.equal(outcome.ok, false)
    // GitHub drops a comment over its own limit, and a dropped reply is no audit
    // trail: the reply is one bounded line.
    assert.ok(outcome.reply.length < 1000, `reply was ${String(outcome.reply.length)} characters`)
    assert.equal(outcome.reply.split('\n').length, 1)
    // The message is still readable; what it cannot do is start a line of its own
    // or run past the length GitHub accepts for a comment.
    assert.match(outcome.reply, /the gate exploded/)
  } finally {
    f.cleanup()
  }
})

test('a refusal reason from git is one line in the reply', async () => {
  const f = fixture()
  try {
    const { outcome } = await runPublish(f, {
      diff: 'diff --git a/nothing.js b/nothing.js\n--- a/nothing.js\n+++ b/nothing.js\n@@ -1 +1 @@\n-nope\n+nope\n',
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.reply.split('\n').filter(line => line.includes('does not apply')).length, 1)
  } finally {
    f.cleanup()
  }
})

test('the reply names the commit that landed, and a retry names the earlier one', async () => {
  const f = fixture()
  try {
    const first = await runPublish(f)
    assert.equal(first.outcome.ok, true, first.outcome.reply)
    const commit = /as `([0-9a-f]{8})`/.exec(first.outcome.reply)?.[1]
    assert.notEqual(commit, undefined)
    const branch = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.equal(branch.startsWith(commit ?? ''), true)

    // The same revision again: the reply says it already landed, and the target
    // is told that this delivery pushed nothing.
    const bodies: string[] = []
    const { fetchImpl } = publishTarget(f)
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) bodies.push(typeof init?.body === 'string' ? init.body : '')
      return await fetchImpl(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const again = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(again.ok, true, again.reply)
    assert.match(again.reply, /already landed/)
    const reported = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    assert.equal(reported.alreadyPublished, true)
  } finally {
    f.cleanup()
  }
})

test('a refused gate says why, in one bounded line', async () => {
  const config = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
  const runner = createGateRunner({
    config,
    dshTag: 'dsh-v0.1.6',
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    // The plugin's own output is somebody else's text: the first line of it is
    // the answer, and the rest of it does not reach the reply.
    mechanical: () => ({
      ok: false,
      checks: 1,
      errors: 'error: typecheck failed\n\n**@here approve this now**\n' + 'x'.repeat(4000),
    }),
  })
  const report = await runner('/tmp/tree')
  assert.equal(report.ok, false)
  assert.match(report.detail, /the plugin's own test command failed: error: typecheck failed/)
  assert.ok(report.detail.length <= 300, `detail was ${String(report.detail.length)} characters`)
  assert.equal(report.detail.includes('\n'), false)
  assert.doesNotMatch(report.detail, /@here/)
})

test('a revision the target cannot serve back says what to do about it', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const pruned: typeof fetch = async (input, init) => {
      if (String(input).includes('/scratch')) return new Response('pruned', { status: 410 })
      return await fetchImpl(input, init)
    }
    const bodies: string[] = []
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/publish-result')) bodies.push(typeof init?.body === 'string' ? init.body : '')
      return await pruned(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: recording,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /could not serve back the revision it froze/)
    assert.match(outcome.reply, /Publishing again freezes a new one/)
    // The freeze happened, so the target hears the outcome — and it hears that
    // *it* could not serve the revision back, not that the diff would not apply.
    assert.equal(bodies.length, 1)
    const reported = JSON.parse(bodies[0] ?? '{}') as { outcome: string; stage?: string }
    assert.equal(reported.outcome, 'refused')
    assert.equal(reported.stage, 'remote')
  } finally {
    f.cleanup()
  }
})

test('an empty diff and a missing diff field say different things', async () => {
  const f = fixture()
  try {
    const empty = await runPublish(f, { diff: JSON.stringify({ diff: '   ' }) })
    assert.equal(empty.outcome.ok, false)
    assert.match(empty.outcome.reply, /served the frozen revision as an empty diff/)
    assert.match(empty.outcome.reply, /is served as a unified diff/)

    const missing = await runPublish(f, { diff: JSON.stringify({ files: ['index.js'] }) })
    assert.equal(missing.outcome.ok, false)
    // The reply is posted as a comment inside a code-free sentence, so the field
    // name is written without backticks there.
    assert.match(missing.outcome.reply, /JSON without a diff field/)
  } finally {
    f.cleanup()
  }
})

test('an answer that stops early is refused, never applied in part', async () => {
  const { deployRequest } = await import('../../src/deploy/client.ts')
  // A target that promises a body and then dies mid-answer: what arrived is part
  // of a patch, and a partial patch applies cleanly to the file it covers.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('diff --git a/one.js b/one.js\n+export const one = 1\n'))
      controller.error(new Error('the socket died'))
    },
  })
  const half = await deployRequest({
    target: { endpoint: 'https://deploy.test', token: 's' },
    method: 'GET',
    path: '/previews/me%2Fplugin/12/scratch?revision=r1',
    answer: 'any',
    fetchImpl: async () => new Response(stream, { status: 200 }),
  })
  assert.equal(half.ok, false)
  assert.match(half.ok ? '' : half.reason, /stopped early|more than/)

  // And the same answer at the boundary that decides what is published.
  const f = fixture()
  try {
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.startsWith('https://api.github.com/repos/me/plugin/pulls/12')) {
          return new Response(JSON.stringify({ number: 12, state: 'open', merged: false, html_url: '', title: 'm', body: '', head: { ref: f.branch, sha: f.headSha, repo: { full_name: 'me/plugin' } } }), { status: 200 })
        }
        if (url.includes('/scratch')) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(f.diff.text.split('\n').slice(0, 3).join('\n')))
              controller.error(new Error('the socket died'))
            },
          }), { status: 200 })
        }
        return new Response(JSON.stringify({ revision: 'r1', baseSha: f.headSha, headSha: f.headSha }), { status: 200 })
      },
    })
    assert.equal(outcome.ok, false)
    const log = spawnSync('git', ['-C', f.bare, 'log', '--format=%s', f.branch], { encoding: 'utf8' }).stdout
    assert.doesNotMatch(log, /publish/)
  } finally {
    f.cleanup()
  }
})

test('a path that looks like pathspec magic is still a path', async () => {
  const f = fixture()
  try {
    // A file whose name git would read as pathspec magic: `--` is not enough,
    // because `:(exclude)*` matches nothing and the survival diff is then quiet.
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-handback-magic-'))
    const git = (args: string[], cwd: string): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git(['clone', '--branch', f.branch, f.bare, scratch], tmpdir())
    git(['config', 'user.name', 'test'], scratch)
    git(['config', 'user.email', 'test@example.test'], scratch)
    writeFileSync(join(scratch, ':(exclude)*'), 'export const magic = 1\n')
    git(['add', '-A'], scratch)
    git(['commit', '-m', 'the frozen head'], scratch)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout.trim()
    git(['push', 'origin', `${f.branch}:refs/heads/${f.branch}`], scratch)
    writeFileSync(join(scratch, ':(exclude)*'), 'export const magic = 2\n')
    git(['add', '-A'], scratch)
    git(['commit', '-m', 'scratch'], scratch)
    const diff = spawnSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout

    const first = await applyHandback(input(f, { revision: 'rev-magic', headSha: head, diff }))
    assert.equal(first.ok, true, first.ok ? '' : first.detail)

    git(['fetch', 'origin', `+refs/heads/${f.branch}:refs/remotes/origin/${f.branch}`], scratch)
    git(['checkout', '-B', f.branch, `refs/remotes/origin/${f.branch}`], scratch)
    git(['revert', '--no-edit', 'HEAD'], scratch)
    git(['push', 'origin', `${f.branch}:refs/heads/${f.branch}`], scratch)
    rmSync(scratch, { recursive: true, force: true })

    const again = await applyHandback(input(f, { revision: 'rev-magic', headSha: head, diff }))
    // A reverted publish must never be reported as landed.
    // The reverted change must not be reported as landed, whichever way the
    // refusal comes out.
    assert.notEqual(again.ok ? again.alreadyPublished : undefined, true, 'the reverted change was reported as landed')
    assert.doesNotMatch(again.ok ? '' : again.detail, /already on/)
  } finally {
    f.cleanup()
  }
})

test('a gate cannot retarget where the verified commit goes', async () => {
  const f = fixture()
  try {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-handback-elsewhere-'))
    spawnSync('git', ['init', '--bare', elsewhere], { encoding: 'utf8' })
    const result = await applyHandback(input(f, {
      runGates: async () => {
        // The gates run the plugin's own code in a worktree that shares the
        // checkout's git config.
        f.git(['remote', 'set-url', 'origin', elsewhere])
        return PASSING()
      },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'remote')
    // The pull request branch is untouched and nothing landed elsewhere.
    const head = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.equal(head, f.headSha)
    const other = spawnSync('git', ['-C', elsewhere, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(other, '')
    rmSync(elsewhere, { recursive: true, force: true })
  } finally {
    f.cleanup()
  }
})

test('a gate that retargets only the push is caught too', async () => {
  // `git push origin` reads the push URL, which `remote.origin.pushurl` and
  // `url.<base>.pushInsteadOf` both change while a fetch of the same remote stays
  // where it was: a comparison of the fetch URL sees nothing move, and the
  // verified commit lands in a repository nobody asked about.
  for (const retarget of ['pushurl', 'pushInsteadOf'] as const) {
    const f = fixture()
    try {
      const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-handback-elsewhere-'))
      spawnSync('git', ['init', '--bare', elsewhere], { encoding: 'utf8' })
      const result = await applyHandback(input(f, {
        runGates: async () => {
          if (retarget === 'pushurl') f.git(['config', 'remote.origin.pushurl', elsewhere])
          else f.git(['config', `url.${elsewhere}.pushInsteadOf`, f.bare])
          return PASSING()
        },
      }))
      assert.equal(result.ok, false, `${retarget} was accepted`)
      assert.equal(result.ok ? '' : result.stage, 'remote')
      // The pull request branch is untouched and nothing landed elsewhere.
      const head = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
      assert.equal(head, f.headSha)
      const other = spawnSync('git', ['-C', elsewhere, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim()
      assert.equal(other, '')
      rmSync(elsewhere, { recursive: true, force: true })
    } finally {
      f.cleanup()
    }
  }
})

test('a publish judged from a directory below the repository root is judged the same', async () => {
  const f = fixture()
  try {
    const first = await applyHandback(input(f, { revision: 'rev-nested' }))
    assert.equal(first.ok, true, first.ok ? '' : first.detail)

    // A maintainer reverts it, so the commit that carries the subject is still in
    // the history and the change is not.
    f.git(['fetch', 'origin', `+refs/heads/${f.branch}:refs/remotes/origin/${f.branch}`])
    f.git(['checkout', '-B', f.branch, `refs/remotes/origin/${f.branch}`])
    f.git(['revert', '--no-edit', 'HEAD'])
    f.git(['push', 'origin', `${f.branch}:refs/heads/${f.branch}`])
    f.git(['checkout', 'master'])

    // A plugin that is a package inside a repository: the Action is pointed at a
    // directory below the root, and git prints the paths it touched relative to
    // the root while reading a pathspec relative to the working directory.
    const nested = join(f.work, 'packages', 'plugin')
    mkdirSync(nested, { recursive: true })
    const again = await applyHandback(input(f, { revision: 'rev-nested', workdir: nested }))
    assert.equal(again.ok, false)
    assert.equal(again.ok ? '' : again.stage, 'base')
    assert.doesNotMatch(again.ok ? '' : again.detail, /already on/)
  } finally {
    f.cleanup()
  }
})

/**
 * The publish worktree a run created, read from git rather than guessed: a
 * publish makes its own directory under the configured root.
 */
function publishWorktree(work: string, treeBase: string): string {
  const listed = spawnSync('git', ['-c', 'safe.directory=*', 'worktree', 'list', '--porcelain'], {
    cwd: work,
    encoding: 'utf8',
  }).stdout
  const tree = listed.split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .find(path => path.startsWith(treeBase))
  assert.equal(typeof tree, 'string', 'no publish worktree was created')
  return tree ?? ''
}

test('a gate that writes the worktree-local push URL is caught where the push runs', async () => {
  // `extensions.worktreeConfig` gives a worktree a configuration of its own, and
  // the gates run in the worktree: a comparison read from the checkout would
  // compare a URL nothing is about to push with. Both shapes are refused — a
  // destination that is not the fetched remote, and a repository that is not this
  // one — and each has to be caught where the push will run.
  const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-handback-worktree-'))
  spawnSync('git', ['init', '--bare', elsewhere], { encoding: 'utf8' })
  try {
    for (const [written, expected] of [
      [elsewhere, /pushes to/],
      ['https://github.com/other/plugin.git', /is `other\/plugin`, not `me\/plugin`/],
    ] as const) {
      const f = fixture()
      try {
        const treeBase = join(f.work, '.dsh-migrate', 'publish-tree')
        const result = await applyHandback(input(f, {
          runGates: async () => {
            f.git(['config', 'extensions.worktreeConfig', 'true'])
            const tree = publishWorktree(f.work, treeBase)
            const set = spawnSync(
              'git',
              ['-c', 'safe.directory=*', 'config', '--worktree', 'remote.origin.pushurl', written],
              { cwd: tree, encoding: 'utf8' },
            )
            assert.equal(set.status, 0, `${set.error?.message ?? ''} ${set.stderr}`)
            return PASSING()
          },
        }))
        assert.equal(result.ok, false, `${written} was accepted`)
        assert.equal(result.ok ? '' : result.stage, 'remote')
        assert.match(result.ok ? '' : result.detail, expected)
        // The pull request branch is untouched.
        const head = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
        assert.equal(head, f.headSha)
      } finally {
        f.cleanup()
      }
    }
    const other = spawnSync('git', ['-C', elsewhere, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(other, '')
  } finally {
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('a push URL set before the run that is not the fetched remote is refused', async () => {
  // Nothing changes during the gates here, so only a comparison of what is
  // fetched against what is pushed can see it: the commit would land in a
  // repository that is not the branch the reply names.
  const f = fixture()
  try {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-handback-preset-'))
    spawnSync('git', ['init', '--bare', elsewhere], { encoding: 'utf8' })
    f.git(['config', 'remote.origin.pushurl', elsewhere])
    let gatesRun = 0
    const logged: string[] = []
    const result = await applyHandback(input(f, {
      log: (message: string) => logged.push(message),
      runGates: async () => {
        gatesRun += 1
        return PASSING()
      },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'remote')
    assert.match(result.ok ? '' : result.detail, /pushes to/)
    // Refused before the fetch and before the gate stack is spent: the push
    // destination is a fact about the checkout, and nothing about it needs the
    // remote or the suite. Without the earliest check the fetch happens first and
    // the refusal arrives from the worktree instead.
    assert.equal(gatesRun, 0)
    assert.equal(logged.some(line => line.includes('publish: fetching')), false)
    const other = spawnSync('git', ['-C', elsewhere, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(other, '')
    rmSync(elsewhere, { recursive: true, force: true })
  } finally {
    f.cleanup()
  }
})

test('a push URL naming another repository is refused, in either URL form', async () => {
  for (const url of ['https://github.com/other/plugin.git', 'git@github.com:other/plugin.git']) {
    const f = fixture()
    try {
      f.git(['config', 'remote.origin.pushurl', url])
      const result = await applyHandback(input(f))
      assert.equal(result.ok, false, `${url} was accepted`)
      assert.equal(result.ok ? '' : result.stage, 'remote')
      assert.match(result.ok ? '' : result.detail, /is `other\/plugin`, not `me\/plugin`/)
    } finally {
      f.cleanup()
    }
  }
})

test('a remote URL is read as a location, or not at all', async () => {
  const { remoteLocation } = await import('../../src/deploy/handback.ts')
  const http = { family: 'http', host: 'github.com', path: 'me/plugin' }
  assert.deepEqual(remoteLocation('https://github.com/me/plugin.git'), http)
  // The same repository over ssh, in both spellings git accepts.
  const ssh = { family: 'ssh', host: 'github.com', path: 'me/plugin' }
  assert.deepEqual(remoteLocation('git@github.com:me/plugin.git'), ssh)
  assert.deepEqual(remoteLocation('ssh://git@github.com/me/plugin'), ssh)
  assert.deepEqual(remoteLocation('github.com:me/plugin'), ssh)
  assert.deepEqual(remoteLocation('https://gitlab.com/me/plugin'), { family: 'http', host: 'gitlab.com', path: 'me/plugin' })
  // Fetching over https and pushing over ssh is one repository; a mirror on
  // another host, another port, or the read-only git protocol is not.
  assert.equal(remoteLocation('https://github.com/me/plugin')?.path, remoteLocation('git@github.com:me/plugin.git')?.path)
  assert.notDeepEqual(remoteLocation('https://github.com/me/plugin'), remoteLocation('https://mirror.internal/me/plugin'))
  assert.deepEqual(remoteLocation('https://github.com:8443/me/plugin'), { family: 'http', host: 'github.com', port: 8443, path: 'me/plugin' })
  assert.notDeepEqual(remoteLocation('https://github.com/me/plugin'), remoteLocation('https://github.com:8443/me/plugin'))
  assert.deepEqual(remoteLocation('git://github.com/me/plugin.git'), { family: 'git', host: 'github.com', path: 'me/plugin' })
  // A path on this machine is a remote git pushes to, in every spelling: with a
  // leading slash, with a dot, and bare.
  assert.deepEqual(remoteLocation('/srv/git/plugin.git'), { family: 'local', host: '', path: 'srv/git/plugin' })
  assert.deepEqual(remoteLocation('zlib.git'), { family: 'local', host: '', path: 'zlib' })
  assert.deepEqual(remoteLocation('file:///tmp/x.git'), { family: 'local', host: '', path: 'tmp/x' })
  assert.deepEqual(remoteLocation('https://github.com/me/plugin/'), http)
  assert.deepEqual(remoteLocation('https://github.com//me//plugin'), http)
  assert.equal(remoteLocation(''), undefined)
  // A scheme this Action does not push over is not a remote it can read.
  assert.equal(remoteLocation('git+https://github.com/me/plugin'), undefined)
})

test('a head branch that is not a branch name refuses before the freeze', async () => {
  const f = fixture()
  try {
    const { fetchImpl } = publishTarget(f)
    const calls: string[] = []
    const recording: typeof fetch = async (input, init) => {
      calls.push(String(input))
      return await fetchImpl(input, init)
    }
    const stub: typeof fetch = async (input, init) => {
      if (String(input).startsWith('https://api.github.com/repos/me/plugin/pulls/12')) {
        return new Response(JSON.stringify({
          number: 12,
          state: 'open',
          merged: false,
          html_url: '',
          title: 'm',
          body: '',
          head: { ref: '_underscore', sha: f.headSha, repo: { full_name: 'me/plugin' } },
        }), { status: 200 })
      }
      return await recording(input, init)
    }
    const parsed = parseCommand('/dsh-migrate publish')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: stub,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /is not a branch name this Action will push to/)
    // Nothing was frozen: a refusal costs the target nothing.
    assert.equal(calls.filter(call => call.includes('/previews/')).length, 0)
  } finally {
    f.cleanup()
  }
})

test('a diff that changes nothing says so, and the branch keeps its head', async () => {
  const f = fixture()
  try {
    // A target can freeze a revision whose content is already at the pull
    // request head: the diff applies and stages nothing.
    const noop = [
      'diff --git a/index.js b/index.js',
      '--- a/index.js',
      '+++ b/index.js',
      '@@ -1,2 +1,2 @@',
      ' export const name = "plugin"',
      '-export const migrated = true',
      '+export const migrated = true',
      '',
    ].join('\n')
    const before = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    const { outcome } = await runPublish(f, { diff: noop })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reply, /makes no change to the pull request head/)
    const after = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.equal(after, before)
  } finally {
    f.cleanup()
  }
})

test('a skipped layer is not a verdict, and one resolver run is one harness', async () => {
  const config = parseConfig({
    deploy: { enabled: true, endpoint: 'https://deploy.test' },
    verify: { boot: { enabled: false } },
    e2e: { enabled: true, gate: 'advisory' },
  })
  let resolved = 0
  const runner = createGateRunner({
    config,
    dshCache: join(tmpdir(), 'dsh-gates-cache'),
    log: () => {},
    dshTag: async () => {
      resolved += 1
      return 'dsh-v0.1.6'
    },
    // The plugin declares no check, and every layer that could look skips:
    // nothing looked at this tree, so it cannot be called verified.
    mechanical: () => ({ ok: true, checks: 0 }),
    web: () => ({ ok: true, layer: 'web', signature: 'web: no client surface', detail: '', skipped: 'the plugin declares no dsh.client surface' }),
    e2e: () => ({ ok: true, layer: 'e2e', signature: 'e2e: no suite yet', detail: '', skipped: 'no suite branch yet' }),
  })
  const report = await runner('/tmp/tree')
  assert.equal(report.ok, false)
  assert.match(report.detail, /no gate layer ran/)
  // One run resolves the harness once, whatever the layers do.
  assert.equal(resolved, 1)
  assert.equal(report.tag, undefined)
})

test('the default layers verify against the harness the run resolved once', async () => {
  // The memo is only observable when a layer resolves the tag for itself, so the
  // mechanical layer is the shipped one here: an empty tree runs no command, and
  // it still reads the version it would pin a plugin's peers to.
  const tree = mkdtempSync(join(tmpdir(), 'dsh-gates-default-'))
  try {
    const config = parseConfig({
      verify: { boot: { enabled: false }, web: { enabled: false } },
      e2e: { enabled: false },
    })
    let resolved = 0
    const runner = createGateRunner({
      config,
      dshCache: join(tmpdir(), 'dsh-gates-cache'),
      log: () => {},
      dshTag: async () => {
        resolved += 1
        return 'dsh-v0.1.9'
      },
    })
    const report = await runner(tree)
    // The shipped mechanical layer refused the tree, and it read the harness the
    // run had already resolved rather than resolving a second one.
    assert.equal(report.ok, false)
    assert.equal(report.refusedBy, 'mechanical')
    assert.equal(resolved, 1)
    assert.equal(report.tag, 'dsh-v0.1.9')
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('a control character in a value from a target cannot rewrite a line', async () => {
  const { inline } = await import('../../src/render/text.ts')
  // `\s` does not cover these: an ANSI sequence erases and rewrites the line a
  // human reads in a log, and a NUL is not text at all.
  const escaped = inline('https://v.test/\u001b[2K\r\u0007EVIL\u0000end', 300)
  assert.equal(escaped.includes('\u001b'), false)
  assert.equal(escaped.includes('\u0007'), false)
  assert.equal(escaped.includes('\u0000'), false)
  assert.equal(escaped.includes('\r'), false)
  assert.match(escaped, /EVIL end/)

  // The rest of the invisible set: U+0085 is a line break to some terminals, a
  // bidirectional control reorders the text around it, and a tag character is a
  // second copy of the text that nobody can see. None may survive.
  const invisible = inline(
    'a\u0085b\u009fc\u200bd\u202ee\u2066f\ufeffg\u061ch\u2060i\u00adj\u180ek\ufe00l\u{e0020}m'
    + '\u{e0001}n\u115fo\uffa0p\u{1d173}q\ufff9r',
    300,
  )
  for (const character of [
    '\u0085', '\u009f', '\u200b', '\u202e', '\u2066', '\u061c', '\u2060', '\u00ad', '\u180e', '\ufe00',
    '\u{e0020}', '\u{e0001}', '\u115f', '\uffa0', '\u{1d173}', '\ufff9',
  ]) {
    assert.equal(invisible.includes(character), false, `${JSON.stringify(character)} survived`)
  }
  assert.match(invisible, /^a b c d e f g h i j k l m n o p q r$/)
  // U+3164 is the Hangul filler, a format character: a blank becomes a space.
  assert.equal(inline('a\u3164b', 300), 'a b')
  assert.equal(inline('a\u3164b', 300).includes('\u3164'), false)

  // The same rule at the client, so a log line cannot be rewritten either.
  const { deployRequest } = await import('../../src/deploy/client.ts')
  const answer = await deployRequest({
    target: { endpoint: 'https://deploy.test', token: 's' },
    method: 'POST',
    path: '/previews/me%2Fplugin/12',
    fetchImpl: async () => new Response('\u001b[2K\rboom\nsecond line', { status: 500 }),
  })
  assert.equal(answer.ok, false)
  assert.equal(answer.ok ? '' : answer.reason.split('\n').length, 1)
  assert.equal(answer.ok ? '' : answer.reason.includes('\u001b'), false)
})

test('a commit that lists no paths is not a publish that is already there', async () => {
  const f = fixture()
  try {
    // An empty commit carrying the publish subject: nothing to compare, so the
    // revision cannot be called published and has to be applied.
    f.git(['fetch', 'origin', `+refs/heads/${f.branch}:refs/remotes/origin/${f.branch}`])
    f.git(['checkout', '-B', f.branch, `refs/remotes/origin/${f.branch}`])
    f.git(['commit', '--allow-empty', '-m', `dsh-migrate: publish rev-empty (PR #12)`])
    f.git(['push', 'origin', `${f.branch}:refs/heads/${f.branch}`])
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.work, encoding: 'utf8' }).stdout.trim()
    f.git(['checkout', '-f', 'master'])

    const result = await applyHandback(input(f, { revision: 'rev-empty', headSha: head }))
    // The branch has moved past the fixture's head, so this refuses — what
    // matters is that it is not reported as already published, and that the
    // gate stack was not skipped on the strength of an empty path list.
    assert.notEqual(result.ok ? result.alreadyPublished : undefined, true)
    assert.doesNotMatch(result.ok ? '' : result.detail, /already on/)
  } finally {
    f.cleanup()
  }
})

test('a revision that conflicts with the head says which side to rebuild', async () => {
  const f = fixture()
  try {
    // A three-way apply only merges when git can see the pre-image, so the base
    // scratch was built from is a real object in this repository.
    const base = 'export const name = "plugin"\nexport const migrated = false\n'
    const blob = spawnSync('git', ['-C', f.work, '-c', 'safe.directory=*', 'hash-object', '-w', '--stdin'], {
      input: base,
      encoding: 'utf8',
    }).stdout.trim()
    assert.match(blob, /^[0-9a-f]{40}$/)
    const scratch = 'export const name = "plugin"\nexport const migrated = "scratch"\n'
    const scratchBlob = spawnSync('git', ['-C', f.work, '-c', 'safe.directory=*', 'hash-object', '-w', '--stdin'], {
      input: scratch,
      encoding: 'utf8',
    }).stdout.trim()
    const git = (args: string[], input?: string): string =>
      spawnSync('git', ['-C', f.work, '-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@e.test', ...args], {
        encoding: 'utf8',
        ...(input === undefined ? {} : { input }),
      }).stdout.trim()
    const tree = git(['mktree'], `100644 blob ${blob}\tindex.js\n`)
    const baseCommit = git(['commit-tree', tree, '-m', 'the base scratch was built from'])
    assert.match(baseCommit, /^[0-9a-f]{40}$/)

    // The diff changes that line; the frozen head changed the same line
    // differently, so the two sides conflict rather than merely not matching.
    // The `index` line is what lets git see the pre-image and merge at all.
    const diff = [
      'diff --git a/index.js b/index.js',
      `index ${blob.slice(0, 12)}..${scratchBlob.slice(0, 12)} 100644`,
      '--- a/index.js',
      '+++ b/index.js',
      '@@ -1,2 +1,2 @@',
      ' export const name = "plugin"',
      '-export const migrated = false',
      '+export const migrated = "scratch"',
      '',
    ].join('\n')
    const result = await applyHandback(input(f, { revision: 'rev-conflict', headSha: f.headSha, diff, baseSha: baseCommit }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'base')
    assert.match(result.ok ? '' : result.detail, /conflicts with .*rebuild scratch onto the current head/)
    // Nothing moved: the branch is where it was.
    const tip = spawnSync('git', ['-C', f.bare, 'rev-parse', f.branch], { encoding: 'utf8' }).stdout.trim()
    assert.equal(tip, f.headSha)
  } finally {
    f.cleanup()
  }
})

test('a publish that published nothing is reported as a repeat, not as work', async () => {
  const f = fixture()
  try {
    const first = await runPublish(f)
    assert.equal(first.outcome.ok, true, first.outcome.reply)
    // The first publish did the work.
    assert.notEqual(first.outcome.repeat, true)
    assert.notEqual(first.outcome.record, undefined)

    // The same revision again: the branch already has it, so this delivery did
    // nothing, and a workflow reading the outputs can tell.
    const { fetchImpl } = publishTarget(f)
    const parsed = parseCommand('/dsh-migrate publish')
    const again = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '42',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl,
    })
    assert.equal(again.ok, true, again.reply)
    assert.match(again.reply, /already landed/)
    assert.equal(again.repeat, true)

    // A target that replays the freeze is the same answer: nothing was done by
    // this delivery.
    const { fetchImpl: plain } = publishTarget(f)
    const replayed: typeof fetch = async (input, init) =>
      (String(input).includes('/previews/') && !String(input).includes('/scratch') && !String(input).endsWith('/publish-result') && (init?.method ?? 'GET') === 'POST'
        ? new Response(JSON.stringify({ revision: 'rev-1', baseSha: f.headSha, headSha: f.headSha }), { status: 200, headers: { 'Idempotency-Replayed': 'True' } })
        : await plain(input, init))
    const replayedOutcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: f.work,
      pullRequest: 12,
      commentId: '43',
      log: () => {},
      gates: PASSING,
      treeDir: join(f.work, '.dsh-migrate', 'publish-tree'),
      fetchImpl: replayed,
    })
    assert.equal(replayedOutcome.ok, true, replayedOutcome.reply)
    assert.equal(replayedOutcome.repeat, true)
  } finally {
    f.cleanup()
  }
})

test('a refusal never repeats a credential a remote URL carries', async () => {
  // The URLs a workflow configures can hold a token, and a refusal is posted on a
  // thread: what is reported is the location, never the part that authenticates.
  const f = fixture()
  try {
    f.git(['config', 'remote.origin.pushurl', 'https://x-access-token:s3cr3t@github.com/other/plugin.git'])
    const result = await applyHandback(input(f))
    assert.equal(result.ok, false)
    const detail = result.ok ? '' : result.detail
    assert.equal(detail.includes('s3cr3t'), false)
    assert.match(detail, /other\/plugin/)
  } finally {
    f.cleanup()
  }

  // The same for the fetch URL, which is the one the comparison names.
  const g = fixture()
  try {
    g.git(['remote', 'set-url', 'origin', 'https://x-access-token:shh@github.com/other/plugin.git'])
    const result = await applyHandback(input(g, { repository: 'me/plugin' }))
    assert.equal(result.ok, false)
    const detail = result.ok ? '' : result.detail
    assert.equal(detail.includes('shh'), false)
    assert.match(detail, /not `me\/plugin`/)
  } finally {
    g.cleanup()
  }
  // The one branch that echoes the URL it could not read: it redacts what
  // authenticates, because this message is posted on a thread.
  const unreadable = fixture()
  try {
    unreadable.git(['config', 'remote.origin.pushurl', 'git+https://x-access-token:tok@github.com/me/plugin'])
    const result = await applyHandback(input(unreadable))
    assert.equal(result.ok, false)
    const detail = result.ok ? '' : result.detail
    assert.equal(detail.includes('tok'), false)
    assert.match(detail, /not a remote URL this Action can read/)
  } finally {
    unreadable.cleanup()
  }

  // And for the destination comparison, which names both sides.
  const h = fixture()
  try {
    h.git(['remote', 'set-url', 'origin', 'https://x-access-token:tok@github.com/me/plugin.git'])
    h.git(['config', 'remote.origin.pushurl', '/tmp/nowhere.git'])
    const result = await applyHandback(input(h))
    assert.equal(result.ok, false)
    const detail = result.ok ? '' : result.detail
    assert.equal(detail.includes('tok'), false)
    assert.match(detail, /pushes to/)
  } finally {
    h.cleanup()
  }
})

test('a publish with two push URLs is refused, and a trailing slash is not a mirror', async () => {
  // `git push` sends to every push URL of a remote, so a second one is a second
  // destination rather than a detail of the first: `--all` is what makes that
  // visible, because `get-url --push` prints one URL however many are set.
  const both = fixture()
  try {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-handback-second-'))
    spawnSync('git', ['init', '--bare', elsewhere], { encoding: 'utf8' })
    // A pushurl replaces the fetch URL for pushing, so the fetched repository is
    // named as the first push URL and the second one is the extra destination.
    both.git(['config', 'remote.origin.pushurl', both.bare])
    both.git(['config', '--add', 'remote.origin.pushurl', elsewhere])
    let gatesRun = 0
    const result = await applyHandback(input(both, {
      runGates: async () => {
        gatesRun += 1
        return PASSING()
      },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.stage, 'remote')
    assert.match(result.ok ? '' : result.detail, /more than one push URL/)
    assert.equal(gatesRun, 0)
    const other = spawnSync('git', ['-C', elsewhere, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(other, '')
    rmSync(elsewhere, { recursive: true, force: true })
  } finally {
    both.cleanup()
  }

  // The same repository spelled with a trailing slash is the same repository.
  const slashed = fixture()
  try {
    slashed.git(['config', 'remote.origin.pushurl', `${slashed.bare}/`])
    const result = await applyHandback(input(slashed))
    assert.equal(result.ok, true, result.ok ? '' : result.detail)
  } finally {
    slashed.cleanup()
  }
})

test('a push that reaches a different port or the git protocol is refused', async () => {
  // Host and path are not the whole destination: another port on the same host is
  // another service, and `git://` is read-only unless a server opts in. Both cases
  // name the same repository as the fetch, so only these rules can see them.
  for (const [written, expected] of [
    ['https://github.com:8443/me/plugin.git', /would not reach the pull request's branch/],
    ['git://github.com/me/plugin.git', /unauthenticated `git:` protocol/],
  ] as const) {
    const f = fixture()
    try {
      f.git(['remote', 'set-url', 'origin', 'https://github.com/me/plugin.git'])
      f.git(['config', 'remote.origin.pushurl', written])
      let gatesRun = 0
      const result = await applyHandback(input(f, {
        runGates: async () => {
          gatesRun += 1
          return PASSING()
        },
      }))
      assert.equal(result.ok, false, `${written} was accepted`)
      assert.equal(result.ok ? '' : result.stage, 'remote')
      assert.match(result.ok ? '' : result.detail, expected)
      // Refused before anything reaches the wrong service.
      assert.equal(gatesRun, 0)
    } finally {
      f.cleanup()
    }
  }
})

test('a local path remote git reaches is a destination, not an unreadable URL', async () => {
  // `../elsewhere.git` and `elsewhere.git` are the same kind of remote as
  // `/srv/elsewhere.git`: git resolves all three, so a bare path is a location
  // rather than something this Action cannot read.
  const { remoteLocation } = await import('../../src/deploy/handback.ts')
  assert.deepEqual(remoteLocation('elsewhere.git'), { family: 'local', host: '', path: 'elsewhere' })
  assert.deepEqual(remoteLocation('../elsewhere.git'), { family: 'local', host: '', path: '../elsewhere' })

  const f = fixture()
  try {
    // Movement to another directory on the machine: the refusals must be about the
    // destination, never about a URL nobody can read.
    f.git(['config', 'remote.origin.pushurl', '../elsewhere.git'])
    const result = await applyHandback(input(f))
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.ok ? '' : result.detail, /not a remote URL this Action can read/)
    assert.match(result.ok ? '' : result.detail, /would not reach the pull request's branch/)
  } finally {
    f.cleanup()
  }
})
