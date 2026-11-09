import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasClientSurface, scrubWebOutput, WEB_READY_PATTERN, webArgs, webSmoke } from '../../src/verify/web.ts'
import { declaredPresets, pluginBundles, presetPluginNames, unresolvedBundleRows } from '../../src/verify/bundle.ts'

function plugin(fields: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-web-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/plugin', ...fields }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
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
    assert.deepEqual(seen?.args, ['--profile', 'probe-web', '--port', '0', '--no-open'])
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
  // Deterministic synthetic session token: the ready line carries a token.
  const ready = 'dsh web: http://127.0.0.1:37489/?token=test-session-token-0123456789\n'
  assert.doesNotMatch(scrubWebOutput(ready), /test-session-token/)
  assert.match(scrubWebOutput(ready), /token=<redacted>/)

  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      spawnImpl: async () => ({ code: 0, output: ready, timedOut: false, ready: true }),
    })
    assert.doesNotMatch(result.detail, /test-session-token/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ready pattern matches what dsh web actually prints', () => {
  assert.equal(WEB_READY_PATTERN.test('dsh web: listening on http://127.0.0.1:4000'), true)
  assert.equal(WEB_READY_PATTERN.test('dsh: plugin(s) failed to load: x'), false)
})

test('the profile under test is served, and the browser kept closed with --no-open only where the release has the flag', () => {
  // `dsh web` is `dsh --profile web`: it would serve a fresh default profile without the plugins.
  assert.deepEqual(webArgs('Options:\n  --no-open  do not open the Web UI\n', 'probe-web'), ['--profile', 'probe-web', '--port', '0', '--no-open'])
  // 0.1.0-rc.6 has no --no-open and opens no browser.
  assert.deepEqual(webArgs('Options:\n  --host <host>\n  --port <port>\n', 'probe-web'), ['--profile', 'probe-web', '--port', '0'])
})

test('a server that left a plugin out is not ready for it', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  try {
    // Verbatim shape from dsh 0.2.0-rc.1, which skips the bundle and serves anyway.
    const output = 'dsh: skipping profile bundle "@acme/plugin": Error: Plugin @acme/plugin@1.0.0 is incompatible with dsh 0.2.0-rc.1: peerDependencies {"@deepseek-ai/dsh-llm":"^0.1.5-rc.2"}\ndsh web: http://127.0.0.1:44323/?token=abc\n'
    const result = await webSmoke({ workdir: dir, bin: '/bin/dsh', timeoutMs: 5_000, webHelp: '', spawnImpl: async () => ({ code: null, output, timedOut: false, ready: true }) })
    assert.equal(result.ok, false)
    assert.match(result.signature, /^web load: @acme\/plugin: Error: Plugin @acme\/plugin@/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


function presetPlugin(): string {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: preset-opencode-omo',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: opencode-omo',
    '        name: opencode-omo',
    '',
  ].join('\n'))
  return dir
}

function presetFetch(broken: string | undefined): typeof fetch {
  const login = new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth=session; Path=/' } })
  const api = new Response(JSON.stringify({ result: { ok: true, value: { presets: [{ id: 'opencode-omo', ...(broken === undefined ? {} : { broken }) }] } } }), { status: 200 })
  return async (input) => String(input).includes('/api/agentPresets/list') ? api : login
}

test('a broken declared preset fails the web check', async () => {
  const dir = presetPlugin()
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: '',
      fetchImpl: presetFetch('tool-subagent-list-agents: never started'),
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=secret\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, false)
    assert.match(result.signature, /preset unhealthy/)
    assert.match(result.detail, /opencode-omo.*never started/)
    assert.doesNotMatch(result.detail, /secret/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a healthy declared preset passes the web check', async () => {
  const dir = presetPlugin()
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: '',
      fetchImpl: presetFetch(undefined),
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=secret\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, true)
    assert.match(result.signature, /presets healthy: opencode-omo/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('an unresolved bundle row is advisory, not a web failure', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: missing\n      name: "@acme/missing"\n')
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: process.execPath,
      timeoutMs: 5_000,
      webHelp: '',
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=x\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, true)
    assert.match(result.detail, /advisory:.*@acme\/missing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a preset display name in config is not mistaken for a module row', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: preset-opencode-omo',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: opencode-omo',
    '        name: opencode-omo display name',
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => row.name), ['@deepseek-ai/dsh-agent-preset'])
    assert.equal(rows[0]?.presetId, 'opencode-omo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a config array of display names stays out of the module rows', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: model-router',
    "      name: '@acme/router'",
    '      config:',
    '        models:',
    '          - id: deepseek-chat',
    '            name: DeepSeek Chat',
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => row.name), ['@acme/router'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a disabled row does not fail resolution', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: optional-missing',
    "      name: '@acme/missing'",
    '      disabled: true',
    '',
  ].join('\n'))
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: process.execPath,
      timeoutMs: 5_000,
      webHelp: '',
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=x\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the preset health timeout also stops the kept server', async () => {
  const dir = presetPlugin()
  let stopped = 0
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 20,
      webHelp: '',
      fetchImpl: async () => new Promise<Response>(() => {}),
      spawnImpl: async () => ({
        code: 0,
        output: 'dsh web: http://127.0.0.1:41234/?token=x\n',
        timedOut: false,
        ready: true,
        stop: () => { stopped += 1 },
      }),
    })
    assert.equal(result.ok, false)
    assert.match(result.signature, /preset check timed out/)
    assert.equal(stopped, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a disabled parent group keeps its children out of resolution', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: optional-group',
    '      name: cordis:group',
    '      group: true',
    '      disabled: true',
    '      config:',
    '        - id: optional-missing',
    "          name: '@acme/missing'",
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => [row.name, row.enabled]), [['cordis:group', false], ['@acme/missing', false]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a plugin-specific config.plugins array stays out of the module rows', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: model-router',
    "      name: '@acme/router'",
    '      config:',
    '        plugins:',
    '          - id: nested-label',
    '            name: Display label',
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => row.name), ['@acme/router'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('null and expression disabled gates stay enabled', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: null-gate',
    "      name: '@acme/one'",
    '      disabled: null',
    '    - id: expression-gate',
    "      name: '@acme/two'",
    "      disabled: !!js false",
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => [row.name, row.enabled]), [['@acme/one', true], ['@acme/two', true]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a relative module resolves from the patch file directory', () => {
  const dir = plugin({ dsh: { bundle: { patch: './patches/verification.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), '')
  const patches = join(dir, 'patches')
  mkdirSync(patches, { recursive: true })
  writeFileSync(join(patches, 'verification.yml'), '- insert:\n    - id: local\n      name: ../lib/index.js\n')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), 'export default {}\n')
  try {
    assert.deepEqual(unresolvedBundleRows(dir, process.execPath), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('an unreadable bundle patch is advisory when the web server serves', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './missing.yml' }, client: { platform: 'web' } } })
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: '',
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=x\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, true)
    assert.match(result.detail, /advisory:.*missing.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('the same preset declared twice is rejected before a roster can hide one declaration', async () => {
  const dir = presetPlugin()
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: preset-one',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: opencode-omo',
    '    - id: preset-two',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: opencode-omo',
    '',
  ].join('\n'))
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: '',
      fetchImpl: async () => { throw new Error('must not query a duplicate declaration') },
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=x\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, false)
    assert.match(result.signature, /duplicate preset declaration/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('an expression disabled true gate is disabled', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: expression-off',
    "      name: '@acme/missing'",
    '      disabled: !!js true',
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => [row.name, row.enabled]), [['@acme/missing', false]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ordered array patch declaration contributes every patch', () => {
  const dir = plugin({ dsh: { bundle: { patch: ['./one.yml', './two.yml'] }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'one.yml'), '- insert:\n    - id: first\n      name: first\n')
  writeFileSync(join(dir, 'two.yml'), '- insert:\n    - id: second\n      name: second\n')
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => row.name), ['first', 'second'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a later id-targeted disable gate overrides an inserted row', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: later-off',
    "      name: '@acme/missing'",
    '- id: later-off',
    '  disabled: true',
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => [row.name, row.enabled]), [['@acme/missing', false]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a self-mounted plugin without exports resolves when its entry exists', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: self\n      name: "@acme/plugin"\n')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), 'export default {}\n')
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...manifest, main: 'lib/index.js' }))
  try {
    assert.deepEqual(unresolvedBundleRows(dir, process.execPath), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a later disabled group cascades to its child rows', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: group',
    '      name: cordis:group',
    '      group: true',
    '      config:',
    '        - id: child',
    "          name: '@acme/missing'",
    '- id: group',
    '  disabled: true',
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => [row.name, row.enabled]), [['cordis:group', false], ['@acme/missing', false]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a declared preset cannot reuse a shipped preset id', async () => {
  const dir = presetPlugin()
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: preset-shadow',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '',
  ].join('\n'))
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: '',
      fetchImpl: async () => { throw new Error('must reject a shipped-id collision before the roster') },
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=x\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, false)
    assert.match(result.signature, /collides with a shipped preset/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed roster entry is reported as an unavailable roster', async () => {
  const dir = presetPlugin()
  const login = new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth=session; Path=/' } })
  const api = new Response(JSON.stringify({ result: { ok: true, value: { presets: [null] } } }), { status: 200 })
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: '',
      fetchImpl: async input => String(input).includes('/api/agentPresets/list') ? api : login,
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=x\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, false)
    assert.match(result.signature, /preset roster unavailable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a preset-only plugin still gets the preset check without dsh.client', async () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: preset-only',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: opencode-omo',
    '',
  ].join('\n'))
  try {
    const result = await webSmoke({
      workdir: dir,
      bin: '/bin/dsh',
      timeoutMs: 5_000,
      webHelp: '',
      fetchImpl: presetFetch(undefined),
      spawnImpl: async () => ({ code: 0, output: 'dsh web: http://127.0.0.1:41234/?token=x\n', timedOut: false, ready: true }),
    })
    assert.equal(result.ok, true)
    assert.match(result.signature, /presets healthy: opencode-omo/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a preset inserted through an id patch is visible to the activity gate', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: host-group',
    '  config:',
    '    - id: inserted-preset',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: acme',
    '',
  ].join('\n'))
  try {
    assert.deepEqual(presetPluginNames(dir), ['@acme/plugin'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a group config replacement keeps sibling rows and the preset declaration', () => {
  const dir = plugin({ dsh: { bundle: { patch: './cordis.patch.yml' } } })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: sibling',
    '      name: sibling-module',
    '    - id: group',
    '      name: cordis:group',
    '      group: true',
    '      config:',
    '        - id: old-child',
    '          name: old-module',
    '    - id: preset-row',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: acme',
    '- id: group',
    '  config:',
    '    - id: new-child',
    '      name: new-module',
    '',
  ].join('\n'))
  try {
    const rows = pluginBundles(dir)[0]?.rows ?? []
    assert.deepEqual(rows.map(row => row.name), ['sibling-module', 'cordis:group', '@deepseek-ai/dsh-agent-preset', 'new-module'])
    assert.deepEqual(declaredPresets(dir).map(preset => preset.id), ['acme'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
