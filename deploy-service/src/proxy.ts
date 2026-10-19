import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { InstanceEndpoint } from './providers/types.ts'

/**
 * The passthrough from `/p/{id}/` and `/p/{id}/safe/` to a running instance.
 *
 * `dsh web` authenticates a browser with a launch token it exchanges for a
 * cookie bound to the `Host` it was served under, and it only accepts a
 * loopback `Host`. The proxy does that exchange itself, once per instance
 * start: it sends every request with the instance's loopback authority as
 * `Host` and its own session cookie, and never lets the browser see the token
 * or the cookie. Who may reach the proxy at all is decided in front of it
 * (see the server's access rules). No credential the browser or a proxy in
 * front sent reaches the instance: the bearer token, cookies, and the
 * identity headers Cloudflare Access adds are removed. The instance is reached
 * over the Unix sockets its forwarder created, never over a network.
 */

/** Hop-by-hop headers, which describe one connection and are never forwarded. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/** Headers the proxy sets itself, or that carry a credential the instance never receives. */
const WITHHELD = new Set(['host', 'referer', 'authorization', 'proxy-authorization', 'cookie'])

/** Whether a request header stays out of what the instance receives; `cf-access-*` carries the Access identity. */
function withheld(name: string): boolean {
  return WITHHELD.has(name) || name.startsWith('cf-access-')
}

export class InstanceProxy {
  private readonly cookies = new Map<string, Promise<string>>()

  /**
   * @param publicOrigin - the service's own origin, which a browser sends as `Origin`.
   */
  constructor(private readonly publicOrigin: string) {}

  /** The session cookie for an endpoint, minted from its launch token once. */
  private async cookie(endpoint: InstanceEndpoint): Promise<string> {
    const key = `${endpoint.socketPath} ${endpoint.token}`
    let minted = this.cookies.get(key)
    if (minted === undefined) {
      minted = exchange(endpoint)
      this.cookies.set(key, minted)
      minted.catch(() => { this.cookies.delete(key) })
    }
    return await minted
  }

  /** The headers a request carries upstream. */
  private headers(incoming: IncomingHttpHeaders, endpoint: InstanceEndpoint, cookie: string, upgrade: boolean): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(incoming)) {
      if (value === undefined) continue
      if (withheld(name)) continue
      if (HOP_BY_HOP.has(name) && !(upgrade && (name === 'connection' || name === 'upgrade'))) continue
      headers[name] = value
    }
    headers.host = endpoint.authority
    headers.cookie = cookie
    // The browser is on the service's origin; to the instance the same request
    // comes from its own. Any other origin is passed on, and refused there.
    if (incoming.origin === this.publicOrigin) headers.origin = `http://${endpoint.authority}`
    return headers
  }

  /**
   * Forward one HTTP request.
   * @param req - the request as received.
   * @param res - where the answer goes.
   * @param endpoint - the instance entry to reach.
   * @param path - the path and query under the entry, starting with `/`.
   */
  async web(req: IncomingMessage, res: ServerResponse, endpoint: InstanceEndpoint, path: string): Promise<void> {
    const cookie = await this.cookie(endpoint)
    await new Promise<void>((resolve) => {
      const upstream = httpRequest({
        socketPath: endpoint.socketPath,
        method: req.method,
        path,
        headers: this.headers(req.headers, endpoint, cookie, false),
      }, (answer) => {
        const headers: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(answer.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue
          if (name === 'set-cookie') {
            const kept = (Array.isArray(value) ? value : [value]).filter(line => !line.startsWith('dsh-auth-'))
            if (kept.length > 0) headers[name] = kept
            continue
          }
          headers[name] = value
        }
        res.writeHead(answer.statusCode ?? 502, headers)
        answer.pipe(res)
        answer.on('end', resolve)
        answer.on('error', () => { res.destroy(); resolve() })
      })
      upstream.on('error', (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`the preview instance did not answer: ${error.message}\n`)
        } else {
          res.destroy()
        }
        resolve()
      })
      req.pipe(upstream)
    })
  }

  /**
   * Forward a WebSocket upgrade, then the bytes in both directions.
   * @param req - the upgrade request.
   * @param socket - the client connection.
   * @param head - bytes the client sent after the headers.
   * @param endpoint - the instance entry to reach.
   * @param path - the path and query under the entry.
   */
  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, endpoint: InstanceEndpoint, path: string): Promise<void> {
    const cookie = await this.cookie(endpoint)
    const upstream: Socket = connect({ path: endpoint.socketPath })
    upstream.on('connect', () => {
      const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`]
      for (const [name, value] of Object.entries(this.headers(req.headers, endpoint, cookie, true))) {
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket).pipe(upstream)
    })
    // Both ends are half-open sockets; when either side finishes, the
    // connection is over, and nothing would close the other side otherwise.
    const close = (): void => {
      socket.destroy()
      upstream.destroy()
    }
    for (const side of [upstream, socket]) {
      side.on('end', close)
      side.on('close', close)
      side.on('error', close)
    }
  }
}

/** Exchange a launch token for the session cookie `dsh web` mints for it. */
function exchange(endpoint: InstanceEndpoint): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath: endpoint.socketPath,
      method: 'GET',
      path: `/?token=${encodeURIComponent(endpoint.token)}`,
      headers: { host: endpoint.authority },
      timeout: 10_000,
    }, (res) => {
      res.resume()
      const cookie = (res.headers['set-cookie'] ?? []).map(line => line.split(';')[0] ?? '').find(pair => pair.startsWith('dsh-auth-'))
      if (cookie === undefined) reject(new Error(`the instance answered the token exchange with ${String(res.statusCode)} and no session cookie`))
      else resolve(cookie)
    })
    req.on('timeout', () => { req.destroy(new Error('the token exchange timed out')) })
    req.on('error', reject)
    req.end()
  })
}
