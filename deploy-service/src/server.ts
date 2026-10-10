import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { BodyTooLarge, failure, hasBearer, headerValue, json, readBody, send, validSignature, type Answer } from './http.ts'
import { repositorySchema, type PreviewKey, type PreviewManager } from './previews.ts'
import { webhookIntent } from './webhook.ts'
import type { ServiceConfig } from './config.ts'
import type { IdempotencyStore } from './idempotency.ts'
import type { InstanceProxy } from './proxy.ts'
import type { RunStore } from './runs.ts'

/**
 * The HTTP surface of the deploy service.
 *
 * Three kinds of path, with three access rules:
 *
 * - the API the Action calls (`/runs…`, `/previews…`) needs the bearer token;
 * - the GitHub webhook (`/github/webhook`) needs a valid HMAC signature;
 * - the pages a person opens (`/view/…`, `/p/…`) need the bearer token unless
 *   `PUBLIC_VIEWS=true`, which is for a deployment where an identity-aware
 *   proxy in front of the service decides who reaches them.
 *
 * `/healthz` answers anyone, and says nothing but that the process is up.
 */

export interface ServiceDeps {
  config: ServiceConfig
  runs: RunStore
  previews: PreviewManager
  idempotency: IdempotencyStore
  proxy: InstanceProxy
  log: (message: string) => void
}

/** The largest API request body; a run event is far smaller. */
const API_BODY_LIMIT = 1024 * 1024
/** The largest webhook body GitHub sends. */
const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024
/** How long a `slow` conformance answer waits: past the Action's twenty seconds. */
const SLOW_MS = 25_000
/** How large an `oversize` conformance answer is: past the Action's 2 MiB. */
const OVERSIZE_BYTES = 2 * 1024 * 1024 + 1024

class BadPath extends Error {}

/** Split a path into decoded segments; `%2F` inside a segment stays inside it. */
function segments(pathname: string): string[] {
  try {
    return pathname.split('/').slice(1).map(segment => decodeURIComponent(segment))
  } catch {
    throw new BadPath('the path is not valid percent-encoding')
  }
}

/** The pull request a `/previews/{repository}/{pullRequest}` path names. */
function previewKey(repository: string | undefined, pullRequest: string | undefined): PreviewKey | undefined {
  if (repository === undefined || pullRequest === undefined) return undefined
  if (!repositorySchema.safeParse(repository).success || !/^[1-9][0-9]{0,9}$/.test(pullRequest)) return undefined
  return { repository, pullRequest: Number(pullRequest) }
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, API_BODY_LIMIT)
  if (body.length === 0) return undefined
  return JSON.parse(body.toString('utf8'))
}

/**
 * Create the service's HTTP server; the caller listens.
 * @param deps - the stores, the preview manager, the proxy, and the configuration.
 */
export function createService(deps: ServiceDeps): Server {
  const { config, runs, previews, idempotency, proxy, log } = deps

  /** The API routes; every answer is built first so it can be stored for replay. */
  async function api(req: IncomingMessage, parts: string[], url: URL): Promise<Answer> {
    const method = req.method ?? 'GET'
    const [root, first, second, third, ...rest] = parts
    if (root === 'runs') {
      if (method !== 'POST') return failure(405, 'runs accept POST only')
      if (first === undefined && second === undefined) return runs.open(await jsonBody(req))
      if (first !== undefined && second === 'events' && third === undefined) return runs.append(first, await jsonBody(req))
      if (first !== undefined && second === 'finish' && third === undefined) return runs.finish(first, await jsonBody(req))
      return failure(404, 'no such run path')
    }
    const key = previewKey(first, second)
    if (key === undefined || rest.length > 0) return failure(404, 'a preview path is /previews/{owner%2Fname}/{pullRequest}')
    if (third === undefined) {
      if (method === 'GET') return previews.status(key)
      if (method === 'DELETE') return await previews.destroy(key)
      if (method === 'POST') {
        if (config.conformance && headerValue(req, 'x-conformance') === 'seed') return await previews.seed(key)
        return await previews.request(key, await jsonBody(req))
      }
      return failure(405, 'a preview accepts GET, POST and DELETE')
    }
    if (third === 'scratch' && method === 'GET') return previews.scratch(key, url.searchParams.get('revision'))
    if (third === 'publish-result' && method === 'POST') return previews.publishResult(key, await jsonBody(req))
    return failure(404, 'no such preview path')
  }

  /**
   * The test-only misbehaviour of `--conformance`, or nothing.
   *
   * Without the flag the header is ignored entirely, so a deployment cannot be
   * made to misbehave by whoever holds the token.
   */
  async function misbehave(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!config.conformance) return false
    const mode = headerValue(req, 'x-conformance')
    if (mode === undefined || mode === 'seed') return false
    if (mode === 'slow') {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      if (!res.destroyed) send(res, json(200, { slow: true }))
      return true
    }
    if (mode === 'oversize') {
      send(res, { status: 200, contentType: 'application/json', body: JSON.stringify({ padding: 'x'.repeat(OVERSIZE_BYTES) }) })
      return true
    }
    if (mode === 'redirect') {
      send(res, { status: 302, contentType: 'text/plain', body: 'elsewhere\n', headers: { Location: `${config.PUBLIC_URL}/healthz` } })
      return true
    }
    send(res, failure(400, `unknown X-Conformance mode ${mode}`))
    return true
  }

  async function webhook(req: IncomingMessage): Promise<Answer> {
    const body = await readBody(req, WEBHOOK_BODY_LIMIT)
    if (!validSignature(body, headerValue(req, 'x-hub-signature-256'), config.GITHUB_WEBHOOK_SECRET)) {
      return failure(401, 'the webhook signature does not match GITHUB_WEBHOOK_SECRET')
    }
    const event = headerValue(req, 'x-github-event')
    if (event === 'ping') return json(200, { pong: true })
    const act = async (): Promise<Answer> => {
      const intent = webhookIntent(event, JSON.parse(body.toString('utf8')), config.PROVIDER)
      if (intent.kind === 'invalid') return failure(400, `not a pull_request event this service can read: ${intent.reason}`)
      if (intent.kind === 'ignore') return json(202, { ignored: intent.reason })
      if (intent.kind === 'close') return json(200, { removed: await previews.close(intent.key) })
      if (intent.kind === 'refuse') {
        previews.refuse(intent.key, intent.reason)
        return json(202, { ignored: intent.reason })
      }
      const record = previews.announce(intent.announcement, intent.reopened)
      if (record === undefined) return json(202, { ignored: 'the pull request is closed' })
      return json(202, { accepted: true, preview: record.id, headSha: record.headSha })
    }
    // A redelivered event carries the same delivery id and is answered, not acted on twice.
    const delivery = headerValue(req, 'x-github-delivery')
    if (delivery === undefined) return await act()
    return (await idempotency.run({ method: 'POST', path: '/github/webhook', key: delivery }, act)).answer
  }

  /** `/p/{id}/…` and `/p/{id}/safe/…`: the path under the entry, or a redirect to the entry. */
  function proxyTarget(pathname: string, search: string): { id: string; safe: boolean; path: string } | { redirect: string } | undefined {
    const raw = pathname.split('/')
    const id = raw[2]
    if (id === undefined || !/^[0-9a-f]{16}$/.test(id)) return undefined
    if (raw.length === 3) return { redirect: `/p/${id}/` }
    const safe = raw[3] === 'safe'
    if (safe && raw.length === 4) return { redirect: `/p/${id}/safe/` }
    return { id, safe, path: `/${raw.slice(safe ? 4 : 3).join('/')}${search}` }
  }

  function mayView(req: IncomingMessage): boolean {
    return config.PUBLIC_VIEWS || hasBearer(req, config.DEPLOY_TOKEN)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://service')
    const parts = segments(url.pathname)
    const root = parts[0]
    if (url.pathname === '/healthz') return send(res, json(200, { ok: true }))
    if (url.pathname === '/github/webhook') {
      if (req.method !== 'POST') return send(res, failure(405, 'the webhook accepts POST only'))
      return send(res, await webhook(req))
    }
    if (root === 'view' || root === 'p') {
      if (!mayView(req)) return send(res, { ...failure(401, 'this page needs the deploy token, or an identity-aware proxy in front of the service with PUBLIC_VIEWS=true'), headers: { 'WWW-Authenticate': 'Bearer' } })
      if (root === 'view') {
        if (req.method !== 'GET' || parts.length !== 2 || parts[1] === undefined) return send(res, failure(404, 'no such page'))
        return send(res, runs.page(parts[1]))
      }
      const target = proxyTarget(url.pathname, url.search)
      if (target === undefined) return send(res, failure(404, 'no such preview'))
      if ('redirect' in target) return send(res, { status: 308, contentType: 'text/plain', body: '', headers: { Location: target.redirect } })
      if (previews.byId(target.id) === undefined) return send(res, failure(404, 'no such preview'))
      let instance
      try {
        instance = await previews.ensureRunning(target.id)
      } catch (error) {
        return send(res, { status: 503, contentType: 'text/plain; charset=utf-8', body: `the preview is not serving: ${error instanceof Error ? error.message : String(error)}\n` })
      }
      previews.touch(target.id)
      await proxy.web(req, res, target.safe ? instance.safeUrl : instance.url, target.path)
      return
    }
    if (root !== 'runs' && root !== 'previews') return send(res, failure(404, 'not found'))
    if (!hasBearer(req, config.DEPLOY_TOKEN)) return send(res, { ...failure(401, 'missing or wrong bearer token'), headers: { 'WWW-Authenticate': 'Bearer' } })
    if (await misbehave(req, res)) return
    const key = headerValue(req, 'idempotency-key')
    const method = req.method ?? 'GET'
    if (key === undefined || method === 'GET') return send(res, await api(req, parts, url))
    const { answer, replayed } = await idempotency.run({ method, path: url.pathname, key }, async () => await api(req, parts, url))
    if (replayed) req.resume()
    return send(res, answer, replayed ? { 'Idempotency-Replayed': 'true' } : {})
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof BodyTooLarge ? 413 : error instanceof BadPath || error instanceof SyntaxError ? 400 : 500
      if (status === 500) log(`${req.method ?? '?'} ${req.url ?? '?'} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (!res.headersSent) send(res, failure(status, error instanceof Error ? error.message : String(error)))
      else res.destroy()
    })
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // The server removes its own error listener from an upgraded socket; a
    // client that resets the connection must not take the process down.
    socket.on('error', () => { socket.destroy() })
    const refuse = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const url = new URL(req.url ?? '/', 'http://service')
    if (!url.pathname.startsWith('/p/')) return refuse('404 Not Found')
    if (!mayView(req)) return refuse('401 Unauthorized')
    const target = proxyTarget(url.pathname, url.search)
    if (target === undefined || 'redirect' in target || previews.byId(target.id) === undefined) return refuse('404 Not Found')
    previews.ensureRunning(target.id).then(async (instance) => {
      if (socket.destroyed) return
      const release = previews.socketOpened(target.id)
      socket.on('close', release)
      await proxy.upgrade(req, socket, head, target.safe ? instance.safeUrl : instance.url, target.path)
    }).catch(() => { refuse('503 Service Unavailable') })
  })

  return server
}
