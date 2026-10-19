import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_RPC_CHANNEL } from '../src/host/manager.js'
import { installMcpManagerRpc } from '../src/host/manager.js'
import { installMcpOauth } from '../src/host/oauth-service.js'

function memoryStore(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    async get(serverName) {
      return records.get(serverName)
    },
    async set(serverName, record) {
      records.set(serverName, record)
      return record
    },
    async delete(serverName) {
      return records.delete(serverName)
    },
    async has(serverName) {
      return records.has(serverName)
    },
  }
}

class Scope {
  constructor(servers) {
    this.servers = servers
  }

  get() {
    return structuredClone({ mcpServers: this.servers })
  }
}

function createRpcHarness({ oauth }) {
  let registration
  const ctx = {
    connection: {
      rpc: {
        handle(channel, handler, options) {
          registration = { channel, handler, options }
        },
      },
    },
  }
  const manager = {
    statusSnapshot: () => ({ servers: [] }),
    catalogSnapshot: () => ({ servers: [] }),
    disconnects: [],
    async disconnect(name, reason) {
      this.disconnects.push([name, reason])
    },
    async listTools() {
      return { tools: [] }
    },
  }
  installMcpManagerRpc(ctx, manager, oauth === undefined ? {} : { oauth })
  return { handler: registration.handler, manager, channel: registration.channel }
}

function controllerHarness({ servers, store }) {
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    effect() {},
  }
  const manager = {
    disconnects: [],
    async disconnect(name, reason) {
      this.disconnects.push([name, reason])
    },
  }
  const oauth = installMcpOauth(ctx, manager, new Scope(servers), { store })
  return { oauth, manager, warnings }
}

test('rpc channel and option wiring stay unchanged without oauth', async () => {
  const { handler, channel } = createRpcHarness({ oauth: undefined })
  assert.equal(channel, MCP_RPC_CHANNEL)
  assert.equal((await handler('status')).ok, true)
  const missingOauth = await handler('oauth-status', { server: 'remote' })
  assert.equal(missingOauth.ok, false)
  assert.equal(missingOauth.error.code, 'internal')
  assert.deepEqual(missingOauth.error.details, {})
})

test('oauth endpoints reject bad payloads with the bad-request shape', async () => {
  const { handler } = createRpcHarness({ oauth: {} })
  for (const payload of [undefined, {}, { server: '' }, { server: 5 }]) {
    const result = await handler('oauth-status', payload)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad-request')
    assert.match(result.error.message, /non-empty Server name/)
    assert.deepEqual(result.error.details, { issues: [] })
  }
})

test('oauth-status reports configured, signedIn, and expiresAt without token material', async () => {
  const store = memoryStore()
  const { oauth } = controllerHarness({
    servers: { remote: { url: 'https://a.test/api', auth: 'oauth', disabled: false } },
    store,
  })
  const { handler } = createRpcHarness({ oauth })

  const signedOut = await handler('oauth-status', { server: 'remote' })
  assert.deepEqual(signedOut, {
    ok: true,
    value: { configured: true, signedIn: false, url: 'https://a.test/api' },
  })

  await store.set('remote', {
    url: 'https://a.test/api',
    accessToken: 'at-1',
    expiresAt: 1_700_000_000_000,
    refreshToken: 'rt-1',
  })
  const signedIn = await handler('oauth-status', { server: 'remote' })
  assert.deepEqual(signedIn.value, {
    configured: true,
    signedIn: true,
    expiresAt: 1_700_000_000_000,
    url: 'https://a.test/api',
  })
  assert.equal(JSON.stringify(signedIn).includes('rt-1'), false)
  assert.equal(JSON.stringify(signedIn).includes('at-1'), false)
})

test('oauth-logout deletes tokens and disconnects with the oauth logout reason', async () => {
  const store = memoryStore({
    remote: { url: 'https://a.test/api', accessToken: 'at-1' },
  })
  const { oauth, manager } = controllerHarness({
    servers: { remote: { url: 'https://a.test/api', auth: 'oauth', disabled: false } },
    store,
  })
  const { handler } = createRpcHarness({ oauth })

  const result = await handler('oauth-logout', { server: 'remote' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    configured: true,
    signedIn: false,
    url: 'https://a.test/api',
  })
  assert.equal(await store.get('remote'), undefined)
  assert.deepEqual(manager.disconnects, [['remote', 'oauth logout']])
})

test('oauth failures settle as platform-legal internal error envelopes', async () => {
  const { oauth } = controllerHarness({
    servers: {
      remote: { url: 'https://a.test/api', auth: 'oauth', disabled: false },
      local: { command: 'node', auth: 'headers', disabled: false },
    },
    store: memoryStore(),
  })
  const { handler } = createRpcHarness({ oauth })

  const unknownServer = await handler('oauth-login', { server: 'ghost' })
  assert.equal(unknownServer.ok, false)
  assert.equal(unknownServer.error.code, 'internal')
  assert.match(unknownServer.error.message, /Unknown MCP server "ghost"/)
  assert.deepEqual(unknownServer.error.details, {})

  const notOauth = await handler('oauth-login', { server: 'local' })
  assert.equal(notOauth.ok, false)
  assert.equal(notOauth.error.code, 'internal')
  assert.match(notOauth.error.message, /does not use OAuth authentication/)
  assert.deepEqual(notOauth.error.details, {})

  // status stays lenient for Servers that are not configured for OAuth.
  const unconfigured = await handler('oauth-status', { server: 'local' })
  assert.deepEqual(unconfigured, {
    ok: true,
    value: { configured: false, signedIn: false },
  })
})

test('oauth-login hands the authorization URL to the Client response', async () => {
  const calls = []
  const oauth = {
    async startLogin(serverName) {
      calls.push(['startLogin', serverName])
      return { authorizationUrl: 'https://auth.example.test/authorize?state=abc' }
    },
    async logout() {
      throw new Error('not used')
    },
    async status() {
      return { configured: true, signedIn: false, url: 'https://a.test/api' }
    },
  }
  const { handler } = createRpcHarness({ oauth })

  const result = await handler('oauth-login', { server: ' remote ' })
  assert.deepEqual(calls, [['startLogin', 'remote']], 'the Server name is trimmed')
  assert.deepEqual(result, {
    ok: true,
    value: { authorizationUrl: 'https://auth.example.test/authorize?state=abc' },
  })
})

test('oauth-logout refuses a Server that does not use OAuth and deletes nothing', async () => {
  const store = memoryStore({
    remote: { url: 'https://a.test/api', accessToken: 'at-1' },
  })
  const { oauth, manager } = controllerHarness({
    servers: { remote: { command: 'node', auth: 'headers', disabled: false } },
    store,
  })
  const { handler } = createRpcHarness({ oauth })

  const result = await handler('oauth-logout', { server: 'remote' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /does not use OAuth authentication/)
  assert.deepEqual(result.error.details, {})
  assert.deepEqual(await store.get('remote'), { url: 'https://a.test/api', accessToken: 'at-1' })
  assert.deepEqual(manager.disconnects, [])
})
