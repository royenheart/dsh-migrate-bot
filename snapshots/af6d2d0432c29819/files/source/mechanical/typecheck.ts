import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Last-resort compiler: the `typescript` package, never the npm package named `tsc`. */
export const NPX_TYPESCRIPT_TSC = 'npx --yes --package typescript tsc --noEmit'

/**
 * Shell-safe argv token. JSON string quoting is valid in POSIX `shell: true`.
 */
export function quoteShellArg(value: string): string {
  return JSON.stringify(value)
}

/**
 * Prefer the plugin's own `tsc`, then the migrator's bundled TypeScript,
 * walking up from `searchFrom` (typically this module's compiled file).
 */
export function findTscBin(pluginRoot: string, searchFrom: string): string | undefined {
  const pluginBin = join(pluginRoot, 'node_modules', '.bin', 'tsc')
  if (existsSync(pluginBin)) return pluginBin
  let dir = dirname(searchFrom)
  for (let i = 0; i < 10; i += 1) {
    const bin = join(dir, 'node_modules', '.bin', 'tsc')
    if (existsSync(bin)) return bin
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Default mechanical typecheck. Never `npx tsc`, which downloads the unrelated
 * placeholder package `tsc` when no local binary exists.
 */
export function typecheckCommand(pluginRoot: string, searchFrom: string): string {
  const bin = findTscBin(pluginRoot, searchFrom)
  if (bin === undefined) return NPX_TYPESCRIPT_TSC
  return `${quoteShellArg(bin)} --noEmit`
}
