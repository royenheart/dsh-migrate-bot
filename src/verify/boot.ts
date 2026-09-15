import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readPackageName } from '../mechanical/run.ts'

/**
 * `dsh` reports a plugin that cannot load, a plugin whose `apply` throws, and a
 * plugin stuck waiting on a service that nobody provides, then exits nonzero —
 * `assertEntriesActivated()` in `@deepseek-ai/dsh-boot` is what makes the boot
 * fail loud. It has no hang watchdog, so an `apply` that never resolves hangs
 * the boot instead of failing it, which is why the probe always runs under one.
 */
export type BootOutcome = 'pass' | 'fail' | 'timeout'

export interface BootProbeResult {
  outcome: BootOutcome
  /**
   * Normalized failure class, stable across runs of the same fault. Two rounds
   * that produce the same signature did not change anything, which is the
   * evidence the repair loop uses to stop early.
   */
  signature: string
  /** Trimmed tail of the combined output, for the report. */
  detail: string
  /** dsh version string the probe ran against, when it could be read. */
  dshVersion?: string
}

export interface BootSpawnResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface BootSpawn {
  (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; bin: string }): Promise<BootSpawnResult>
}

/**
 * Markers that mean "the host booted and reached the model call".
 *
 * Observed against a real `dsh 0.1.5-rc.1`: with the model route pointed at a
 * dead port the host prints `dsh: TRANSPORT: DeepSeek API request to
 * http://127.0.0.1:9/v1 failed` and exits nonzero. Reaching that point proves
 * the plugin tree assembled and activated, which is what the probe is for.
 */
const REACHED_MODEL = [
  /TRANSPORT:/i,
  /API request to .* failed/i,
  /127\.0\.0\.1:9\b/,
  /MISSING_CREDENTIAL/i,
  /\bAUTH\b/,
  /no api key/i,
  /invalid api key/i,
  /apikey: \*+-\w+ is invalid/i,
  /ECONNREFUSED/i,
  /ENOTFOUND|ETIMEDOUT|socket hang up/i,
  /fetch failed/i,
  /Authentication Fails/i,
]

/** Markers that mean a plugin broke the boot. */
const PLUGIN_LOAD = /plugin\(s\) failed to load:\s*(.+)/i
const DID_NOT_ACTIVATE = /did not activate/i
const PENDING = /pending \(waiting for services?:\s*([^)]*)\)/i
const FIBER_FAILED = /FAILED fiber|ClientPackageCompositionError/i

const TAIL_BYTES = 8_000

/**
 * Collapse run-to-run noise (paths, ids, numbers, timings) so the same fault
 * yields the same signature.
 * @param text - raw failure text
 */
export function normalizeSignature(text: string): string {
  return text
    .replace(/\u001B\[[0-9;]*m/g, '')
    .replace(/\/(?:tmp|home|github|opt|var)\/[^\s:'")]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

function tail(text: string): string {
  return text.length <= TAIL_BYTES ? text : text.slice(text.length - TAIL_BYTES)
}

/**
 * Decide a boot outcome from dsh's own output. Pure, so the classification is
 * unit-testable without a dsh binary.
 * @param input - exit code, streams, and whether the watchdog fired
 */
export function classifyBoot(input: {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}): BootProbeResult {
  const combined = `${input.stderr}\n${input.stdout}`
  const detail = tail(combined.trim())

  if (input.timedOut) {
    return { outcome: 'timeout', signature: 'timeout: boot did not finish', detail }
  }

  const load = combined.match(PLUGIN_LOAD)
  if (load?.[1] !== undefined) {
    return { outcome: 'fail', signature: `load: ${normalizeSignature(load[1])}`, detail }
  }

  const pending = combined.match(PENDING)
  if (pending?.[1] !== undefined) {
    return { outcome: 'fail', signature: `pending: ${normalizeSignature(pending[1])}`, detail }
  }

  if (DID_NOT_ACTIVATE.test(combined)) {
    const failures = combined
      .split('\n')
      .filter(line => /did not activate|failed to load|pending \(waiting|FAILED fiber/i.test(line))
      .join(' | ')
    return { outcome: 'fail', signature: `activate: ${normalizeSignature(failures)}`, detail }
  }

  if (FIBER_FAILED.test(combined)) {
    const line = combined.split('\n').find(item => FIBER_FAILED.test(item)) ?? combined
    return { outcome: 'fail', signature: `fiber: ${normalizeSignature(line)}`, detail }
  }

  // Reaching the model call proves the plugin tree assembled and activated.
  if (REACHED_MODEL.some(pattern => pattern.test(combined))) {
    return { outcome: 'pass', signature: 'pass: reached the model call', detail }
  }

  if (input.code === 0) {
    return { outcome: 'pass', signature: 'pass: clean exit', detail }
  }

  return { outcome: 'fail', signature: `exit${String(input.code)}: ${failureLine(combined)}`, detail }
}

/**
 * Pick the line that actually describes an unrecognized crash.
 *
 * A plugin that throws while the host activates it can surface as a raw Node
 * stack dump rather than a named boot failure, and the tail of that dump is
 * punctuation. Prefer the chained cause, then the outermost error line, then
 * the plugin row the host was composing, and only then give up on the tail.
 * @param combined - merged stdout and stderr
 */
export function failureLine(combined: string): string {
  const cause = combined.match(/\[cause\]:\s*(?:[A-Za-z]*Error:\s*)?(.+)/)
  const error = combined.match(/^\s*(?:[A-Za-z]*Error):\s*(.+)$/m)
  const row = combined.match(/\/profiles\/[^/]+\/#([A-Za-z0-9@/._-]+)/)
  const lastLine = combined.trim().split('\n').filter(line => line.trim() !== '').slice(-1)[0] ?? ''
  const picked = cause?.[1] ?? error?.[1] ?? (row?.[1] === undefined ? undefined : `while composing ${row[1]}`) ?? lastLine
  return normalizeSignature(picked)
}

/** Watchdog-backed spawn: dsh has no hang protection of its own. */
function defaultSpawn(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; bin: string },
): Promise<BootSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(options.bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL') }, 5_000).unref?.()
    }, options.timeoutMs)
    timer.unref?.()
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

export interface BootProbeOptions {
  /** Plugin working tree to load. */
  workdir: string
  /** dsh version tag this probe runs against, recorded in the report. */
  dshTag?: string | undefined
  timeoutMs: number
  /** dsh binary to run; defaults to `DSH_BIN` or `dsh` on PATH. */
  bin?: string | undefined
  spawnImpl?: BootSpawn | undefined
  /** Scratch root; a temporary one is created and removed when omitted. */
  homeDir?: string | undefined
  /** dsh profile id inside the scratch home. */
  profile?: string | undefined
  /** Kept on disk for inspection (implies the caller cleans up). */
  keepHome?: boolean | undefined
}

/**
 * Build a scratch profile that mounts the plugin under test, without pnpm:
 * the plugin is symlinked into the profile's `node_modules` and named in its
 * bundle list, so Node resolution finds it exactly as an installed plugin.
 * @param home - scratch dsh home
 * @param profile - profile id inside that home
 * @param pluginName - package name of the plugin under test
 * @param bundles - bundle list; defaults to the headless probe composition
 */
export function writeProbeProfile(
  home: string,
  profile: string,
  pluginName: string,
  bundles: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', pluginName],
): void {
  const dir = join(home, 'profiles', profile)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-migrate-probe-${profile}`,
    private: true,
    type: 'module',
    dsh: { profile: { bundles } },
  }, null, 2)}\n`, 'utf8')
}

/**
 * Load the plugin into a scratch dsh home and boot the host under target.
 *
 * Keyless by construction: the model route points at a dead port, so a boot
 * that reaches the credential/connection check has already activated every
 * plugin, and the run costs nothing.
 * @param options - workdir, timeout, injectable spawn
 */
export async function bootProbe(options: BootProbeOptions): Promise<BootProbeResult> {
  const pluginName = readPackageName(options.workdir)
  if (pluginName === undefined) {
    return {
      outcome: 'fail',
      signature: 'load: package.json has no usable name',
      detail: `no package.json name in ${options.workdir}`,
    }
  }

  const profile = options.profile ?? 'probe'
  const ownHome = options.homeDir === undefined
  const home = options.homeDir ?? mkdtempSync(join(tmpdir(), 'dsh-migrate-probe-'))
  const spawnImpl = options.spawnImpl ?? defaultSpawn

  try {
    writeProbeProfile(home, profile, pluginName)
    const link = join(home, 'profiles', profile, 'node_modules', pluginName)
    // A scoped name needs its scope directory to exist before the link lands.
    mkdirSync(dirname(link), { recursive: true })
    if (!existsSync(link)) symlinkSync(options.workdir, link, 'dir')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: home,
      // Keyless: a placeholder key plus a dead endpoint. Reaching the model
      // call is the success signal, so no real credential is ever needed.
      DEEPSEEK_API_KEY: process.env.DSH_MIGRATE_PROBE_API_KEY ?? 'probe-placeholder-key',
      DEEPSEEK_BASE_URL: process.env.DSH_MIGRATE_PROBE_BASE_URL ?? 'http://127.0.0.1:9/v1',
      // dsh-base mounts an OTLP telemetry row by default; never emit from a probe.
      DSH_TELEMETRY_DISABLED: '1',
      DSH_MIGRATE_PROBE: '1',
    }

    const result = await spawnImpl(['--profile', profile, 'ping'], {
      cwd: options.workdir,
      env,
      timeoutMs: options.timeoutMs,
      bin: options.bin ?? process.env.DSH_BIN ?? 'dsh',
    })
    const classified = classifyBoot(result)
    return options.dshTag === undefined ? classified : { ...classified, dshVersion: options.dshTag }
  } finally {
    if (ownHome && options.keepHome !== true) {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // a leaked scratch dir must never fail a migration
      }
    }
  }
}
