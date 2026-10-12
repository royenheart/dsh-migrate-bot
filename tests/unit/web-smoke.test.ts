import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasClientSurface, scrubWebOutput, WEB_READY_PATTERN, webArgs, webSmoke } from '../../src/verify/web.ts'

function plugin(fields: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-web-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/plugin', ...fields }))
  return dir
}

test('only a dsh.client declaration counts as a browser surface', () => {
  const without = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const withClient = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  try {
    assert.equal(hasClientSurface(without), false)
    assert.equal(hasClientSurface(withClient), true)
  } finally {
    rmSync(without, { recursive: true, force: true })
    rmSync(withClient, { recursive: true, force: true })
  }
})

test('a plugin without a client surface skips the web layer instead of failing it', async () => {
  const dir = plugin({})
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 1_000,
      spawnImpl: async () => {
        throw new Error('must not boot a server for a plugin with no client surface')
      },
    })
    assert.equal(result.ok, true)
    assert.match(result.skipped ?? '', /no plugin declares a dsh\.client surface/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a server that reports ready passes, and the profile mounts the web bundle', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  let seen: { args: string[]; bundles: unknown; env: NodeJS.ProcessEnv } | undefined
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: 'Options:\n  --host <host>\n  --no-open  do not open the Web UI\n',
      spawnImpl: async (args, options) => {
        seen = {
          args,
          env: options.env,
          bundles: JSON.parse(readFileSync(join(options.env.DSH_HOME ?? '', 'profiles', 'probe-web', 'package.json'), 'utf8')).dsh.profile.bundles,
        }
        return { code: 0, output: 'dsh web: listening on http://127.0.0.1:41234\n', timedOut: false, ready: true }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.signature, 'web: server ready')
    assert.deepEqual(seen?.args, ['web', '--port', '0', '--no-open'])
    assert.deepEqual(seen?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/plugin'])
    assert.equal(seen?.env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:9/v1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a plugin that breaks the boot is reported with the same wording as the probe', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      spawnImpl: async () => ({
        code: 1,
        output: 'dsh: plugin(s) failed to load: @acme/plugin; Cordis startup failed',
        timedOut: false,
        ready: false,
      }),
    })
    assert.equal(result.ok, false)
    assert.match(result.signature, /^web load: /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a server that never becomes ready fails rather than hanging', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      spawnImpl: async () => ({ code: null, output: 'starting…', timedOut: true, ready: false }),
    })
    assert.equal(result.ok, false)
    assert.match(result.signature, /^web timeout/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the live session token never reaches a report', async () => {
  // Verbatim shape from `dsh 0.1.5-rc.1`: the ready line carries a session token.
  const ready = 'dsh web: http://127.0.0.1:37489/?token=UlTfzH-hO8vTeUXbFIdCPVZMPOXYOzh-SkubMiZLe1U\n'
  assert.doesNotMatch(scrubWebOutput(ready), /UlTfzH/)
  assert.match(scrubWebOutput(ready), /token=<redacted>/)

  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      spawnImpl: async () => ({ code: 0, output: ready, timedOut: false, ready: true }),
    })
    assert.doesNotMatch(result.detail, /UlTfzH/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ready pattern matches what dsh web actually prints', () => {
  assert.equal(WEB_READY_PATTERN.test('dsh web: listening on http://127.0.0.1:4000'), true)
  assert.equal(WEB_READY_PATTERN.test('dsh: plugin(s) failed to load: x'), false)
})

test('the browser is kept closed with --no-open only where the release has the flag', () => {
  assert.deepEqual(webArgs('Options:\n  --no-open  do not open the Web UI\n'), ['web', '--port', '0', '--no-open'])
  // 0.1.0-rc.6 has no --no-open and opens no browser.
  assert.deepEqual(webArgs('Options:\n  --host <host>\n  --port <port>\n'), ['web', '--port', '0'])
})
