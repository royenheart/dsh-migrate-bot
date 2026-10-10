import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { IdempotencyStore } from '../src/idempotency.ts'
import { PreviewManager } from '../src/previews.ts'
import { InstanceProxy } from '../src/proxy.ts'
import { RunStore } from '../src/runs.ts'
import { createService } from '../src/server.ts'
import type { BuildResult, InstanceProvider, InstanceSpec, RunningInstance } from '../src/providers/types.ts'

/**
 * A deploy service on a free local port with a fake instance provider, and a
 * plugin repository on disk for webhook events to point at.
 */

export const TOKEN = 'test-token-0123456789'
export const SECRET = 'test-secret-0123456789'

/** What a fake `dsh web` saw of one request. */
export interface SeenRequest {
  label: string
  url: string
  headers: Record<string, string | string[] | undefined>
}

/**
 * A stand-in for one `dsh web` behind its forwarder: it listens on a Unix
 * socket, mints a session cookie for its launch token, answers only requests
 * that carry it with its loopback `Host`, and accepts WebSocket upgrades.
 */
export async function fakeWeb(label: string, socketPath: string, seen: SeenRequest[]): Promise<{ server: Server; token: string; authority: string }> {
  const token = `launch-${label}`
  const authority = `127.0.0.1:${label === 'plugin' ? '41001' : '41002'}`
  const server = createServer((req, res) => {
    seen.push({ label, url: req.url ?? '', headers: { ...req.headers } })
    if (req.headers.host !== authority) {
      res.writeHead(403).end('host')
      return
    }
    if (req.url === `/?token=${token}`) {
      res.writeHead(303, { 'Set-Cookie': `dsh-auth-${label}=session; HttpOnly`, Location: './' }).end()
      return
    }
    if (req.headers.cookie !== `dsh-auth-${label}=session`) {
      res.writeHead(401).end('unauthorized')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`${label} ${req.url ?? ''}`)
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ label, url: req.url ?? '', headers: { ...req.headers } })
    socket.on('error', () => { socket.destroy() })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  rmSync(socketPath, { force: true })
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
  return { server, token, authority }
}

/** An instance provider that runs nothing: builds pass or fail on demand, instances are fake servers. */
export class FakeProvider implements InstanceProvider {
  /** The files of each tree a build checked, by name. */
  readonly builds: string[][] = []
  readonly started: string[] = []
  readonly stopped: string[] = []
  readonly destroyed: string[] = []
  readonly seen: SeenRequest[] = []
  /** What the next builds answer, in order; the last one repeats. */
  results: BuildResult[] = [{ ok: true, detail: 'The boot check passed (fake).' }]
  /** How long a start takes. */
  startDelayMs = 0
  private readonly instances = new Map<string, RunningInstance>()
  private readonly servers = new Map<string, Server[]>()

  async build(_spec: InstanceSpec, candidateDir: string): Promise<BuildResult> {
    this.builds.push(readdirSync(candidateDir).sort())
    const result = this.results.length > 1 ? this.results.shift() : this.results[0]
    return result ?? { ok: false, detail: 'no result' }
  }

  async start(spec: InstanceSpec): Promise<RunningInstance> {
    if (this.startDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.startDelayMs))
    mkdirSync(spec.socketDir, { recursive: true })
    const plugin = await fakeWeb('plugin', join(spec.socketDir, 'plugin.sock'), this.seen)
    const safe = await fakeWeb('safe', join(spec.socketDir, 'safe.sock'), this.seen)
    this.servers.set(spec.id, [plugin.server, safe.server])
    const running: RunningInstance = {
      url: { socketPath: join(spec.socketDir, 'plugin.sock'), authority: plugin.authority, token: plugin.token },
      safeUrl: { socketPath: join(spec.socketDir, 'safe.sock'), authority: safe.authority, token: safe.token },
    }
    this.started.push(spec.id)
    this.instances.set(spec.id, running)
    return running
  }

  async stop(id: string): Promise<void> {
    if (!this.instances.delete(id)) return
    this.stopped.push(id)
    for (const server of this.servers.get(id) ?? []) {
      server.closeAllConnections()
      server.close()
    }
    this.servers.delete(id)
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id)
    this.destroyed.push(id)
  }

  running(id: string): RunningInstance | undefined {
    return this.instances.get(id)
  }

  close(): void {
    for (const id of [...this.instances.keys()]) void this.stop(id)
  }
}

export interface TestService {
  url: string
  dataDir: string
  provider: FakeProvider
  previews: PreviewManager
  call: (method: string, path: string, options?: { body?: unknown; headers?: Record<string, string>; token?: string | null }) => Promise<Response>
  close: () => Promise<void>
}

/**
 * Start a service on a free port.
 * @param options.conformance - start with `--conformance`.
 * @param options.publicViews - `PUBLIC_VIEWS=true`.
 * @param options.dataDir - a data directory the caller owns and removes, so a restart can reuse it.
 */
export async function startService(options: { conformance?: boolean; publicViews?: boolean; dataDir?: string } = {}): Promise<TestService> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'dsh-deploy-test-'))
  const ownsData = options.dataDir === undefined
  const loaded = loadConfig({
    DEPLOY_TOKEN: TOKEN,
    GITHUB_WEBHOOK_SECRET: SECRET,
    DATA_DIR: dataDir,
    PUBLIC_URL: 'http://127.0.0.1:1',
    PROVIDER: 'process',
    DSH_BIN: '/nonexistent/dsh',
    PUBLIC_VIEWS: options.publicViews === true ? 'true' : 'false',
  }, options.conformance === true ? ['--conformance'] : [])
  if (!loaded.ok) throw new Error(loaded.problems.join('; '))
  const provider = new FakeProvider()
  const previews = new PreviewManager({ dataDir, publicUrl: 'http://127.0.0.1:1', ttlDays: 7, idleMinutes: 30, provider, log: () => {} })
  await previews.load()
  const server = createService({
    config: loaded.config,
    runs: new RunStore(join(dataDir, 'runs'), 'http://127.0.0.1:1'),
    previews,
    idempotency: new IdempotencyStore(join(dataDir, 'idempotency')),
    proxy: new InstanceProxy('http://127.0.0.1:1'),
    log: () => {},
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const url = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
  return {
    url,
    dataDir,
    provider,
    previews,
    call: async (method, path, call = {}) => {
      const token = call.token === undefined ? TOKEN : call.token
      return await fetch(`${url}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...call.headers,
        },
        ...(call.body === undefined ? {} : { body: typeof call.body === 'string' ? call.body : JSON.stringify(call.body) }),
      })
    },
    close: async () => {
      await previews.settled()
      provider.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      if (ownsData) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** A plugin repository with a bare origin, and the head of a pull request branch. */
export function pluginRepository(): { origin: string; head: string; root: string; commit: (file: string, content: string) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-repo-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const git = (args: string[], cwd = work): string => {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git(['init', '--quiet', '--bare', origin], root)
  git(['init', '--quiet', work], root)
  writeFileSync(join(work, 'package.json'), '{"name":"@acme/plugin","version":"1.0.0","type":"module"}\n')
  writeFileSync(join(work, 'index.js'), 'export const apply = () => {}\n')
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'init'])
  git(['push', '--quiet', origin, 'HEAD:refs/heads/feature'])
  const commit = (file: string, content: string): string => {
    writeFileSync(join(work, file), content)
    git(['add', '-A'])
    git(['commit', '--quiet', '-m', `change ${file}`])
    git(['push', '--quiet', origin, 'HEAD:refs/heads/feature'])
    return git(['rev-parse', 'HEAD'])
  }
  return { origin, head: git(['rev-parse', 'HEAD']), root, commit, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** A signed GitHub `pull_request` delivery. */
export function pullRequestEvent(input: { action: string; number: number; sha: string; cloneUrl: string; headRepository?: string | null }, secret = SECRET): { body: string; headers: Record<string, string> } {
  const head = input.headRepository === undefined ? 'acme/plugin' : input.headRepository
  const body = JSON.stringify({
    action: input.action,
    number: input.number,
    pull_request: { head: { sha: input.sha, ref: 'feature', repo: head === null ? null : { full_name: head } } },
    repository: { full_name: 'acme/plugin', clone_url: input.cloneUrl },
  })
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': `delivery-${input.action}-${input.sha}`,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
  }
}

