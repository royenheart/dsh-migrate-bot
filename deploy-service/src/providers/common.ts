import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { classifyBoot } from '#action/verify/boot.js'
import { readJson } from '../files.ts'
import type { SpawnResult } from '../spawn.ts'
import type { BuildResult, InstanceSpec, RunningInstance } from './types.ts'

/** `preview-image/launcher.mjs`, found from this module whether it runs from `src/` or `dist/src/`. */
export const LAUNCHER = ((): string => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  for (const up of ['../..', '../../..']) {
    const candidate = join(here, up, 'preview-image', 'launcher.mjs')
    if (existsSync(candidate)) return candidate
  }
  return join(here, '../../../preview-image/launcher.mjs')
})()

/** How long a dependency install may take. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How long the boot check may take; the Action's default for its own boot check. */
export const CHECK_TIMEOUT_MS = 180_000
/** How long an instance may take to print both ready lines. */
export const START_TIMEOUT_MS = 120_000
/** The most output the install or the boot check may write. */
export const OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * Turn the install and boot check output into a build result.
 *
 * The boot check is the Action's own: `classifyBoot` from `src/verify/boot.ts`
 * decides, so a preview is promoted on exactly the evidence a migration
 * accepts.
 * @param install - the dependency install.
 * @param check - the boot check, absent when the install failed.
 */
export function buildResult(install: SpawnResult, check: SpawnResult | undefined): BuildResult {
  if (install.code !== 0 || check === undefined) {
    const why = install.error ?? (install.killed === undefined ? `exited ${String(install.code)}` : `was killed (${install.killed})`)
    return { ok: false, detail: `Installing the plugin ${why}: ${tail(`${install.stdout}\n${install.stderr}`)}` }
  }
  const verdict = classifyBoot({ code: check.code, stdout: check.stdout, stderr: check.stderr, timedOut: check.killed !== undefined })
  if (verdict.outcome === 'pass') return { ok: true, detail: `The boot check passed (${verdict.signature}).` }
  return { ok: false, detail: `The boot check did not pass (${verdict.outcome}): ${verdict.signature}` }
}

function tail(text: string): string {
  const lines = text.trim().split('\n').filter(line => line.trim() !== '')
  return lines.slice(-5).join(' | ').slice(-600)
}

const endpointSchema = z.object({ port: z.number().int().min(1).max(65535), token: z.string().min(1) })
const readySchema = z.object({ plugin: endpointSchema, safe: endpointSchema })

function isSocket(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSocket() === true
}

/**
 * Wait until `serve` has named its launch tokens and `forward` has created both
 * sockets, or give up.
 * @param spec - where the instance writes.
 * @param alive - whether the instance is still worth waiting for.
 */
export async function waitForReady(spec: InstanceSpec, alive: () => boolean): Promise<RunningInstance> {
  const deadline = Date.now() + START_TIMEOUT_MS
  const plugin = join(spec.socketDir, 'plugin.sock')
  const safe = join(spec.socketDir, 'safe.sock')
  while (Date.now() < deadline) {
    const ready = readJson(join(spec.stateDir, 'ready.json'), readySchema)
    if (ready !== undefined && isSocket(plugin) && isSocket(safe)) {
      return {
        url: { socketPath: plugin, authority: `127.0.0.1:${String(ready.plugin.port)}`, token: ready.plugin.token },
        safeUrl: { socketPath: safe, authority: `127.0.0.1:${String(ready.safe.port)}`, token: ready.safe.token },
      }
    }
    if (!alive()) throw new Error('the instance exited before it served')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`the instance did not serve within ${String(START_TIMEOUT_MS / 1000)} seconds`)
}
