import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpConnection } from '../src/host/mcp-connection.js'

function createFakeSdk({ failStreamable = false } = {}) {
  const clients = []
  const transports = []

  class FakeClient {
    constructor(_identity, options) {
      this.options = options
      clients.push(this)
    }

    async connect(transport) {
      this.transport = transport
      if (transport.kind === 'streamable-http' && failStreamable) {
        throw new Error('streamable rejected')
      }
    }

    async close() {
      this.closed = true
    }
  }

  class FakeTransport {
    constructor(kind, url, options) {
      this.kind = kind
      this.url = url
      this.options = options
      transports.push(this)
    }
  }

  return {
    clients,
    transports,
    sdk: {
      Client: FakeClient,
      StreamableHTTPClientTransport: class extends FakeTransport {
        constructor(url, options) {
          super('streamable-http', url, options)
        }
      },
      SSEClientTransport: class extends FakeTransport {
        constructor(url, options) {
          super('sse', url, options)
        }
      },
      StdioClientTransport: class extends FakeTransport {},
      getDefaultEnvironment: () => ({ PATH: '/test/bin' }),
    },
  }
}

function createStore() {
  const records = new Map()
  return {
    records,
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

const SERVER_URL = 'https://mcp.example.test/api'

function signedInRecord(overrides = {}) {
  return {
    url: SERVER_URL,
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3_600_000,
    scope: 'read',
    clientInformation: { client_id: 'client-1' },
    ...overrides,
  }
}

test('authProvider is passed to both HTTP transports for OAuth Servers', async () => {
  const fake = createFakeSdk({ failStreamable: true })
  const store = createStore()
  await store.set('remote', signedInRecord())
  const onAuthorizationRequired = []

  const connection = await createMcpConnection(
    'remote',
    { url: SERVER_URL, headers: {}, auth: 'oauth', scopes: ['read'] },
    {},
    undefined,
    fake.sdk,
    { store, onAuthorizationRequired: (url) => onAuthorizationRequired.push(url) },
  )

  assert.deepEqual(
    fake.transports.map((transport) => transport.kind),
    ['streamable-http', 'sse'],
  )
  const providers = fake.transports.map((transport) => transport.options.authProvider)
  assert.equal(typeof providers[0].tokens, 'function')
  assert.equal(providers[0], providers[1], 'both transports share one provider')
  assert.deepEqual(await providers[0].tokens(), {
    access_token: 'at-1',
    token_type: 'Bearer',
    refresh_token: 'rt-1',
    expires_in: 3600,
    scope: 'read',
  })
  assert.equal(onAuthorizationRequired.length, 0)
  await connection.close()
})

test('OAuth Servers fail fast when the store has no signed-in tokens', async () => {
  const fake = createFakeSdk()

  await assert.rejects(
    createMcpConnection(
      'remote',
      { url: SERVER_URL, headers: {}, auth: 'oauth', scopes: [] },
      {},
      undefined,
      fake.sdk,
      { store: createStore(), onAuthorizationRequired: () => undefined },
    ),
    (error) => {
      assert.match(error.message, /^OAuth authorization required for remote — /)
      assert.match(error.message, /sign in via Settings > MCP or \/mcp-auth$/)
      return true
    },
  )
  assert.equal(fake.transports.length, 0, 'no transport is created without tokens')
})

test('OAuth Servers fail fast when no OAuth wiring reaches the connection', async () => {
  const fake = createFakeSdk()

  await assert.rejects(
    createMcpConnection(
      'remote',
      { url: SERVER_URL, headers: {}, auth: 'oauth', scopes: [] },
      {},
      undefined,
      fake.sdk,
    ),
    /OAuth authorization required for remote/,
  )
})

test('OAuth Servers fail fast when stored tokens bind a different URL', async () => {
  const fake = createFakeSdk()
  const store = createStore()
  await store.set('remote', signedInRecord({ url: 'https://other.example.test/api' }))

  await assert.rejects(
    createMcpConnection(
      'remote',
      { url: SERVER_URL, headers: {}, auth: 'oauth', scopes: [] },
      {},
      undefined,
      fake.sdk,
      { store, onAuthorizationRequired: () => undefined },
    ),
    /OAuth authorization required for remote/,
  )
  assert.equal(fake.transports.length, 0)
})

test('the header/bearer path creates transports without an authProvider', async () => {
  const fake = createFakeSdk()
  const store = createStore()
  await store.set('remote', signedInRecord())

  const connection = await createMcpConnection(
    'remote',
    { url: SERVER_URL, headers: { Authorization: 'Bearer old' }, auth: 'headers', scopes: [] },
    {},
    undefined,
    fake.sdk,
    { store, onAuthorizationRequired: () => undefined },
  )

  assert.equal(connection.transportType, 'streamable-http')
  assert.deepEqual(fake.transports[0].options, {
    requestInit: { headers: { Authorization: 'Bearer old' } },
  })
  assert.equal(fake.transports[0].options.authProvider, undefined)
  await connection.close()
})
