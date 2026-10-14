import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The probe has to run against the tag it is verifying, not whatever the image
 * happens to ship, so each version gets its own cached global prefix. Installing
 * the harness closure is slow on a cold cache, which is why the prefix is kept
 * under the run home and reused across runs.
 */

export interface InstalledDsh {
  ok: boolean
  bin?: string
  detail: string
}

export interface DshInstallOptions {
  /** Install watchdog. */
  timeoutMs?: number
  /** Injectable installer, so the caching and failure paths are testable. */
  install?: ((prefix: string, version: string) => { ok: boolean; detail: string }) | undefined
}

/**
 * The npm arguments that install a release with the dependencies it was
 * published with: `--before` excludes every version published from the next
 * release on, so a later release of a transitive dependency cannot change it.
 * A fresh install of an older release otherwise resolves today's Cordis and
 * fails to boot for reasons the plugin has nothing to do with.
 * @param before - the release's cutoff ({@link releaseCutoff}); none for the newest release.
 */
export function installArgs(prefix: string, version: string, before: string | undefined): string[] {
  return ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', ...(before === undefined ? [] : ['--before', before]), `@deepseek-ai/dsh@${version}`]
}

/**
 * The `--before` date of a release: the moment before the next release of dsh
 * was published. A release's own packages appear over hours (one of
 * 0.2.0-rc.2's came 80 minutes after dsh itself), so the cutoff is not a fixed
 * window after it; what it must exclude is the next release, whose packages a
 * prerelease's `^` ranges would otherwise resolve to. The newest release has
 * no cutoff.
 * @param times - `npm view @deepseek-ai/dsh time`: publication time by version
 */
export function releaseCutoff(times: Readonly<Record<string, string>>, version: string): string | undefined {
  const published = times[version]
  if (published === undefined) return undefined
  const next = Object.entries(times)
    .filter(([key, at]) => /^\d/.test(key) && Date.parse(at) > Date.parse(published))
    .map(([, at]) => Date.parse(at))
    .sort((a, b) => a - b)[0]
  return next === undefined ? undefined : new Date(next - 1000).toISOString()
}

/** When each release of dsh was published, from the npm registry, or `undefined` when it does not say. */
export function releaseTimes(timeoutMs: number): Record<string, string> | undefined {
  const result = spawnSync('npm', ['view', '@deepseek-ai/dsh', 'time', '--json'], { encoding: 'utf8', timeout: timeoutMs, env: process.env })
  if (result.status !== 0) return undefined
  try {
    const times = JSON.parse(result.stdout) as Record<string, unknown>
    return Object.fromEntries(Object.entries(times).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return undefined
  }
}

function npmInstall(prefix: string, version: string, timeoutMs: number): { ok: boolean; detail: string } {
  const times = releaseTimes(timeoutMs)
  if (times?.[version] === undefined) return { ok: false, detail: `the npm registry did not say when @deepseek-ai/dsh@${version} was published` }
  const result = spawnSync('npm', installArgs(prefix, version, releaseCutoff(times, version)), { encoding: 'utf8', timeout: timeoutMs, env: process.env })
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-2000)
    return { ok: false, detail: detail === '' ? `npm install exited ${String(result.status)}` : detail }
  }
  return { ok: true, detail: `installed ${version} at ${prefix}` }
}

function binPath(prefix: string): string {
  return join(prefix, 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
}

/**
 * Ensure a `dsh` binary for one harness version, installing it when missing.
 * @param version - harness version without the `dsh-v` prefix
 * @param cacheRoot - directory holding one global prefix per version
 * @param timeoutMs - install watchdog
 */
export function ensureDsh(version: string, cacheRoot: string, options: DshInstallOptions = {}): InstalledDsh {
  const prefix = join(cacheRoot, `dsh-${version.replace(/[^0-9A-Za-z.-]+/g, '-')}`)
  const bin = binPath(prefix)
  if (existsSync(bin)) return { ok: true, bin, detail: `cached at ${prefix}` }

  const install = options.install ?? ((target: string, requested: string) => npmInstall(target, requested, options.timeoutMs ?? 600_000))
  const result = install(prefix, version)
  if (!result.ok) return { ok: false, detail: result.detail }
  if (!existsSync(bin)) return { ok: false, detail: `installed ${version} but ${bin} is missing` }
  return { ok: true, bin, detail: result.detail }
}
