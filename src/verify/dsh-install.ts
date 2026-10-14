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

/** How long a release's packages take to appear around dsh's own: up to 80 minutes was seen (0.2.0-rc.2). */
const RELEASE_SPREAD_MS = 2 * 60 * 60 * 1000

/**
 * The `--before` date of a release. Until 0.1.7-alpha.2 a release's packages
 * declare `^` ranges on each other, which npm satisfies with a later
 * prerelease of the same \`major.minor.patch\` and with nothing of another; so
 * the cutoff is set before the next prerelease of the same line, by the time a
 * release takes to publish, since its first packages appear before dsh's own.
 * A release with no later prerelease of its line needs no cutoff.
 * @param times - `npm view @deepseek-ai/dsh time`: publication time by version
 */
export function releaseCutoff(times: Readonly<Record<string, string>>, version: string): string | undefined {
  const published = times[version]
  const line = version.split('-')[0]
  if (published === undefined) return undefined
  const next = Object.entries(times)
    .filter(([key, at]) => key.split('-')[0] === line && Date.parse(at) > Date.parse(published))
    .map(([, at]) => Date.parse(at))
    .sort((a, b) => a - b)[0]
  return next === undefined ? undefined : new Date(next - RELEASE_SPREAD_MS).toISOString()
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
