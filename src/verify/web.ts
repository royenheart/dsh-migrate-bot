import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyBoot, writeProbeProfile, type BootProbeResult } from './boot.ts'
import { readPackageName } from '../mechanical/run.ts'

/**
 * Headless web smoke: boot the real `dsh web` server with the plugin mounted
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
}

export interface WebSmokeSpawn {
  (args: string[], options: {
    cwd: string
    env: NodeJS.ProcessEnv
    bin: string
    timeoutMs: number
    ready: (output: string) => boolean
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
}

/** A plugin declares a browser surface through `dsh.client`. */
export function hasClientSurface(workdir: string): boolean {
  const path = join(workdir, 'package.json')
  if (!existsSync(path)) return false
  try {
    const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof pkg !== 'object' || pkg === null) return false
    const client = (pkg as { dsh?: { client?: unknown } }).dsh?.client
    return typeof client === 'object' && client !== null
  } catch {
    return false
  }
}

/**
 * Spawn, watch the output for the ready pattern, and kill as soon as it lands
 * or the watchdog fires. A web server never exits on its own, so waiting for
 * the process would always time out.
 */
function defaultSpawn(
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    bin: string
    timeoutMs: number
    ready: (output: string) => boolean
  },
): Promise<WebSmokeSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(options.bin, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (result: WebSmokeSpawnResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, 5_000).unref?.()
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

/**
 * Boot the web profile in a scratch home with the plugin mounted.
 *
 * Keyless like the boot probe: the model route points at a dead port, so
 * reaching the server-ready line proves the composition and the plugin's
 * client entry resolved.
 * @param options - workdir, dsh binary, timeout, injectable spawn
 */
export async function webSmoke(options: WebSmokeOptions): Promise<WebSmokeResult> {
  if (!hasClientSurface(options.workdir)) {
    return {
      ok: true,
      signature: 'web: no client surface',
      detail: '',
      skipped: 'the plugin declares no dsh.client surface',
    }
  }

  const pluginName = readPackageName(options.workdir)
  if (pluginName === undefined) {
    return { ok: false, signature: 'web: package.json has no usable name', detail: '' }
  }

  const profile = options.profile ?? 'probe-web'
  const ownHome = options.homeDir === undefined
  const home = options.homeDir ?? mkdtempSync(join(tmpdir(), 'dsh-migrate-websmoke-'))
  const readyPattern = options.readyPattern ?? WEB_READY_PATTERN
  const spawnImpl = options.spawnImpl ?? defaultSpawn

  try {
    // The web profile is base + the shipped web app bundle + the plugin under test.
    const dir = join(home, 'profiles', profile)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeProbeProfile(home, profile, pluginName, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pluginName])
    const link = join(dir, 'node_modules', pluginName)
    mkdirSync(dirname(link), { recursive: true })
    if (!existsSync(link)) symlinkSync(options.workdir, link, 'dir')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_API_KEY: process.env.DSH_MIGRATE_PROBE_API_KEY ?? 'probe-placeholder-key',
      DEEPSEEK_BASE_URL: process.env.DSH_MIGRATE_PROBE_BASE_URL ?? 'http://127.0.0.1:9/v1',
      DSH_TELEMETRY_DISABLED: '1',
    }

    const result = await spawnImpl(['web', '--port', '0', '--no-open'], {
      cwd: options.workdir,
      env,
      bin: options.bin,
      timeoutMs: options.timeoutMs,
      ready: output => readyPattern.test(output),
    })

    if (result.ready) {
      return { ok: true, signature: 'web: server ready', detail: scrubWebOutput(result.output).slice(-2000) }
    }
    // Not ready: reuse the boot classifier so a plugin failure reads the same
    // way whichever layer caught it.
    const classified: BootProbeResult = classifyBoot({
      code: result.code,
      stdout: result.output,
      stderr: '',
      timedOut: result.timedOut,
    })
    if (classified.outcome === 'pass') {
      // Reached the model call without ever serving: that is a web-layer failure.
      return {
        ok: false,
        signature: 'web: exited before serving',
        detail: scrubWebOutput(result.output).slice(-4000),
      }
    }
    return { ok: false, signature: `web ${classified.signature}`, detail: classified.detail }
  } finally {
    if (ownHome) {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // a leaked scratch dir must never fail a migration
      }
    }
  }
}
