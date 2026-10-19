import assert from 'node:assert/strict'
import test from 'node:test'

import {
  McpSettingsController,
  normalizeServerConfig,
  parseArgs,
  parseMcpImport,
  parseScopes,
  secretKeysFromView,
  secretRowOps,
  serverSource,
} from '../src/client/settings-controller.js'

test('normalizes standard imports and rejects invalid transport shapes', () => {
  assert.deepEqual(
    parseMcpImport(JSON.stringify({
      mcpServers: {
        fixture: { command: 'node', args: ['server.mjs'], env: { TOKEN: 'secret' } },
        remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
      },
    })),
    {
      fixture: {
        command: 'node',
        args: ['server.mjs'],
        env: { TOKEN: 'secret' },
        auth: 'headers',
        scopes: [],
        disabled: false,
        autoAllow: false,
        lifecycle: 'lazy',
        idleTimeoutMinutes: 10,
        promotedTools: [],
      },
      remote: {
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer x' },
        auth: 'headers',
        scopes: [],
        disabled: false,
        autoAllow: false,
        lifecycle: 'lazy',
        idleTimeoutMinutes: 10,
        promotedTools: [],
      },
    },
  )
  assert.deepEqual(parseArgs('["one", "two"]'), ['one', 'two'])
  assert.throws(() => parseMcpImport('{'), /Invalid JSON/)
  assert.throws(
    () => normalizeServerConfig('bad', { command: 'node', url: 'https://example.test' }),
    /exactly one/,
  )
})

test('normalizes auth modes and OAuth scopes for HTTP Servers', () => {
  assert.deepEqual(
    normalizeServerConfig('remote', {
      url: 'https://a.test/api',
      auth: 'oauth',
      scopes: ['read', 'write'],
    }),
    {
      url: 'https://a.test/api',
      headers: {},
      auth: 'oauth',
      scopes: ['read', 'write'],
      disabled: false,
      autoAllow: false,
      lifecycle: 'lazy',
      idleTimeoutMinutes: 10,
      promotedTools: [],
    },
  )
  assert.throws(
    () => normalizeServerConfig('local', { command: 'node', auth: 'oauth' }),
    /OAuth requires the HTTP Transport/,
  )
  assert.throws(
    () => normalizeServerConfig('remote', { url: 'https://a.test/api', scopes: ['read'] }),
    /scopes require OAuth/,
  )
  assert.throws(
    () => normalizeServerConfig('remote', { url: 'https://a.test/api', auth: 'basic' }),
    /auth must be "headers" or "oauth"/,
  )
  assert.deepEqual(parseScopes(' read , write ,, '), ['read', 'write'])
  assert.deepEqual(parseScopes(''), [])
})

test('oauth actions call the RPC endpoints and surface the authorization URL', async () => {
  const rpcCalls = []
  const listeners = new Set()
  let scopeSnapshot = {
    status: 'ready',
    value: {
      mcpServers: {
        remote: { url: 'https://a.test/api', auth: 'oauth' },
      },
    },
    revision: 3,
    writable: true,
  }
  let describeSnapshot = {
    status: 'ready',
    view: { writable: true, hasDocument: true, namespaces: [] },
    error: null,
  }
  const scope = {
    getSnapshot: () => scopeSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const describe = {
    getSnapshot: () => describeSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async ensure() {},
    acceptView() {},
  }
  const controller = new McpSettingsController({
    scope,
    describe,
    settingsApi: {},
    rpc: async (endpoint, payload) => {
      rpcCalls.push([endpoint, payload])
      if (endpoint === 'oauth-login') {
        return { ok: true, value: { authorizationUrl: 'https://auth.example.test/authorize' } }
      }
      if (endpoint === 'oauth-status') {
        return {
          ok: true,
          value: { configured: true, signedIn: true, expiresAt: 1_700_000_000_000, url: 'https://a.test/api' },
        }
      }
      return { ok: true, value: { status: { servers: [] }, catalog: { servers: [] } } }
    },
  })

  const signIn = await controller.signIn('remote')
  assert.deepEqual(signIn, { authorizationUrl: 'https://auth.example.test/authorize' })

  assert.equal(await controller.signOut('remote'), true)

  await controller.loadOauthStatuses()
  assert.deepEqual(controller.getSnapshot().oauthStatuses, {
    remote: { configured: true, signedIn: true, expiresAt: 1_700_000_000_000, url: 'https://a.test/api' },
  })

  const endpoints = rpcCalls.map(([endpoint]) => endpoint)
  assert.deepEqual(endpoints, [
    'oauth-login',
    'oauth-logout',
    'overview',
    'layers',
    'oauth-status',
    'oauth-status',
  ])
  assert.deepEqual(rpcCalls[0][1], { server: 'remote' })
  await controller.dispose()
})

test('secret metadata exposes keys while path operations preserve blank existing values', () => {
  const view = {
    namespaces: [{
      ns: 'mcp',
      secrets: [
        { path: ['mcpServers', 'fixture', 'env', 'API_TOKEN'], set: true },
        { path: ['mcpServers', 'fixture', 'env', 'REMOVED'], set: false },
      ],
    }],
  }
  assert.deepEqual(secretKeysFromView(view, 'fixture', 'env'), ['API_TOKEN'])
  assert.deepEqual(
    secretRowOps(
      'fixture',
      'env',
      [
        { originalKey: 'API_TOKEN', key: 'API_TOKEN', value: '' },
        { key: 'NEW_TOKEN', value: 'new secret' },
      ],
      ['API_TOKEN'],
    ),
    [{
      op: 'set',
      path: ['mcpServers', 'fixture', 'env', 'NEW_TOKEN'],
      value: 'new secret',
    }],
  )
  assert.deepEqual(
    secretRowOps(
      'fixture',
      'env',
      [
        { originalKey: 'A', key: 'B', value: 'new B' },
        { originalKey: 'B', key: 'A', value: 'new A' },
      ],
      ['A', 'B'],
    ).map((op) => `${op.op}:${op.path.at(-1)}`),
    ['unset:A', 'unset:B', 'set:B', 'set:A'],
  )
})

test('serverSource reads the workspace layer snapshot with a global fallback', () => {
  assert.equal(serverSource({ source: { fixture: 'workspace' } }, 'fixture'), 'workspace')
  assert.equal(serverSource({ source: { fixture: 'global' } }, 'fixture'), 'global')
  assert.equal(serverSource({ source: {} }, 'fixture'), 'global')
  assert.equal(serverSource(undefined, 'fixture'), 'global')
})

test('controller loads the workspace layer snapshot through the Connection RPC', async () => {
  const endpoints = []
  const listeners = new Set()
  let scopeSnapshot = {
    status: 'ready',
    value: { mcpServers: { fixture: { command: 'node', args: [] } } },
    base: undefined,
    user: {},
    revision: 3,
    writable: true,
    mode: 'host',
  }
  let describeSnapshot = {
    status: 'ready',
    view: { writable: true, hasDocument: true, namespaces: [] },
    error: null,
  }
  const scope = {
    getSnapshot: () => scopeSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const describe = {
    getSnapshot: () => describeSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async ensure() {},
    acceptView() {},
  }
  const settingsApi = {
    async mutate(payload) {
      return {
        result: {
          ok: true,
          value: {
            ns: 'mcp',
            schema: {},
            value: {},
            applies: 'live',
            secrets: [],
            revision: payload.expectedRevision + 1,
          },
        },
      }
    },
  }
  const controller = new McpSettingsController({
    scope,
    describe,
    settingsApi,
    rpc: async (endpoint) => {
      endpoints.push(endpoint)
      if (endpoint === 'layers') {
        return { ok: true, value: { source: { fixture: 'workspace' }, error: undefined } }
      }
      return { ok: true, value: { status: { servers: [] }, catalog: { servers: [] } } }
    },
  })

  const unmount = controller.mount()
  await controller.loadLayers()
  assert.ok(endpoints.includes('layers'))
  assert.deepEqual(controller.getSnapshot().layers, {
    source: { fixture: 'workspace' },
    error: undefined,
  })

  await controller.deleteServer('fixture')
  assert.ok(endpoints.filter((endpoint) => endpoint === 'layers').length >= 2)
  assert.deepEqual(controller.getSnapshot().layers, {
    source: { fixture: 'workspace' },
    error: undefined,
  })

  unmount()
  await controller.dispose()
})

test('controller writes through the current namespace revision and folds the answer', async () => {
  const listeners = new Set()
  let scopeSnapshot = {
    status: 'ready',
    value: { mcpServers: {} },
    base: undefined,
    user: {},
    revision: 7,
    writable: true,
    mode: 'host',
  }
  let describeSnapshot = {
    status: 'ready',
    view: { writable: true, hasDocument: true, namespaces: [] },
    error: null,
  }
  const writes = []
  const scope = {
    getSnapshot: () => scopeSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const describe = {
    getSnapshot: () => describeSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async ensure() {},
    acceptView(view) {
      scopeSnapshot = {
        ...scopeSnapshot,
        value: view.value,
        revision: view.revision,
      }
      describeSnapshot = {
        ...describeSnapshot,
        view: { ...describeSnapshot.view, namespaces: [view] },
      }
      for (const listener of listeners) listener()
    },
  }
  const settingsApi = {
    async update(payload) {
      writes.push(['update', payload])
      return {
        result: {
          ok: true,
          value: {
            ns: 'mcp',
            schema: {},
            value: payload.patch,
            applies: 'live',
            secrets: [],
            revision: payload.expectedRevision + 1,
          },
        },
      }
    },
  }
  const controller = new McpSettingsController({
    scope,
    describe,
    settingsApi,
    rpc: async () => ({
      ok: true,
      value: { status: { servers: [] }, catalog: { servers: [] } },
    }),
  })

  assert.equal(
    await controller.addServer('fixture', { command: 'node', args: ['server.mjs'] }),
    true,
  )
  assert.equal(writes[0][0], 'update')
  assert.equal(writes[0][1].expectedRevision, 7)
  assert.equal(writes[0][1].patch.mcpServers.fixture.command, 'node')
  assert.equal(controller.getSnapshot().settings.revision, 8)
  assert.equal(
    await controller.importJson(JSON.stringify({
      mcpServers: { remote: { url: 'https://example.test/mcp' } },
    })),
    true,
  )
  assert.equal(writes[1][0], 'update')
  assert.equal(writes[1][1].expectedRevision, 8)
  assert.equal(writes[1][1].patch.mcpServers.remote.url, 'https://example.test/mcp')
  await controller.dispose()
})

test('the write path carries a top-level skillInstall mutation through untouched', async () => {
  const mutations = []
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { mcpServers: {}, skillInstall: 'file' },
      revision: 2,
      writable: true,
    }),
    subscribe() {
      return () => {}
    },
  }
  const describe = {
    getSnapshot: () => ({ status: 'ready', view: {}, error: null }),
    subscribe() {
      return () => {}
    },
    async ensure() {},
    acceptView() {},
  }
  const controller = new McpSettingsController({
    scope,
    describe,
    settingsApi: {
      async mutate(payload) {
        mutations.push(payload)
        return {
          result: {
            ok: true,
            value: {
              ns: 'mcp',
              schema: {},
              value: { mcpServers: {}, skillInstall: 'runtime' },
              applies: 'live',
              secrets: [],
              revision: payload.expectedRevision + 1,
            },
          },
        }
      },
    },
    rpc: async () => ({ ok: true, value: { status: { servers: [] }, catalog: { servers: [] } } }),
  })

  await controller.settingsWrite('mutate', {
    ops: [{ op: 'set', path: ['skillInstall'], value: 'runtime' }],
  })
  assert.deepEqual(mutations[0].ops, [
    { op: 'set', path: ['skillInstall'], value: 'runtime' },
  ])
  await controller.dispose()
})

test('loadOauthStatuses probes OAuth Servers defined only in the workspace layer', async () => {
  const rpcCalls = []
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { mcpServers: { local: { command: 'node', auth: 'headers' } } },
      revision: 1,
      writable: true,
    }),
    subscribe() {
      return () => {}
    },
  }
  const describe = {
    getSnapshot: () => ({ status: 'ready', view: {}, error: null }),
    subscribe() {
      return () => {}
    },
    async ensure() {},
    acceptView() {},
  }
  const controller = new McpSettingsController({
    scope,
    describe,
    settingsApi: {},
    rpc: async (endpoint, payload) => {
      rpcCalls.push([endpoint, payload])
      if (endpoint === 'oauth-status') {
        return { ok: true, value: { configured: true, signedIn: false, url: 'https://w.test/api' } }
      }
      return { ok: true, value: { status: { servers: [] }, catalog: { servers: [] } } }
    },
  })
  controller.layers = {
    source: { workspaceOnly: 'workspace' },
    error: undefined,
    servers: {
      workspaceOnly: { url: 'https://w.test/api', auth: 'oauth' },
      local: { command: 'node', auth: 'headers' },
    },
  }

  await controller.loadOauthStatuses()
  assert.deepEqual(controller.getSnapshot().oauthStatuses, {
    workspaceOnly: { configured: true, signedIn: false, url: 'https://w.test/api' },
  })
  const statusCalls = rpcCalls.filter(([endpoint]) => endpoint === 'oauth-status')
  assert.deepEqual(statusCalls, [['oauth-status', { server: 'workspaceOnly' }]])
  await controller.dispose()
})
