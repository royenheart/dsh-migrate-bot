import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { appRootFrom } from '../../src/paths.ts'

const entrypoint = resolve(appRootFrom(import.meta.url), 'container/entrypoint.sh')

test('entrypoint maps INPUT_* onto CLI flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-entry-'))
  try {
    mkdirSync(join(dir, 'bin'))
    const out = join(dir, 'argv.json')
    const fakeCli = join(dir, 'fake-cli.mjs')
    writeFileSync(fakeCli, `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.DSH_MIGRATE_ARGV_OUT, JSON.stringify(process.argv.slice(2)))
`)
    chmodSync(entrypoint, 0o755)
    const result = spawnSync('bash', [entrypoint], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        GITHUB_WORKSPACE: dir,
        INPUT_WORKDIR: '.',
        INPUT_CONFIG: '.github/dsh-migrate.yml',
        INPUT_DSH_VERSION: '0.1.1-rc.2',
        INPUT_MECHANICAL_ONLY: 'true',
        INPUT_SKIP_GITHUB: 'true',
        INPUT_FORCE: 'true',
        INPUT_API_KEY_ENV: 'MY_DEEPSEEK_KEY',
        INPUT_QUOTA_LIMIT: '5',
        DSH_MIGRATE_CLI: fakeCli,
        DSH_MIGRATE_ARGV_OUT: out,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const argv = JSON.parse(readFileSync(out, 'utf8')) as string[]
    assert.equal(argv[0], 'run')
    assert.ok(argv.includes('--workdir'))
    assert.ok(argv.includes('--config'))
    assert.equal(argv[argv.indexOf('--config') + 1], '.github/dsh-migrate.yml')
    assert.equal(argv[argv.indexOf('--dsh-version') + 1], '0.1.1-rc.2')
    assert.ok(argv.includes('--mechanical-only'))
    assert.ok(argv.includes('--skip-github'))
    assert.ok(argv.includes('--force'))
    assert.equal(argv[argv.indexOf('--api-key-env') + 1], 'MY_DEEPSEEK_KEY')
    assert.equal(argv[argv.indexOf('--quota-limit') + 1], '5')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('entrypoint maps refresh_only to refresh-badge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-entry-'))
  try {
    const out = join(dir, 'argv.json')
    const fakeCli = join(dir, 'fake-cli.mjs')
    writeFileSync(fakeCli, `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.DSH_MIGRATE_ARGV_OUT, JSON.stringify(process.argv.slice(2)))
`)
    chmodSync(entrypoint, 0o755)
    const result = spawnSync('bash', [entrypoint], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        GITHUB_WORKSPACE: dir,
        INPUT_REFRESH_ONLY: 'true',
        INPUT_WORKDIR: '.',
        DSH_MIGRATE_CLI: fakeCli,
        DSH_MIGRATE_ARGV_OUT: out,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const argv = JSON.parse(readFileSync(out, 'utf8')) as string[]
    assert.equal(argv[0], 'refresh-badge')
    assert.ok(argv.includes('--workdir'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('entrypoint maps a comment command and the comment it came from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-entry-'))
  try {
    const out = join(dir, 'argv.json')
    const fakeCli = join(dir, 'fake-cli.mjs')
    writeFileSync(fakeCli, `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.DSH_MIGRATE_ARGV_OUT, JSON.stringify(process.argv.slice(2)))
`)
    chmodSync(entrypoint, 0o755)
    const result = spawnSync('bash', [entrypoint], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        GITHUB_WORKSPACE: dir,
        INPUT_COMMENT_COMMAND: 'true',
        INPUT_COMMENT_BODY: '/dsh-migrate redeploy',
        INPUT_COMMENT_ID: '3456789',
        INPUT_COMMENT_AUTHOR: 'maintainer',
        INPUT_COMMENT_AUTHOR_ASSOCIATION: 'MEMBER',
        INPUT_ISSUE_NUMBER: '12',
        INPUT_PULL_REQUEST: '12',
        INPUT_WORKDIR: '.',
        DSH_MIGRATE_CLI: fakeCli,
        DSH_MIGRATE_ARGV_OUT: out,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const argv = JSON.parse(readFileSync(out, 'utf8')) as string[]
    assert.equal(argv[0], 'command')
    assert.equal(argv[argv.indexOf('--comment-body') + 1], '/dsh-migrate redeploy')
    // The comment id is what makes a redelivery the same command, so it has to
    // survive the mapping from the workflow's event payload.
    assert.equal(argv[argv.indexOf('--comment-id') + 1], '3456789')
    assert.equal(argv[argv.indexOf('--comment-author') + 1], 'maintainer')
    assert.equal(argv[argv.indexOf('--comment-author-association') + 1], 'MEMBER')
    assert.equal(argv[argv.indexOf('--issue-number') + 1], '12')
    assert.equal(argv[argv.indexOf('--pull-request') + 1], '12')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('entrypoint maps the two override inputs, and only for the values it claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-entry-'))
  try {
    const out = join(dir, 'argv.json')
    const fakeCli = join(dir, 'fake-cli.mjs')
    writeFileSync(fakeCli, `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.DSH_MIGRATE_ARGV_OUT, JSON.stringify(process.argv.slice(2)))
`)
    chmodSync(entrypoint, 0o755)
    const argvFor = (env: NodeJS.ProcessEnv): string[] => {
      const result = spawnSync('bash', [entrypoint], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: dir,
          GITHUB_WORKSPACE: dir,
          INPUT_WORKDIR: '.',
          DSH_MIGRATE_CLI: fakeCli,
          DSH_MIGRATE_ARGV_OUT: out,
          ...env,
        },
      })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(readFileSync(out, 'utf8')) as string[]
    }

    const both = argvFor({ INPUT_ALLOW_SECOND_PULL_REQUEST: 'true', INPUT_FEEDBACK_RESEND: 'true' })
    assert.ok(both.includes('--allow-second-pr'))
    assert.ok(both.includes('--resend'))
    // `1` and a capitalised word are not the values this entrypoint accepts —
    // the same `[Tt]rue` glob every other boolean input uses.
    const one = argvFor({ INPUT_ALLOW_SECOND_PULL_REQUEST: '1', INPUT_FEEDBACK_RESEND: 'TRUE' })
    assert.equal(one.includes('--allow-second-pr'), false)
    assert.equal(one.includes('--resend'), false)
    const empty = argvFor({})
    assert.equal(empty.includes('--allow-second-pr'), false)
    assert.equal(empty.includes('--resend'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
