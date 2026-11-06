import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelGateway } from '../src/model-gateway.ts'
import { LAUNCHER } from '../src/providers/common.ts'

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  return port
}

test('the preview forwarder exposes a loopback relay to the gateway', async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"relay-ok"}') })
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
  const upstreamAddress = upstream.address()
  const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress !== null ? upstreamAddress.port : 0
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-relay-'))
  const gateway = new ModelGateway({ upstream: `http://127.0.0.1:${String(upstreamPort)}`, apiKey: 'real-key', maxRequests: 2, maxConcurrency: 2, globalConcurrency: 20, timeoutMs: 600000,
    maxBodyBytes: 20 * 1024 * 1024, log: () => {} })
  const state = join(root, 'state')
  const sockets = join(root, 'sockets')
  mkdirSync(state, { recursive: true })
  mkdirSync(sockets, { recursive: true })
  writeFileSync(join(state, 'ready.json'), JSON.stringify({ plugin: { port: 1, token: 'p' }, safe: { port: 2, token: 's' } }))
  const port = await freePort()
  let child: ReturnType<typeof spawn> | undefined
  try {
    await gateway.start(join(root, 'model'))
    child = spawn(process.execPath, [LAUNCHER, 'forward'], {
      env: { ...process.env, STATE_DIR: state, SOCKET_DIR: sockets, MODEL_SOCKET: gateway.unixSocket, MODEL_PORT: String(port) },
      stdio: 'ignore',
    })
    const grant = gateway.issue('relay-preview')
    let response: Response | undefined
    for (let i = 0; i < 40 && response === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      try {
        response = await fetch(`http://127.0.0.1:${String(port)}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': grant.token, 'content-type': 'application/json' },
          body: '{"model":"deepseek-v4-flash","messages":[]}',
        })
      } catch {
        response = undefined
      }
    }
    assert.ok(response !== undefined)
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { id: string }).id, 'relay-ok')
  } finally {
    child?.kill('SIGTERM')
    await gateway.close()
    await new Promise<void>((resolve) => { upstream.close(() => resolve()) })
    rmSync(root, { recursive: true, force: true })
  }
})
