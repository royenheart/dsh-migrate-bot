import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  createLayeredScope,
  installWorkspaceLayer,
  mergeMcpConfigs,
  readWorkspaceConfig,
} from '../src/host/workspace-config.js'

function stdioConfig(overrides = {}) {
  return {
    command: 'node',
    args: [],
    env: {},
    headers: {},
    auth: 'headers',
    scopes: [],
    disabled: false,
    autoAllow: false,
    lifecycle: 'lazy',
    idleTimeoutMinutes: 10,
    promotedTools: [],
    ...overrides,
  }
}

function httpConfig(overrides = {}) {
  return {
    url: 'https://mcp.example.test/api',
    headers: {},
    args: [],
    env: {},
    auth: 'headers',
    scopes: [],
    disabled: false,
    autoAllow: false,
    lifecycle: 'lazy',
    idleTimeoutMinutes: 10,
    promotedTools: [],
    ...overrides,
  }
}

function missingFileError() {
  return Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
}

function noDirectoryWatch() {
  return () => {}
}

function fakeConfigFile(initialBody) {
  const state = { body: initialBody, reads: 0, file: undefined }
  const read = async (file) => {
    state.reads += 1
    state.file = file
    if (state.body instanceof Error) throw state.body
    return state.body
  }
  return { read, state }
}

class FakeGlobalScope {
  constructor(value) {
    this.value = structuredClone(value)
    this.watchers = new Set()
    this.updates = []
    this.mutations = []
    this.released = 0
  }

  get() {
    return structuredClone(this.value)
  }

  watch(listener) {
    this.watchers.add(listener)
    return () => {
      this.watchers.delete(listener)
      this.released += 1
    }
  }

  update(patch) {
    this.updates.push(structuredClone(patch))
    return Promise.resolve()
  }

  mutate(ops) {
    this.mutations.push(structuredClone(ops))
    return Promise.resolve()
  }

  async emit(value) {
    this.value = structuredClone(value)
    for (const listener of [...this.watchers]) await listener()
  }
}

function fakeDirectoryWatch() {
  const state = { listeners: [], stops: 0, directory: undefined }
  const watch = (directory, onChange) => {
    state.directory = directory
    state.listeners.push(onChange)
    return () => {
      state.stops += 1
    }
  }
  const emit = async () => {
    await Promise.all(state.listeners.map((listener) => listener('change', 'mcp.json')))
  }
  return { watch, emit, state }
}

test('workspace entries replace global entries wholesale and label sources', () => {
  const globalServers = {
    shared: stdioConfig({ args: ['global.js'], autoAllow: true, env: { GLOBAL_TOKEN: 'g' } }),
    onlyGlobal: httpConfig({ url: 'https://global.example.test/mcp', idleTimeoutMinutes: 5 }),
  }
  const workspaceServers = {
    shared: stdioConfig({ command: 'bun' }),
    onlyWorkspace: httpConfig({ url: 'https://workspace.example.test/mcp' }),
  }

  const merged = mergeMcpConfigs(globalServers, workspaceServers)

  assert.deepEqual(merged.sources, {
    shared: 'workspace',
    onlyGlobal: 'global',
    onlyWorkspace: 'workspace',
  })
  assert.deepEqual(merged.servers.shared, stdioConfig({ command: 'bun' }))
  assert.deepEqual(merged.servers.onlyGlobal, globalServers.onlyGlobal)
  assert.deepEqual(merged.servers.onlyWorkspace, workspaceServers.onlyWorkspace)

  merged.servers.shared.command = 'mutated'
  assert.equal(globalServers.shared.command, 'node')
  assert.equal(workspaceServers.shared.command, 'bun')
})

test('the merge tolerates absent layers', () => {
  assert.deepEqual(mergeMcpConfigs(undefined, undefined), { servers: {}, sources: {} })
  const merged = mergeMcpConfigs({ demo: stdioConfig() }, undefined)
  assert.deepEqual(merged.servers, { demo: stdioConfig() })
  assert.deepEqual(merged.sources, { demo: 'global' })
})

test('a missing workspace file is an empty layer at .dsh/mcp.json, not an error', async () => {
  let requested
  const result = await readWorkspaceConfig('/root', {
    readFile: async (file) => {
      requested = file
      throw missingFileError()
    },
  })
  assert.deepEqual(result, { servers: {} })
  assert.equal(requested, join('/root', '.dsh', 'mcp.json'))
})

test('a read failure other than a missing file rejects the whole layer', async () => {
  const result = await readWorkspaceConfig('/root', {
    readFile: async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    },
  })
  assert.equal(result.servers, undefined)
  assert.match(result.error, /could not read/)
})

test('a valid workspace file applies Adapter defaults through the shared schema', async () => {
  const result = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'server'] },
        remote: {
          url: 'https://mcp.example.test/api',
          headers: { Authorization: 'Bearer x' },
          autoAllow: true,
        },
      },
    }),
  })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.servers.local, stdioConfig({ command: 'npx', args: ['-y', 'server'] }))
  assert.deepEqual(result.servers.remote, httpConfig({
    headers: { Authorization: 'Bearer x' },
    autoAllow: true,
  }))
})

test('invalid JSON rejects the whole layer', async () => {
  const result = await readWorkspaceConfig('/root', { readFile: async () => '{not json' })
  assert.equal(result.servers, undefined)
  assert.match(result.error, /not valid JSON/)
})

test('a non-object workspace file rejects the whole layer', async () => {
  const result = await readWorkspaceConfig('/root', { readFile: async () => '[]' })
  assert.match(result.error, /must contain a JSON object/)
})

test('unknown top-level keys reject the whole layer', async () => {
  const result = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({ mcpServers: {}, imports: [] }),
  })
  assert.equal(result.servers, undefined)
  assert.match(result.error, /unknown top-level key "imports"/)
})

test('a non-object mcpServers section rejects the whole layer', async () => {
  const result = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({ mcpServers: [] }),
  })
  assert.match(result.error, /"mcpServers" must be an object/)
})

test('a Server entry that fails the shared validation rejects the whole layer', async () => {
  const bothTransports = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({
      mcpServers: { broken: { command: 'node', url: 'https://example.test/mcp' } },
    }),
  })
  assert.match(bothTransports.error, /configure exactly one transport/)

  const unknownField = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({
      mcpServers: { broken: { command: 'node', timeout: 10 } },
    }),
  })
  assert.match(unknownField.error, /unknown field/)

  const notAnObject = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({ mcpServers: { broken: 'nope' } }),
  })
  assert.match(notAnObject.error, /expected object/)

  const reservedName = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({
      mcpServers: { demo: { command: 'node' }, constructor: { command: 'node' } },
    }),
  })
  assert.match(reservedName.error, /reserved server name/)
})

test('deps.validate replaces the shared cross-field validation', async () => {
  const seen = []
  const result = await readWorkspaceConfig('/root', {
    readFile: async () => JSON.stringify({ mcpServers: { demo: { command: 'node' } } }),
    validate: (value) => {
      seen.push(value)
      throw new Error('rejected by the injected validator')
    },
  })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].mcpServers.demo, stdioConfig())
  assert.match(result.error, /rejected by the injected validator/)
})

test('get returns the merged namespace value with per-Server sources', async () => {
  const scope = new FakeGlobalScope({
    mcpServers: {
      shared: stdioConfig({ args: ['global.js'] }),
      onlyGlobal: stdioConfig({ command: 'global' }),
    },
  })
  const file = fakeConfigFile(JSON.stringify({
    mcpServers: {
      shared: stdioConfig({ command: 'bun' }),
      onlyWorkspace: stdioConfig({ command: 'workspace' }),
    },
  }))
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: noDirectoryWatch(),
  })

  await layer.refreshLayers()

  const value = layer.get()
  assert.deepEqual(Object.keys(value), ['mcpServers'])
  assert.deepEqual(Object.keys(value.mcpServers).sort(), ['onlyGlobal', 'onlyWorkspace', 'shared'])
  assert.equal(value.mcpServers.shared.command, 'bun')
  assert.deepEqual(layer.layerSnapshot(), {
    source: { shared: 'workspace', onlyGlobal: 'global', onlyWorkspace: 'workspace' },
    error: undefined,
    servers: {
      shared: (({ env, headers, ...rest }) => rest)(stdioConfig({ command: 'bun' })),
      onlyWorkspace: (({ env, headers, ...rest }) => rest)(stdioConfig({ command: 'workspace' })),
    },
  })
  layer.dispose()
})

test('a global change re-reads the workspace layer and notifies with the merged value', async () => {
  const scope = new FakeGlobalScope({ mcpServers: { demo: stdioConfig() } })
  const file = fakeConfigFile(JSON.stringify({ mcpServers: {} }))
  const seen = []
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: noDirectoryWatch(),
  })
  layer.watch((next, previous) => seen.push([next, previous]))

  await scope.emit({
    mcpServers: {
      demo: stdioConfig({ autoAllow: true }),
      extra: stdioConfig({ command: 'bun' }),
    },
  })

  assert.equal(file.state.reads, 2)
  assert.equal(seen.length, 1)
  assert.deepEqual(Object.keys(seen[0][0].mcpServers).sort(), ['demo', 'extra'])
  assert.deepEqual(Object.keys(seen[0][1].mcpServers), ['demo'])
  layer.dispose()
  assert.equal(scope.released, 1)
})

test('a workspace file change notifies listeners only when the merge changes', async () => {
  const scope = new FakeGlobalScope({ mcpServers: { demo: stdioConfig() } })
  const file = fakeConfigFile(JSON.stringify({ mcpServers: {} }))
  const dir = fakeDirectoryWatch()
  const seen = []
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: dir.watch,
  })
  layer.watch((next) => seen.push(next))
  await layer.refreshLayers()
  assert.equal(seen.length, 0)

  await dir.emit()
  assert.equal(seen.length, 0)

  file.state.body = JSON.stringify({
    mcpServers: { demo: stdioConfig({ autoAllow: true }) },
  })
  await dir.emit()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].mcpServers.demo.autoAllow, true)

  layer.dispose()
  assert.equal(dir.state.stops, 1)
})

test('a directory watch that fails leaves refresh to global changes and refreshLayers', async () => {
  const scope = new FakeGlobalScope({ mcpServers: { demo: stdioConfig() } })
  const file = fakeConfigFile(JSON.stringify({
    mcpServers: { demo: stdioConfig({ autoAllow: true }) },
  }))
  const seen = []
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: () => {
      throw new Error('watching is not supported here')
    },
  })
  layer.watch((next) => seen.push(next))

  await layer.refreshLayers()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].mcpServers.demo.autoAllow, true)

  layer.dispose()
})

test('update and mutate forward to the global scope only', async () => {
  const scope = new FakeGlobalScope({ mcpServers: {} })
  const file = fakeConfigFile(missingFileError())
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: noDirectoryWatch(),
  })
  await layer.refreshLayers()

  await layer.update({ mcpServers: { demo: stdioConfig() } })
  await layer.mutate([{ op: 'set', path: ['mcpServers', 'demo', 'autoAllow'], value: true }])

  assert.deepEqual(scope.updates, [{ mcpServers: { demo: stdioConfig() } }])
  assert.deepEqual(scope.mutations, [[
    { op: 'set', path: ['mcpServers', 'demo', 'autoAllow'], value: true },
  ]])
  assert.deepEqual(layer.get().mcpServers, {})
  layer.dispose()

  const bareLayer = createLayeredScope(
    {
      get: () => ({ mcpServers: {} }),
      watch: () => () => {},
      update: () => Promise.resolve(),
    },
    {
      workspaceRoot: '/root',
      readFile: file.read,
      watchDirectory: noDirectoryWatch(),
    },
  )
  assert.throws(() => bareLayer.mutate([]), /does not support mutate/)
  bareLayer.dispose()
})

test('layerSnapshot reports the layer error and fails closed to global sources', async () => {
  const scope = new FakeGlobalScope({ mcpServers: { demo: stdioConfig() } })
  const file = fakeConfigFile('{invalid')
  const warnings = []
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: noDirectoryWatch(),
    warn: (message) => warnings.push(message),
  })

  await layer.refreshLayers()

  const snapshot = layer.layerSnapshot()
  assert.deepEqual(snapshot.source, { demo: 'global' })
  assert.match(snapshot.error, /not valid JSON/)
  assert.deepEqual(layer.get().mcpServers, { demo: stdioConfig() })
  assert.equal(warnings.length, 1)

  await layer.refreshLayers()
  assert.equal(warnings.length, 1)
  layer.dispose()
})

test('installWorkspaceLayer registers the layer on the context fiber', () => {
  const effects = []
  const warnings = []
  const ctx = {
    effect(setup, name) {
      effects.push({ name, dispose: setup() })
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  const scope = new FakeGlobalScope({ mcpServers: {} })
  const layer = installWorkspaceLayer(ctx, scope, {
    workspaceRoot: '/root',
    readFile: async () => {
      throw missingFileError()
    },
    watchDirectory: noDirectoryWatch(),
  })
  assert.equal(typeof layer.layerSnapshot, 'function')
  assert.equal(effects.length, 1)
  assert.match(effects[0].name, /workspace/)
  effects[0].dispose()
})

test('a .dsh directory created after startup upgrades the watch from the workspace root', async () => {
  const scope = new FakeGlobalScope({ mcpServers: {} })
  const file = fakeConfigFile(missingFileError())
  const state = { calls: 0, rootStops: 0, dshDirectories: [] }
  let rootListener
  let dshListener
  const watch = (directory, onChange) => {
    state.calls += 1
    if (state.calls === 1) throw new Error('ENOENT: .dsh does not exist yet')
    if (String(directory).endsWith('.dsh')) {
      state.dshDirectories.push(directory)
      dshListener = onChange
      return () => {}
    }
    rootListener = onChange
    return () => {
      state.rootStops += 1
    }
  }
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: watch,
  })
  await layer.refreshLayers()
  assert.equal(state.calls, 2, 'the root fallback watch is armed when .dsh is absent')

  file.state.body = JSON.stringify({ mcpServers: { late: stdioConfig({ command: 'late' }) } })
  await rootListener('change', '.dsh')
  await layer.refreshLayers()
  assert.equal(layer.get().mcpServers.late.command, 'late')
  assert.equal(state.rootStops, 1, 'the root fallback watch is closed after the upgrade')
  assert.equal(state.dshDirectories.length, 1, 'the .dsh watch is armed')

  layer.dispose()
})

test('layerSnapshot reports sanitized workspace Servers without secret fields', async () => {
  const scope = new FakeGlobalScope({ mcpServers: {} })
  const file = fakeConfigFile(JSON.stringify({
    mcpServers: {
      demo: {
        url: 'https://mcp.example.test/api',
        headers: { Authorization: 'Bearer secret-value' },
      },
    },
  }))
  const layer = createLayeredScope(scope, {
    workspaceRoot: '/root',
    readFile: file.read,
    watchDirectory: noDirectoryWatch(),
  })
  await layer.refreshLayers()

  const snapshot = layer.layerSnapshot()
  assert.equal(snapshot.source.demo, 'workspace')
  assert.equal(snapshot.servers.demo.url, 'https://mcp.example.test/api')
  assert.equal(snapshot.servers.demo.env, undefined)
  assert.equal(snapshot.servers.demo.headers, undefined)
  assert.equal(JSON.stringify(snapshot).includes('secret-value'), false)

  layer.dispose()
})
