import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

/**
 * The model gateway: the trusted holder of the service-owned provider key.
 *
 * A preview's dsh process sends model requests to a loopback relay. The relay
 * forwards them over a Unix socket, or a loopback TCP port in the process
 * provider, with a per-preview grant. This gateway replaces that grant with the
 * provider key, forwards one fixed DeepSeek Messages-compatible path upstream, and returns
 * the stream. The preview and its plugin never receive the provider key.
 */

/** The loopback port the preview launcher's relay listens on inside its container. */
export const PREVIEW_MODEL_PORT = 8790

export interface ModelGatewayOptions {
  upstream: string
  apiKey: string
  /** Allowed model ids; absent admits every id. */
  models?: readonly string[] | undefined
  maxRequests: number
  maxBodyBytes: number
  maxConcurrency: number
  globalConcurrency: number
  timeoutMs: number
  log: (message: string) => void
}

interface Grant {
  previewId: string
  requests: number
  active: number
}

export interface ModelGrant {
  token: string
  baseUrl: string
}

/**
 * One gateway per service. It listens on a Unix socket for the Docker provider
 * and on a loopback TCP port for the process provider.
 */
export class ModelGateway {
  private readonly grants = new Map<string, Grant>()
  private readonly active = new Map<string, Set<AbortController>>()
  private activeTotal = 0
  private server: Server | undefined
  private socketPath: string | undefined
  private tcpPortValue = 0

  constructor(private readonly options: ModelGatewayOptions) {}

  /** The loopback TCP port the process provider points its dsh at. */
  get tcpPort(): number {
    return this.tcpPortValue
  }

  /** The Unix socket the Docker preview's forwarder mounts. */
  get unixSocket(): string {
    if (this.socketPath === undefined) throw new Error('model gateway is not started')
    return this.socketPath
  }

  /** Start the Unix and loopback listeners. */
  async start(dataDir: string): Promise<void> {
    mkdirSync(dataDir, { recursive: true })
    this.socketPath = join(dataDir, 'model.sock')
    rmSync(this.socketPath, { force: true })
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.maxConnections = 128
    this.server.headersTimeout = 20_000
    this.server.on('error', (error) => this.options.log(`model gateway: unix listener: ${redact(error.message, this.options.apiKey)}`))
    await listen(this.server, this.socketPath)
    chmodSync(this.socketPath, 0o666)
    const tcp = createServer((req, res) => { void this.handle(req, res) })
    tcp.maxConnections = 128
    tcp.headersTimeout = 20_000
    tcp.on('error', (error) => this.options.log(`model gateway: TCP listener: ${redact(error.message, this.options.apiKey)}`))
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject)
      tcp.listen(0, '127.0.0.1', () => { tcp.off('error', reject); resolve() })
    })
    const address = tcp.address()
    this.tcpPortValue = typeof address === 'object' && address !== null ? address.port : 0
    // The Unix and TCP listeners share the request handler; close both at stop.
    this.server.on('close', () => tcp.close())
  }

  /** Issue a new grant for one preview start. */
  issue(previewId: string): ModelGrant {
    const token = randomBytes(32).toString('base64url')
    this.grants.set(token, { previewId, requests: 0, active: 0 })
    this.options.log(`model gateway: issued a grant for preview ${previewId}`)
    return { token, baseUrl: this.baseUrl() }
  }

  /** Revoke every grant of a preview, for a stop, destroy or expiry. */
  revoke(previewId: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.previewId !== previewId) continue
      this.grants.delete(token)
      for (const abort of this.active.get(token) ?? []) abort.abort()
      this.active.delete(token)
      this.options.log(`model gateway: revoked the grant for preview ${previewId}`)
    }
  }

  /** The base URL a preview uses for its DeepSeek Messages-compatible provider. */
  baseUrl(): string {
    return `http://127.0.0.1:${String(PREVIEW_MODEL_PORT)}`
  }

  /** Stop both listeners. */
  async close(): Promise<void> {
    for (const active of this.active.values()) for (const abort of active) abort.abort()
    this.active.clear()
    this.server?.closeAllConnections?.()
    if (this.socketPath !== undefined) rmSync(this.socketPath, { force: true })
    await close(this.server)
    this.server = undefined
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '/'
    if (path !== '/v1/messages' && path !== '/v1/models') {
      return fail(res, 404, 'not_found_error', 'not found')
    }
    const token = tokenOf(req)
    const grant = this.grantOf(req)
    if (token === undefined || grant === undefined) { this.options.log('model gateway: rejected a request without a valid grant'); return fail(res, 401, 'authentication_error', 'missing or invalid model grant') }
    if (grant.requests >= this.options.maxRequests) { this.options.log(`model gateway: request cap reached for preview ${grant.previewId}`); return fail(res, 400, 'invalid_request_error', 'model request limit reached; restart or redeploy the preview') }
    if (grant.active >= this.options.maxConcurrency || this.activeTotal >= this.options.globalConcurrency) { this.options.log(`model gateway: concurrency cap reached for preview ${grant.previewId}`); return fail(res, 429, 'rate_limit_error', 'model concurrency limit reached') }
    grant.requests += 1
    grant.active += 1
    this.activeTotal += 1
    const abort = new AbortController()
    const active = this.active.get(token) ?? new Set<AbortController>()
    active.add(abort)
    this.active.set(token, active)
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs)
    try {
      await this.forward(req, res, grant, token, path, abort)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.log(`model gateway: ${redact(message, this.options.apiKey)}`)
      if (!res.headersSent) send(res, 502, 'model upstream failed')
      else res.destroy()
    } finally {
      clearTimeout(timer)
      active.delete(abort)
      if (active.size === 0) this.active.delete(token)
      grant.active -= 1
      this.activeTotal -= 1
    }
  }

  private grantOf(req: IncomingMessage): Grant | undefined {
    const token = tokenOf(req)
    return token === undefined ? undefined : this.grants.get(token)
  }

  private async forward(req: IncomingMessage, res: ServerResponse, grant: Grant, token: string, path: string, abort: AbortController): Promise<void> {
    const refund = (): void => { if (grant.requests > 0) grant.requests -= 1 }
    const body = await readBody(req, this.options.maxBodyBytes, abort.signal)
    if (body === undefined) {
      refund()
      if (abort.signal.aborted) {
        if (!res.writableEnded) send(res, 504, 'model request aborted or timed out')
        return
      }
      return fail(res, 413, 'invalid_request_error', 'request body too large')
    }
    if (path === '/v1/messages' && body.length > 0) {
      let model: unknown
      try {
        model = (JSON.parse(body.toString('utf8')) as { model?: unknown }).model
      } catch {
        refund()
        return fail(res, 400, 'invalid_request_error', 'request body is not JSON')
      }
      if (this.options.models !== undefined && (typeof model !== 'string' || !this.options.models.includes(model))) {
        refund()
        return fail(res, 400, 'invalid_request_error', 'model is not allowed')
      }
    }
    if (this.grants.get(token) !== grant) { refund(); return fail(res, 401, 'authentication_error', 'model grant expired') }
    const target = new URL(`${this.options.upstream.replace(/\/+$/, '')}${path}`)
    if (target.origin !== new URL(this.options.upstream).origin) return fail(res, 502, 'api_error', 'model upstream is invalid')
    req.on('aborted', () => abort.abort())
    res.on('close', () => { if (!res.writableEnded) abort.abort() })
    const abortDownstream = (): void => { if (res.headersSent && !res.writableEnded) res.destroy() }
    abort.signal.addEventListener('abort', abortDownstream, { once: true })
    let answer
      try {
        answer = await fetch(target, {
          method: req.method ?? 'POST',
          redirect: 'error',
          signal: abort.signal,
          headers: {
            'x-api-key': this.options.apiKey,
            'anthropic-version': headerOf(req, 'anthropic-version') ?? '2023-06-01',
            ...(headerOf(req, 'anthropic-beta') === undefined ? {} : { 'anthropic-beta': headerOf(req, 'anthropic-beta') as string }),
            ...(headerOf(req, 'user-agent') === undefined ? {} : { 'user-agent': headerOf(req, 'user-agent') as string }),
            ...(headerOf(req, 'x-deepseek-harness-user-id') === undefined ? {} : { 'x-deepseek-harness-user-id': headerOf(req, 'x-deepseek-harness-user-id') as string }),
            ...(headerOf(req, 'x-deepseek-harness-session-id') === undefined ? {} : { 'x-deepseek-harness-session-id': headerOf(req, 'x-deepseek-harness-session-id') as string }),
            ...(headerOf(req, 'x-deepseek-harness-compact') === undefined ? {} : { 'x-deepseek-harness-compact': headerOf(req, 'x-deepseek-harness-compact') as string }),
            'content-type': 'application/json',
            accept: headerOf(req, 'accept') ?? 'application/json',
          },
          ...(body.length === 0 ? {} : { body: body as unknown as BodyInit }),
        })
      } catch (error) {
        if (abort.signal.aborted && !res.headersSent && !res.writableEnded) return fail(res, 504, 'api_error', 'model upstream timed out')
        throw error
      }
      const headers: Record<string, string> = {}
      for (const name of ['content-type', 'cache-control', 'retry-after', 'request-id', 'x-request-id', 'x-deepseek-request-id']) {
        const value = answer.headers.get(name)
        if (value !== null) headers[name] = value
      }
      res.writeHead(answer.status, headers)
      if (answer.body === null) {
        res.end()
        return
      }
      try {
        await new Promise<void>((resolve) => {
          const stream = Readable.fromWeb(answer.body as import('node:stream/web').ReadableStream)
          stream.on('error', () => { res.destroy(); resolve() })
          res.on('close', () => { stream.destroy(); resolve() })
          stream.pipe(res).on('finish', resolve).on('error', () => { res.destroy(); resolve() })
        })
      } finally {
        abort.signal.removeEventListener('abort', abortDownstream)
      }
      if (answer.status >= 400) this.options.log(`model gateway: preview ${grant.previewId} ${String(answer.status)} ${path}`)
  }
}

/** Remove the configured key from a diagnostic message. */
function redact(message: string, apiKey: string): string {
  return message.split(apiKey).join('<redacted>').replace(/sk-[A-Za-z0-9_-]+/g, '<redacted>')
}

/** Read one request header as a single string. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(',') : value
}

/** Read the preview grant from x-api-key or the bearer fallback. */
function tokenOf(req: IncomingMessage): string | undefined {
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey !== '') return apiKey
  const authorization = req.headers.authorization
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return undefined
  return authorization.slice('Bearer '.length)
}

/** Read one bounded request body, aborting with the request signal. */
function readBody(req: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onAbort)
      req.off('aborted', onAbort)
      req.off('close', onAbort)
      signal.removeEventListener('abort', onAbort)
    }
    const done = (value: Buffer | undefined): void => {
      if (settled) return
      settled = true
      cleanup()
      chunks.length = 0
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > maxBytes) { done(undefined); req.resume(); return }
      chunks.push(chunk)
    }
    const onEnd = (): void => done(Buffer.concat(chunks))
    const onAbort = (): void => done(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onAbort)
    req.on('aborted', onAbort)
    req.on('close', onAbort)
  })
}

/** Send an Anthropic-shaped error response. */
function fail(res: ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

/** Send a plain-text response. */
function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
}

function close(server: Server | undefined): Promise<void> {
  if (server === undefined) return Promise.resolve()
  return new Promise((resolve) => { server.close(() => { resolve() }) })
}
