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

function npmInstall(prefix: string, version: string, timeoutMs: number): { ok: boolean; detail: string } {
  const result = spawnSync(
    'npm',
    ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', `@deepseek-ai/dsh@${version}`],
    { encoding: 'utf8', timeout: timeoutMs, env: process.env },
  )
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
