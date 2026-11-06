import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appRootFrom } from '../../src/paths.ts'

/**
 * A real dsh model request through the preview forwarder to the trusted gateway.
 *
 * The upstream is a local Messages SSE server; no provider key leaves the test.
 * Skipped when @deepseek-ai/dsh cannot be installed, as the other deploy-service
 * e2e does.
 */

const ROOT = appRootFrom(import.meta.url)
const GATEWAY = join(ROOT, 'deploy-service', 'dist', 'src', 'model-gateway.js')
const LAUNCHER = join(ROOT, 'deploy-service', 'preview-image', 'launcher.mjs')
const REQUIRED = process.env.DEPLOY_SERVICE_E2E === 'required'

function pinnedDsh(): string {
  const dockerfile = readFileSync(join(ROOT, 'deploy-service', 'preview-image', 'Dockerfile'), 'utf8')
  const version = /ARG DSH_VERSION=([^\s]+)/.exec(dockerfile)?.[1]
  if (version === undefined) throw new Error('preview-image/Dockerfile pins no DSH_VERSION')
  return version
}

async function freePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

async function waitPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = tcpConnect(port, '127.0.0.1', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => { resolve(false) })
    })
    if (connected) return
    if (Date.now() > deadline) throw new Error(`port ${String(port)} did not open`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

test('a real dsh headless turn reaches the model gateway through the preview forwarder', { timeout: 300_000 }, async (t) => {
  if (process.env.DEPLOY_SERVICE_REAL_DSH === '0') return t.skip('DEPLOY_SERVICE_REAL_DSH=0 disables the real dsh model E2E')
  if (!existsSync(GATEWAY)) {
    if (REQUIRED) assert.fail('the deploy service is not built; run `npm run deploy-service:build` first')
    return t.skip('the deploy service is not built; run `npm run deploy-service:build` first')
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-model-e2e-'))
  const children: ChildProcess[] = []
  let upstream: Server | undefined
  try {
    const prefix = join(scratch, 'dsh')
    const installed = spawnSync('npm', ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', `@deepseek-ai/dsh@${pinnedDsh()}`], {
      encoding: 'utf8',
      timeout: 240_000,
      env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'npm-cache'), npm_config_logs_dir: process.env.npm_config_logs_dir ?? join(tmpdir(), 'npm-logs') },
    })
    if (installed.status !== 0) {
      if (REQUIRED) assert.fail(`@deepseek-ai/dsh@${pinnedDsh()} could not be installed: ${installed.stderr ?? ''}`)
      return t.skip('@deepseek-ai/dsh could not be installed (no network)')
    }

    const seen: { path: string; key: string; version: string }[] = []
    upstream = createServer((req, res) => {
      seen.push({ path: req.url ?? '', key: String(req.headers['x-api-key'] ?? ''), version: String(req.headers['anthropic-version'] ?? '') })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_e2e","type":"message","role":"assistant","content":[],"model":"deepseek-flash","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"gateway-ok"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'))
    })
    await new Promise<void>((resolve) => { upstream?.listen(0, '127.0.0.1', () => { resolve() }) })
    const upstreamAddress = upstream.address()
    const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress !== null ? upstreamAddress.port : 0

    const state = join(scratch, 'state')
    const sockets = join(scratch, 'sockets')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'ready.json'), JSON.stringify({ plugin: { port: 1 }, safe: { port: 2 } }))
    const gatewayData = join(scratch, 'gateway')
    const relayPort = await freePort()
    const gatewayScript = `
      import { ModelGateway } from ${JSON.stringify(pathToFileURL(GATEWAY).href)}
      const gateway = new ModelGateway({ upstream: process.env.UPSTREAM, apiKey: 'provider-key', maxRequests: 10, maxBodyBytes: 20 * 1024 * 1024, maxConcurrency: 2, globalConcurrency: 20, timeoutMs: 600000, log: () => {} })
      await gateway.start(process.env.GATEWAY_DATA)
      const grant = gateway.issue('real-dsh')
      process.stdout.write(JSON.stringify({ port: gateway.tcpPort, unix: gateway.unixSocket, token: grant.token }) + '\\n')
      process.on('SIGTERM', async () => { await gateway.close(); process.exit(0) })
      process.on('SIGINT', async () => { await gateway.close(); process.exit(0) })
    `
    const gateway = spawn(process.execPath, ['--input-type=module', '-e', gatewayScript], {
      env: { ...process.env, UPSTREAM: `http://127.0.0.1:${String(upstreamPort)}/anthropic`, GATEWAY_DATA: gatewayData },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(gateway)
    let gatewayOutput = ''
    gateway.stdout.on('data', (chunk: Buffer) => { gatewayOutput += chunk.toString() })
    gateway.stderr.on('data', (chunk: Buffer) => { gatewayOutput += chunk.toString() })
    const endpoint = await new Promise<{ port: number; unix: string; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`gateway did not start: ${gatewayOutput}`)) }, 15_000)
      const read = (): void => {
        const line = gatewayOutput.split('\n').find(line => line.startsWith('{'))
        if (line === undefined) return
        clearTimeout(timer)
        resolve(JSON.parse(line) as { port: number; unix: string; token: string })
      }
      gateway.stdout.on('data', read)
      gateway.on('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway exited ${String(code)}: ${gatewayOutput}`)) })
    })

    const forward = spawn(process.execPath, [LAUNCHER, 'forward'], {
      env: { ...process.env, STATE_DIR: state, SOCKET_DIR: sockets, MODEL_SOCKET: endpoint.unix, MODEL_PORT: String(relayPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(forward)
    let forwardLog = ''
    forward.stderr.on('data', (chunk: Buffer) => { forwardLog += chunk.toString() })
    await waitPort(relayPort)

    const dshHome = join(scratch, 'dsh-home')
    const dsh = spawn(join(prefix, 'bin', 'dsh'), ['--profile', 'headless', 'reply with the word gateway-ok'], {
      cwd: scratch,
      env: {
        ...process.env,
        HOME: dshHome,
        DSH_HOME: dshHome,
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(relayPort)}`,
        DEEPSEEK_API_KEY: endpoint.token,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(dsh)
    let output = ''
    dsh.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    dsh.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const status = await new Promise<number | null>((resolve) => { dsh.on('close', resolve) })
    assert.equal(status, 0, `dsh failed: ${output}\nforward: ${forwardLog}\ngateway: ${gatewayOutput}\nupstream: ${JSON.stringify(seen)}`)
    assert.match(output, /gateway-ok/)
    assert.ok(seen.length >= 1)
    for (const request of seen) {
      assert.equal(request.path, '/anthropic/v1/messages')
      assert.equal(request.key, 'provider-key')
      assert.equal(request.version, '2023-06-01')
    }
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    await new Promise<void>((resolve) => { if (upstream === undefined) resolve(); else upstream.close(() => { resolve() }) })
    rmSync(scratch, { recursive: true, force: true })
  }
})
