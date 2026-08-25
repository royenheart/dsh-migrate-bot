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
