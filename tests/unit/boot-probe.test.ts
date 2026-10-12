import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bootProbe,
  classifyBoot,
  normalizeSignature,
  writeProbeProfile,
  type BootSpawnResult,
} from '../../src/verify/boot.ts'

const MODEL_ERROR = `
dsh: AUTH: Authentication Fails, Your api key: ****-key is invalid
`

test('a boot that reaches the model call passes', () => {
  const result = classifyBoot({ code: 1, stdout: '', stderr: MODEL_ERROR, timedOut: false })
  assert.equal(result.outcome, 'pass')
})

test('the real dead-port transport failure counts as a successful boot', () => {
  // Verbatim from `dsh 0.1.5-rc.1` with the model route pointed at the probe's
  // dead port: the plugin tree loaded and the host got as far as the model call.
  const result = classifyBoot({
    code: 1,
    stdout: '',
    stderr: 'dsh: TRANSPORT: DeepSeek API request to http://127.0.0.1:9/v1 failed',
    timedOut: false,
  })
  assert.equal(result.outcome, 'pass')
})

test('a clean exit passes', () => {
  assert.equal(classifyBoot({ code: 0, stdout: 'done', stderr: '', timedOut: false }).outcome, 'pass')
})

test('a plugin that fails to load is named in the signature', () => {
  const result = classifyBoot({
    code: 1,
    stdout: '',
    stderr: 'dsh: plugin(s) failed to load: @acme/dsh-plugin-foo; Cordis startup failed',
    timedOut: false,
  })
  assert.equal(result.outcome, 'fail')
  assert.match(result.signature, /^load: /)
  assert.match(result.signature, /@acme\/dsh-plugin-foo/)
})

test('a plugin waiting on a missing service fails', () => {
  const result = classifyBoot({
    code: 1,
    stdout: '',
    stderr: 'dsh: 1 plugin did not activate\n@acme/plugin: pending (waiting for services: settings, slots)',
    timedOut: false,
  })
  assert.equal(result.outcome, 'fail')
  assert.match(result.signature, /^pending: /)
  assert.match(result.signature, /settings, slots/)
})

test('the real loader wording for a throwing apply is classified and named', () => {
  // Verbatim from `dsh 0.1.5-rc.1` booting the boot-break fixture: the host
  // names the row, the package and the thrown message.
  const result = classifyBoot({
    code: 1,
    stdout: '',
    stderr: 'failed to apply loader entry include (cordis:include): failed to apply loader entry '
      + 'fixture-boot-break (@fixture/dsh-plugin-boot-break): fixture-boot-break: activate() always throws',
    timedOut: false,
  })
  assert.equal(result.outcome, 'fail')
  assert.match(result.signature, /fixture-boot-break/)
  assert.match(result.signature, /activate\(\) always throws/)
})

test('a throwing apply is reported as an activation failure', () => {
  const result = classifyBoot({
    code: 1,
    stdout: '',
    stderr: 'dsh: plugin(s) failed to load: bad\nbad: TypeError: cannot read properties of undefined (reading id)\ndsh: 1 plugin did not activate',
    timedOut: false,
  })
  assert.equal(result.outcome, 'fail')
  assert.match(result.signature, /load: bad/)
})

test('the watchdog turns a hung boot into a timeout, not a stall', () => {
  const result = classifyBoot({ code: null, stdout: 'booting', stderr: '', timedOut: true })
  assert.equal(result.outcome, 'timeout')
  assert.equal(result.signature, 'timeout: boot did not finish')
})

test('an unexplained nonzero exit still fails', () => {
  const result = classifyBoot({ code: 3, stdout: '', stderr: 'something went wrong', timedOut: false })
  assert.equal(result.outcome, 'fail')
  assert.match(result.signature, /^exit3: /)
})

test('an unrecognized crash is summarized by its cause, not by stack punctuation', () => {
  // Verbatim shape from a plugin whose apply() throws under a real dsh boot:
  // the host dumps a Node stack trace instead of a named boot failure.
  const result = classifyBoot({
    code: 1,
    stdout: '',
    stderr: [
      'file:///tmp/dsh-migrate-probe-abc/profiles/probe/#fixture-boot-break',
      '    at Fiber.execute (/opt/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1067:24) {',
      '      [cause]: Error: fixture-boot-break: activate() always throws',
      '          at new apply (file:///github/workspace/src/index.js:8:9)',
      '}',
      'Node.js v24.19.0',
    ].join('\n'),
    timedOut: false,
  })
  assert.equal(result.outcome, 'fail')
  assert.match(result.signature, /activate\(\) always throws/)
  assert.doesNotMatch(result.signature, /Node\.js/)
})

test('signatures ignore paths, ids and numbers so the same fault compares equal', () => {
  const a = normalizeSignature('pending (waiting for services: settings) at /tmp/dsh-migrate-probe-abc123')
  const b = normalizeSignature('pending (waiting for services: settings) at /tmp/dsh-migrate-probe-zzz999')
  assert.equal(a, b)
  assert.match(a, /<path>/)
})

test('differing failures keep differing signatures', () => {
  const one = classifyBoot({ code: 1, stdout: '', stderr: 'dsh: plugin(s) failed to load: alpha', timedOut: false })
  const two = classifyBoot({ code: 1, stdout: '', stderr: 'dsh: plugin(s) failed to load: beta', timedOut: false })
  assert.notEqual(one.signature, two.signature)
})

test('the scratch profile names the plugin in its bundle list and loads its patches once', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mig-home-'))
  try {
    writeProbeProfile(home, 'probe', ['@acme/dsh-plugin-foo'])
    const pkg: unknown = JSON.parse(readFileSync(join(home, 'profiles', 'probe', 'package.json'), 'utf8'))
    assert.deepEqual((pkg as { dsh: { profile: unknown } }).dsh.profile, {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@acme/dsh-plugin-foo'],
      patchReload: 'startup',
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the probe is keyless and points the model route at a dead port', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-mig-plugin-'))
  let seen: { args: string[]; env: NodeJS.ProcessEnv; bin: string } | undefined
  try {
    writeFileSync(join(workdir, 'package.json'), JSON.stringify({ name: '@acme/dsh-plugin-foo', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    const result = await bootProbe({
      workdir,
      timeoutMs: 5_000,
      bin: '/opt/probe/bin/dsh',
      spawnImpl: async (args, options): Promise<BootSpawnResult> => {
        seen = { args, env: options.env, bin: options.bin }
        return { code: 1, stdout: '', stderr: MODEL_ERROR, timedOut: false }
      },
    })
    assert.equal(result.outcome, 'pass')
    assert.deepEqual(seen?.args, ['--profile', 'probe', 'ping'])
    assert.equal(seen?.bin, '/opt/probe/bin/dsh')
    assert.equal(seen?.env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:9/v1')
    assert.equal(seen?.env.DSH_TELEMETRY_DISABLED, '1')
    assert.notEqual(seen?.env.DEEPSEEK_API_KEY, undefined)
    // The plugin is symlinked into the scratch home, then the home is removed.
    assert.notEqual(seen?.env.DSH_HOME, undefined)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('a tree without a plugin fails fast instead of booting', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-mig-plugin-'))
  try {
    mkdirSync(join(workdir, 'src'))
    const result = await bootProbe({
      workdir,
      timeoutMs: 1_000,
      spawnImpl: async () => {
        throw new Error('must not spawn without a package name')
      },
    })
    assert.equal(result.outcome, 'fail')
    assert.match(result.signature, /no plugin/)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('every plugin of a repository boots in one profile', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-mig-plugins-'))
  let profile: { bundles: string[]; linked: string[] } | undefined
  try {
    for (const [dir, name] of [['host', '@acme/host'], ['web', '@acme/web']] as const) {
      mkdirSync(join(workdir, dir))
      writeFileSync(join(workdir, dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    }
    const result = await bootProbe({
      workdir,
      timeoutMs: 5_000,
      spawnImpl: async (_args, options): Promise<BootSpawnResult> => {
        const dir = join(options.env.DSH_HOME ?? '', 'profiles', 'probe')
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
        profile = { bundles: manifest.dsh.profile.bundles, linked: ['@acme/host', '@acme/web'].filter(name => existsSync(join(dir, 'node_modules', name, 'package.json'))) }
        return { code: 1, stdout: '', stderr: MODEL_ERROR, timedOut: false }
      },
    })
    assert.equal(result.outcome, 'pass')
    assert.deepEqual(profile, { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@acme/host', '@acme/web'], linked: ['@acme/host', '@acme/web'] })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})
