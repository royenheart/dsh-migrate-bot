import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAUNCHER } from '../src/providers/common.ts'

/**
 * The preview's check must load the composition `serve` loads, or a plugin
 * whose browser half needs a web-only service passes the Action and fails its
 * own preview. These tests use a fake dsh that records the profile it was given
 * and behaves differently for the headless and web compositions.
 */

const FAKE_DSH = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const profile = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'profiles', 'check', 'package.json'), 'utf8'))
fs.writeFileSync(process.env.RECORD, JSON.stringify(profile))
const bundles = profile.dsh.profile.bundles
if (bundles.includes('@deepseek-ai/dsh-web-app')) {
  process.stdout.write('dsh web: http://127.0.0.1:12345/?token=secret-launch-token\\n')
  setInterval(() => {}, 1000)
} else {
  process.stderr.write('dsh: TRANSPORT: DeepSeek API request to http://127.0.0.1:9/v1 failed\\n')
  process.exit(1)
}
`

function fixture(client: boolean): { root: string; plugin: string; bin: string; record: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-launcher-test-'))
  const plugin = join(root, 'plugin')
  mkdirSync(plugin)
  const manifest = {
    name: '@fixture/launcher-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      ...(client ? { client: { platform: 'web' } } : {}),
    },
  }
  writeFileSync(join(plugin, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(plugin, 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(plugin, 'cordis.patch.yml'), '- insert: []\n')
  const bin = join(root, 'dsh')
  const record = join(root, 'profile.json')
  writeFileSync(bin, FAKE_DSH, { mode: 0o755 })
  return { root, plugin, bin, record, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

function check(f: ReturnType<typeof fixture>): { status: number | null; output: string; profile: { dsh?: { profile?: { bundles?: string[] } } } } {
  const result = spawnSync(process.execPath, [LAUNCHER, 'check'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      DSH_BIN: f.bin,
      PLUGIN_DIR: f.plugin,
      RECORD: f.record,
      CHECK_TIMEOUT_MS: '5000',
    },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { status: result.status, output, profile: JSON.parse(readFileSync(f.record, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } } }
}

test('a plugin with a browser half is checked in the web composition, and its launch token is redacted', () => {
  const f = fixture(true)
  try {
    const result = check(f)
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(result.profile.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@fixture/launcher-plugin'])
    assert.match(result.output, /token=<redacted>/)
    assert.doesNotMatch(result.output, /secret-launch-token/)
  } finally {
    f.cleanup()
  }
})

test('a plugin without a browser half keeps the headless boot check', () => {
  const f = fixture(false)
  try {
    const result = check(f)
    assert.equal(result.status, 1, result.output)
    assert.deepEqual(result.profile.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@fixture/launcher-plugin'])
    assert.match(result.output, /TRANSPORT/)
  } finally {
    f.cleanup()
  }
})
