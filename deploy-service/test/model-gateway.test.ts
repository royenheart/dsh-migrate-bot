import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelGateway } from '../src/model-gateway.ts'

/** A stand-in for the provider: it records the authorization it received and answers a fixed body. */
async function upstream(): Promise<{ url: string; auth: string[]; paths: string[]; close: () => Promise<void> }> {
  const auth: string[] = []
  const paths: string[] = []
  const server = createServer((req, res) => {
    auth.push(String(req.headers['x-api-key'] ?? ''))
    paths.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n')
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${String(port)}`,
    auth,
    paths,
    close: async () => await new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

test('the gateway replaces a preview grant with the provider key and enforces its limits', async () => {
  const provider = await upstream()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-'))
  const gateway = new ModelGateway({
    upstream: `${provider.url}/anthropic`,
    apiKey: 'provider-key',
    models: ['deepseek-v4-flash'],
    maxRequests: 2,
    maxBodyBytes: 20 * 1024 * 1024,
    maxConcurrency: 2,
    globalConcurrency: 20,
    timeoutMs: 600000,
    log: () => {},
  })
  try {
    await gateway.start(dir)
    const grant = gateway.issue('preview-one')
    const url = `http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`
    const call = (authorization: string, model = 'deepseek-v4-flash'): Promise<Response> => fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
    })
    const first = await call(grant.token)
    assert.equal(first.status, 200)
    assert.equal(provider.auth[0], 'provider-key')
    assert.equal(provider.paths[0], '/anthropic/v1/messages')
    assert.equal(first.headers.get('content-type'), 'text/event-stream')
    assert.equal((await call('wrong-token')).status, 401)
    assert.equal((await call(grant.token, 'other-model')).status, 400)
    assert.equal((await call(grant.token)).status, 200)
    assert.equal((await call(grant.token)).status, 400)
    gateway.revoke('preview-one')
    assert.equal((await call(grant.token)).status, 401)
  } finally {
    await gateway.close()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent requests share one grant budget', async () => {
  const provider = await upstream()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-race-'))
  const gateway = new ModelGateway({ upstream: provider.url, apiKey: 'provider-key', maxRequests: 1, maxConcurrency: 2, globalConcurrency: 20, timeoutMs: 600000,
    maxBodyBytes: 20 * 1024 * 1024, log: () => {} })
  try {
    await gateway.start(dir)
    const grant = gateway.issue('preview-race')
    const one = fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': grant.token, 'content-type': 'application/json' }, body: '{"model":"deepseek-v4-flash"}',
    })
    const two = fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': grant.token, 'content-type': 'application/json' }, body: '{"model":"deepseek-v4-flash"}',
    })
    const statuses = (await Promise.all([one, two])).map(response => response.status).sort()
    assert.deepEqual(statuses, [200, 400])
  } finally {
    await gateway.close()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one grant admits only its configured concurrent requests', async () => {
  const provider = createServer((_req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('ok') }, 100) })
  await new Promise<void>((resolve) => { provider.listen(0, '127.0.0.1', resolve) })
  const address = provider.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-concurrency-'))
  const gateway = new ModelGateway({
    upstream: `http://127.0.0.1:${String(port)}`, apiKey: 'provider-key', maxRequests: 10,
    maxBodyBytes: 20 * 1024 * 1024, maxConcurrency: 1, globalConcurrency: 20, timeoutMs: 600000, log: () => {},
  })
  try {
    await gateway.start(dir)
    const grant = gateway.issue('preview-concurrency')
    const call = (): Promise<Response> => fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': grant.token, 'content-type': 'application/json' }, body: '{"model":"deepseek-v4-flash"}',
    })
    const statuses = (await Promise.all([call(), call()])).map(response => response.status).sort()
    assert.deepEqual(statuses, [200, 429])
  } finally {
    await gateway.close()
    await new Promise<void>((resolve) => { provider.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the gateway rejects a body over its configured limit without calling upstream', async () => {
  let hits = 0
  const provider = createServer((_req, res) => { hits += 1; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end() })
  await new Promise<void>((resolve) => { provider.listen(0, '127.0.0.1', resolve) })
  const address = provider.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-body-'))
  const gateway = new ModelGateway({
    upstream: `http://127.0.0.1:${String(port)}`, apiKey: 'provider-key', maxRequests: 10,
    maxBodyBytes: 16, maxConcurrency: 2, globalConcurrency: 20, timeoutMs: 600000, log: () => {},
  })
  try {
    await gateway.start(dir)
    const grant = gateway.issue('preview-body')
    const response = await fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': grant.token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x'.repeat(100) }] }),
    })
    assert.equal(response.status, 413)
    assert.equal(hits, 0)
  } finally {
    await gateway.close()
    provider.closeAllConnections()
    await new Promise<void>((resolve) => { provider.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the gateway bounds an upstream that never answers', async () => {
  const provider = createServer(() => {})
  await new Promise<void>((resolve) => { provider.listen(0, '127.0.0.1', resolve) })
  const address = provider.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-timeout-'))
  const gateway = new ModelGateway({
    upstream: `http://127.0.0.1:${String(port)}`, apiKey: 'provider-key', maxRequests: 10,
    maxBodyBytes: 20 * 1024 * 1024, maxConcurrency: 2, globalConcurrency: 20, timeoutMs: 150, log: () => {},
  })
  try {
    await gateway.start(dir)
    const grant = gateway.issue('preview-timeout')
    const response = await fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': grant.token, 'content-type': 'application/json' },
      body: '{"model":"deepseek-v4-flash"}',
    })
    assert.equal(response.status, 504)
  } finally {
    await gateway.close()
    provider.closeAllConnections()
    await new Promise<void>((resolve) => { provider.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the global concurrency limit is shared across grants', async () => {
  const provider = createServer((_req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('ok') }, 100) })
  await new Promise<void>((resolve) => { provider.listen(0, '127.0.0.1', resolve) })
  const address = provider.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-gateway-global-'))
  const gateway = new ModelGateway({
    upstream: `http://127.0.0.1:${String(port)}`, apiKey: 'provider-key', maxRequests: 10,
    maxBodyBytes: 20 * 1024 * 1024, maxConcurrency: 2, globalConcurrency: 1, timeoutMs: 600000, log: () => {},
  })
  try {
    await gateway.start(dir)
    const one = gateway.issue('preview-global-one')
    const two = gateway.issue('preview-global-two')
    const call = (token: string): Promise<Response> => fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: '{"model":"deepseek-v4-flash"}',
    })
    const statuses = (await Promise.all([call(one.token), call(two.token)])).map(response => response.status).sort()
    assert.deepEqual(statuses, [200, 429])
  } finally {
    await gateway.close()
    provider.closeAllConnections()
    await new Promise<void>((resolve) => { provider.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
  }
})
