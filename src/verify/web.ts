import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyBoot, linkPlugins, skippedBundle, writeProbeProfile, type BootProbeResult } from './boot.ts'
import { declaresClient, findPlugins } from '../plugins.ts'

/**
 * The web check: boot the real `dsh web` server with the plugin mounted
 * and no browser, then report whether the host came up with the plugin
 * attached. It catches the "the UI plugin never registered anything" class
 * without paying for a browser, and it runs before the suite so a tree that
 * cannot serve at all never reaches Chromium.
 */

export interface WebSmokeResult {
  ok: boolean
  signature: string
  detail: string
  /** Present when the layer had nothing to check. */
  skipped?: string
}

export interface WebSmokeSpawnResult {
  code: number | null
  output: string
  timedOut: boolean
  /** Resolved because the ready pattern appeared, not because the process ended. */
  ready: boolean
  /** Stops a server that was kept running after it became ready. */
  stop?: (() => void) | undefined
}

export interface WebSmokeSpawn {
  (args: string[], options: {
    cwd: string
    env: NodeJS.ProcessEnv
    bin: string
    timeoutMs: number
    ready: (output: string) => boolean
    /** Keep the server running once ready; the result's `stop` ends it. */
    keep?: boolean
  }): Promise<WebSmokeSpawnResult>
}

/** What `dsh web` prints once it is listening. */
export const WEB_READY_PATTERN = /dsh web:[^\n]*https?:\/\//i

/**
 * The ready line embeds a live session token
 * (`dsh web: http://127.0.0.1:37489/?token=…`). Reports are committed to
 * Issues and uploaded as artifacts, so the token never leaves this function.
 * @param text - raw server output
 */
export function scrubWebOutput(text: string): string {
  return text.replace(/([?&]token=)[^\s&"']+/gi, '$1<redacted>')
}

export interface WebSmokeOptions {
  workdir: string
  bin: string
  timeoutMs: number
  dshTag?: string | undefined
  spawnImpl?: WebSmokeSpawn | undefined
  homeDir?: string | undefined
  profile?: string | undefined
  readyPattern?: RegExp | undefined
  /** The release's `dsh web --help`; read from the binary unless a test supplies it. */
  webHelp?: string | undefined
  /** The environment dsh starts from; the Action's own unless the caller removed its secrets. */
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * The arguments that serve `profile` without opening a browser. `dsh web` is
 * `dsh --profile web`, a profile of its own, so the profile under test is named.
 * Releases before `--no-open` existed do not open one, so the flag is passed
 * only when the release's own help lists it.
 */
export function webArgs(help: string, profile: string): string[] {
  return ['--profile', profile, '--port', '0', ...(help.includes('--no-open') ? ['--no-open'] : [])]
}

function webHelp(bin: string): string {
  const result = spawnSync(bin, ['web', '--help'], { encoding: 'utf8', timeout: 60_000 })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/** Whether a plugin of the repository declares a browser surface through `dsh.client`. */
export function hasClientSurface(workdir: string): boolean {
  return findPlugins(workdir).some(declaresClient)
}

/**
 * Spawn, watch the output for the ready pattern, and kill as soon as it lands
 * or the watchdog fires, unless the caller keeps the server. A web server never
 * exits on its own, so waiting for the process would always time out.
 */
function defaultSpawn(
  args: string[],
  options: Parameters<WebSmokeSpawn>[1],
): Promise<WebSmokeSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(options.bin, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const kill = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, 5_000).unref?.()
    }
    const finish = (result: WebSmokeSpawnResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result.ready && options.keep === true) {
        resolve({ ...result, stop: kill })
        return
      }
      kill()
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ code: null, output, timedOut: true, ready: false })
    }, options.timeoutMs)
    timer.unref?.()
    const onData = (chunk: unknown): void => {
      output += String(chunk)
      if (options.ready(output)) finish({ code: 0, output, timedOut: false, ready: true })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      finish({ code: null, output: `${output}\n${error.message}`, timedOut: false, ready: false })
    })
    child.on('close', (code) => {
      finish({ code, output, timedOut: false, ready: false })
    })
  })
}

interface Served {
  result: WebSmokeSpawnResult
  /** Ends the server, when it was kept, and removes the scratch home. */
  stop: () => void
}

/** Serve the web profile from a scratch home with every plugin of the tree mounted. */
async function serveWeb(options: WebSmokeOptions, keep: boolean): Promise<Served> {
  const plugins = findPlugins(options.workdir)
  const profile = options.profile ?? 'probe-web'
  const ownHome = options.homeDir === undefined
  const home = options.homeDir ?? mkdtempSync(join(tmpdir(), 'dsh-migrate-websmoke-'))
  const readyPattern = options.readyPattern ?? WEB_READY_PATTERN
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const cleanup = (): void => {
    if (!ownHome) return
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // a leaked scratch dir must never fail a migration
    }
  }
  try {
    // The web profile is base + the shipped web app bundle + the plugins under test.
    const dir = join(home, 'profiles', profile)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const names = plugins.map(plugin => plugin.name)
    writeProbeProfile(home, profile, names, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...names])
    linkPlugins(dir, options.workdir, plugins)
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      DSH_HOME: home,
      DEEPSEEK_API_KEY: process.env.DSH_MIGRATE_PROBE_API_KEY ?? 'probe-placeholder-key',
      DEEPSEEK_BASE_URL: process.env.DSH_MIGRATE_PROBE_BASE_URL ?? 'http://127.0.0.1:9/v1',
      DSH_TELEMETRY_DISABLED: '1',
    }
    const result = await spawnImpl(webArgs(options.webHelp ?? webHelp(options.bin), profile), {
      cwd: options.workdir,
      env,
      bin: options.bin,
      timeoutMs: options.timeoutMs,
      ready: output => readyPattern.test(output),
      keep,
    })
    return { result, stop: () => { result.stop?.(); cleanup() } }
  } catch (error) {
    cleanup()
    throw error
  }
}

/** Why a server that never became ready did not, in the boot check's words. */
function notReady(result: WebSmokeSpawnResult): WebSmokeResult {
  // Reuse the boot classifier so a plugin failure reads the same way whichever layer caught it.
  const classified: BootProbeResult = classifyBoot({ code: result.code, stdout: result.output, stderr: '', timedOut: result.timedOut })
  if (classified.outcome === 'pass') {
    // Reached the model call without ever serving: that is a web-layer failure.
    return { ok: false, signature: 'web: exited before serving', detail: scrubWebOutput(result.output).slice(-4000) }
  }
  return { ok: false, signature: `web ${classified.signature}`, detail: classified.detail }
}

/**
 * Boot the web profile in a scratch home with every plugin mounted.
 *
 * Keyless like the boot check: the model route points at a dead port, so
 * reaching the server-ready line proves the composition and the plugins'
 * client entries resolved.
 * @param options - workdir, dsh binary, timeout, injectable spawn
 */
export async function webSmoke(options: WebSmokeOptions): Promise<WebSmokeResult> {
  if (!hasClientSurface(options.workdir)) {
    return {
      ok: true,
      signature: 'web: no client surface',
      detail: '',
      skipped: 'no plugin declares a dsh.client surface',
    }
  }
  const served = await serveWeb(options, false)
  try {
    const skipped = skippedBundle(served.result.output)
    if (served.result.ready && skipped === undefined) return { ok: true, signature: 'web: server ready', detail: scrubWebOutput(served.result.output).slice(-2000) }
    return notReady(served.result)
  } finally {
    served.stop()
  }
}

/** A `dsh web` server kept running for an end-to-end suite. */
export interface WebHost {
  /** The launch URL, with the token a browser exchanges for a session. */
  url: string
  stop: () => void
}

/**
 * Serve the tree's plugins on one release until `stop`, for a suite to drive.
 * @returns the host, or why it did not come up.
 */
export async function startWebHost(options: WebSmokeOptions): Promise<{ ok: true; host: WebHost } | { ok: false; failure: WebSmokeResult }> {
  const served = await serveWeb(options, true)
  const line = served.result.output.split('\n').find(text => (options.readyPattern ?? WEB_READY_PATTERN).test(text))
  const url = line?.match(/https?:\/\/\S+/)?.[0]
  if (!served.result.ready || url === undefined || skippedBundle(served.result.output) !== undefined) {
    served.stop()
    return { ok: false, failure: served.result.ready && url === undefined ? { ok: false, signature: 'web: no launch URL', detail: '' } : notReady(served.result) }
  }
  return { ok: true, host: { url, stop: served.stop } }
}
