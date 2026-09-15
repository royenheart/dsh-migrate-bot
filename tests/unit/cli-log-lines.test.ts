import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

/**
 * What the CLI writes to stdout, with the state branch poisoned.
 *
 * A log line is written unprefixed, so a value read back out of `seen.json` that
 * contains a newline starts a line at column 0 — where the Actions runner parses
 * workflow commands. These tests drive the real CLI, because the lines are built
 * inside `main` and are otherwise reachable only by reading it.
 */
const POISON = 'dsh-v0.1.0\n::add-mask::forged-by-a-state-branch'

interface Fixture {
  work: string
  home: string
  env: NodeJS.ProcessEnv
  git: (args: string[]) => void
  cleanup: () => void
}

/** A plugin checkout, a state branch recording a poisoned tag, and a fake harness. */
function fixture(tag: string, target = 'dsh-v0.1.6'): Fixture {
  const work = mkdtempSync(join(tmpdir(), 'dsh-cli-lines-'))
  const bare = mkdtempSync(join(tmpdir(), 'dsh-cli-lines-bare-'))
  const home = mkdtempSync(join(tmpdir(), 'dsh-cli-lines-home-'))
  const git = (args: string[]): void => {
    const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], {
      cwd: work,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
  }
  spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
  git(['init'])
  git(['config', 'user.name', 'test'])
  git(['config', 'user.email', 'test@example.test'])
  writeFileSync(join(work, 'package.json'), '{"name":"@acme/plugin","version":"1.0.0"}\n')
  // The upgrade-skill channel on, so the line that reports where skills come from
  // is written: its detail names the source directory the environment chose.
  mkdirSync(join(work, '.github'), { recursive: true })
  writeFileSync(
    join(work, '.github/dsh-migrate.yml'),
    'feedback:\n  enabled: true\n  channels:\n    upgrade-skill:\n      enabled: true\n',
  )
  git(['add', '.'])
  git(['commit', '-m', 'init'])
  git(['branch', '-M', 'main'])
  git(['remote', 'add', 'origin', bare])
  git(['push', '-u', 'origin', 'main'])

  // The state branch, as a previous run left it.
  git(['checkout', '--orphan', 'dsh-migrate/state'])
  git(['rm', '-rq', '--cached', '.'])
  writeFileSync(join(work, 'badge.json'), '{"schemaVersion":1,"label":"dsh","message":"unverified","color":"lightgrey"}\n')
  writeFileSync(join(work, 'seen.json'), `${JSON.stringify({
    tag,
    version: '0.1.0',
    recordedAt: '2026-01-01T00:00:00.000Z',
    verified: { tag, version: '0.1.0' },
  }, null, 2)}\n`)
  git(['add', 'badge.json', 'seen.json'])
  git(['commit', '-m', 'state'])
  git(['push', 'origin', 'dsh-migrate/state'])
  git(['checkout', '-qf', 'main'])
  git(['branch', '-D', 'dsh-migrate/state'])

  // A harness checkout that is already the one this run wants, so no clone is
  // attempted: these tests are about the lines, not about a migration.
  const harness = join(home, 'harness')
  mkdirSync(join(harness, '.git'), { recursive: true })
  writeFileSync(join(harness, '.dsh-migrate-tag'), `${target}\n`)
  return {
    work,
    home,
    git,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DSH_MIGRATE_HOME: home,
      GITHUB_REPOSITORY: 'acme/plugin',
      // A key that authenticates nothing: the run stops at the first API call, and
      // the lines under test are written before it.
      DEEPSEEK_API_KEY_DSH_MIGRATE_BOT: 'sk-not-a-real-key',
    },
    cleanup: () => {
      for (const dir of [work, bare, home]) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Run the built CLI and collect its output. */
async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string }> {
  const child = spawn(process.execPath, ['dist/src/cli.js', ...args], { cwd: process.cwd(), env })
  let stdout = ''
  child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk: unknown) => { stdout += String(chunk) })
  return await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', status => { resolve({ status, stdout }) })
  })
}

/** No line of the output may start where the runner parses a workflow command. */
function assertNoForgedLine(output: string): void {
  const forged = output.split('\n').filter(line => line.startsWith('::'))
  assert.deepEqual(forged, [])
}

test('the badge line a run logs collapses the tag the state branch recorded', async () => {
  const f = fixture(POISON)
  try {
    const { stdout } = await cli(['refresh-badge', '--workdir', f.work], f.env)
    assertNoForgedLine(stdout)
    const line = stdout.split('\n').find(entry => entry.includes('recorded state on'))
    assert.equal(line?.split('\n').length, 1)
    assert.match(line ?? '', /badge dsh-v0\.1\.0 ::add-mask::forged-by-a-state-branch/)

    // The commit that write makes is a message too, and a message is lines: the
    // tag may not add one. The write happens in a clone of its own, so the message
    // is read back from the remote.
    spawnSync('git', ['-C', f.work, 'fetch', 'origin', 'dsh-migrate/state'], { encoding: 'utf8' })
    const subject = spawnSync('git', ['-C', f.work, 'log', '-1', '--format=%B', 'FETCH_HEAD'], { encoding: 'utf8' })
    const message = subject.stdout.trim()
    assert.match(message, /^dsh-migrate: (record|refresh badge)/)
    assert.deepEqual(message.split('\n').filter(line => line.startsWith('::')), [])
  } finally {
    f.cleanup()
  }
})

test('a path the environment carries cannot forge a line of the harness log', async () => {
  // `DSH_MIGRATE_HOME` is an env var an operator sets, and `path.resolve` keeps a
  // newline in it: the line that reports where the harness came from would carry
  // it into column 0 of stdout.
  const f = fixture(POISON)
  try {
    const { stdout } = await cli([
      'run',
      '--workdir', f.work,
      '--dsh-version', 'dsh-v0.1.6',
      '--skip-github',
    ], {
      ...f.env,
      DSH_MIGRATE_HOME: `${f.home}\n::add-mask::forged-by-an-env-var`,
      DSH_MIGRATE_SKILLS_DIR: `/tmp/skills\n::add-mask::forged-by-the-skills-dir`,
      // A skill root, so the line reports the source directory it looked in.
      DSH_HOME: join(f.home, 'dsh-home'),
    })
    assertNoForgedLine(stdout)
    // The run really reached the lines: the harness is not where the checkout
    // wanted it, and the skill source is the directory the environment named.
    assert.match(stdout, /harness checkout (skipped|source)/)
    assert.match(stdout, /^stage: skills — .*looked in \/tmp\/skills ::add-mask::forged-by-the-skills-dir\)$/m)
  } finally {
    f.cleanup()
  }
})

test('the baseline probe line collapses the tag it was asked to probe', async () => {
  const f = fixture(POISON)
  try {
    const { stdout } = await cli([
      'run',
      '--workdir', f.work,
      '--dsh-version', 'dsh-v0.1.6',
      '--skip-github',
    ], f.env)
    assertNoForgedLine(stdout)
    // The harness lines are the run's own text about a path and about git: one
    // line each, whatever the environment and git put in them.
    for (const marker of ['harness checkout skipped:', 'harness source at', 'stage: skills —']) {
      for (const entry of stdout.split('\n').filter(part => part.includes(marker))) {
        assert.equal(entry.split('\n').length, 1)
      }
    }
    assert.match(stdout, /^harness source at .+$/m)
    const line = stdout.split('\n').find(entry => entry.includes('stage: baseline probe'))
    assert.equal(line?.split('\n').length, 1)
    assert.match(line ?? '', /stage: baseline probe dsh-v0\.1\.0 ::add-mask::forged-by-a-state-branch \(state\)/)
    // The probe's own signature is one line as well, whatever the harness printed:
    // the line closes on the same line it opened.
    assert.match(stdout, /^baseline probe: \w+ \([^\n]*\)$/m)
  } finally {
    f.cleanup()
  }
})
