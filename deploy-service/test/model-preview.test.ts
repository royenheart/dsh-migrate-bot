import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelGateway, PREVIEW_MODEL_PORT } from '../src/model-gateway.ts'
import { PreviewManager, previewId } from '../src/previews.ts'
import { FakeProvider } from './support.ts'

test('a preview gets a model grant and a destroy revokes it', async () => {
  const auth: string[] = []
  const upstream = createServer((req, res) => {
    auth.push(String(req.headers['x-api-key'] ?? ''))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"id":"ok"}')
  })
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
  const address = upstream.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-model-preview-'))
  const gateway = new ModelGateway({ upstream: `http://127.0.0.1:${String(port)}`, apiKey: 'real-key', maxRequests: 3, maxConcurrency: 2, globalConcurrency: 20, timeoutMs: 600000,
    maxBodyBytes: 20 * 1024 * 1024, log: () => {} })
  const provider = new FakeProvider()
  const previews = new PreviewManager({ dataDir, publicUrl: 'http://127.0.0.1:1', ttlDays: 7, idleMinutes: 30, provider, providerKind: 'process', modelGateway: gateway, log: () => {} })
  try {
    await gateway.start(join(dataDir, 'model'))
    await previews.load()
    const key = { repository: 'acme/plugin', pullRequest: 1 }
    await previews.seed(key)
    await previews.ensureRunning(previewId(key))
    const model = provider.models[0]
    assert.ok(model !== undefined)
    assert.notEqual(model.token, 'real-key')
    assert.equal(model?.baseUrl, `http://127.0.0.1:${String(gateway.tcpPort)}`)
    const call = await fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': model.token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
    })
    assert.equal(call.status, 200)
    assert.equal(auth[0], 'real-key')
    await previews.sweep(Date.now() + 31 * 60_000)
    assert.equal(previews.status(key).status, 200)
    const afterIdleStop = await fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': model.token, 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(afterIdleStop.status, 401)
    await previews.destroy(key)
    const after = await fetch(`http://127.0.0.1:${String(gateway.tcpPort)}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': model.token, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(after.status, 401)
  } finally {
    await gateway.close()
    provider.close()
    await new Promise<void>((resolve) => { upstream.close(() => resolve()) })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a docker preview gets the forwarder relay base URL', async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"ok"}') })
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
  const address = upstream.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-model-preview-docker-'))
  const gateway = new ModelGateway({
    upstream: `http://127.0.0.1:${String(port)}`, apiKey: 'real-key', maxRequests: 3,
    maxConcurrency: 2, globalConcurrency: 20, timeoutMs: 600000, maxBodyBytes: 20 * 1024 * 1024, log: () => {},
  })
  const provider = new FakeProvider()
  const previews = new PreviewManager({ dataDir, publicUrl: 'http://127.0.0.1:1', ttlDays: 7, idleMinutes: 30, provider, providerKind: 'docker', modelGateway: gateway, log: () => {} })
  try {
    await gateway.start(join(dataDir, 'model'))
    await previews.load()
    const key = { repository: 'acme/plugin', pullRequest: 2 }
    await previews.seed(key)
    await previews.ensureRunning(previewId(key))
    const model = provider.models[0]
    assert.ok(model !== undefined)
    assert.equal(model.baseUrl, `http://127.0.0.1:${String(PREVIEW_MODEL_PORT)}`)
    assert.notEqual(model.token, 'real-key')
  } finally {
    await gateway.close()
    provider.close()
    await new Promise<void>((resolve) => { upstream.close(() => resolve()) })
    rmSync(dataDir, { recursive: true, force: true })
  }
})
