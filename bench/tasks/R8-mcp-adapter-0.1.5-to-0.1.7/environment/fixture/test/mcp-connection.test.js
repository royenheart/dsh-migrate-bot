import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpConnection } from '../src/host/mcp-connection.js'

function createFakeSdk({ failStreamable = false, failSse = false } = {}) {
  const clients = []
  const transports = []

  class FakeClient {
    constructor(_identity, options) {
      this.options = options
      clients.push(this)
    }

    async connect(transport, options) {
      this.transport = transport
      this.connectOptions = options
      if (transport.kind === 'streamable-http' && failStreamable) {
        throw new Error('streamable rejected')
      }
      if (transport.kind === 'sse' && failSse) throw new Error('sse rejected')
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

test('HTTP connection sends configured headers over streamable HTTP', async () => {
  const fake = createFakeSdk()
  const connection = await createMcpConnection(
    'remote',
    {
      url: 'https://mcp.example.test/api',
      headers: { Authorization: 'Bearer token', 'X-Tenant': 'test' },
    },
    {},
    undefined,
    fake.sdk,
  )

  assert.equal(connection.transportType, 'streamable-http')
  assert.deepEqual(fake.transports[0].options.requestInit.headers, {
    Authorization: 'Bearer token',
    'X-Tenant': 'test',
  })
  assert.equal(fake.clients.length, 1)
  await connection.close()
})

test('HTTP connection retries with a fresh SSE Client after streamable failure', async () => {
  const fake = createFakeSdk({ failStreamable: true })
  const connection = await createMcpConnection(
    'legacy',
    { url: 'http://localhost:3030/sse', headers: { Authorization: 'Bearer old' } },
    {},
    undefined,
    fake.sdk,
  )

  assert.equal(connection.transportType, 'sse')
  assert.deepEqual(
    fake.transports.map((transport) => transport.kind),
    ['streamable-http', 'sse'],
  )
  assert.equal(fake.clients.length, 2)
  assert.equal(fake.clients[0].closed, true)
  assert.deepEqual(fake.transports[1].options.requestInit.headers, {
    Authorization: 'Bearer old',
  })
  await connection.close()
})

test('HTTP connection reports both transport failures', async () => {
  const fake = createFakeSdk({ failStreamable: true, failSse: true })

  await assert.rejects(
    createMcpConnection(
      'broken',
      { url: 'https://broken.example.test/mcp', headers: {} },
      {},
      undefined,
      fake.sdk,
    ),
    /Streamable HTTP: streamable rejected\. SSE: sse rejected\./,
  )
})
