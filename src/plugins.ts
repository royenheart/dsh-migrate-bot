import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIgnoredPath } from './git/worktree.ts'
import { inline } from './render/text.ts'

/**
 * The plugins of a consumer repository.
 *
 * A plugin is a directory whose `package.json` declares `dsh.bundle`, the
 * manifest dsh loads a plugin by. A repository is either one plugin at its
 * root or several in subdirectories; one migration covers all of them, so
 * the checks run on every plugin and one proposal carries every change.
 */

export interface Plugin {
  /** The directory relative to the repository root; `''` for the root. */
  dir: string
  /** The package name dsh mounts the plugin by. */
  name: string
  /** The parsed `package.json`. */
  manifest: Record<string, unknown>
}

function readManifest(dir: string): Record<string, unknown> | undefined {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function pluginAt(root: string, dir: string): Plugin | undefined {
  const manifest = readManifest(join(root, dir))
  const dsh = manifest?.dsh
  const isPlugin = typeof dsh === 'object' && dsh !== null && 'bundle' in dsh
  return manifest !== undefined && isPlugin && typeof manifest.name === 'string' && manifest.name !== '' ? { dir, name: manifest.name, manifest } : undefined
}

/**
 * Every plugin of a repository, in path order. The search does not enter a
 * plugin, `node_modules`, a directory whose name starts with a dot, or an
 * ignored path.
 */
export function findPlugins(root: string): Plugin[] {
  const found: Plugin[] = []
  const walk = (dir: string): void => {
    const plugin = pluginAt(root, dir)
    if (plugin !== undefined) {
      found.push(plugin)
      return
    }
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.') || isIgnoredPath(child)) continue
      walk(child)
    }
  }
  walk('')
  return found
}

/** The plugin names on one bounded line, for an issue, a summary or a prompt. */
export function pluginNames(root: string): string {
  return inline(findPlugins(root).map(plugin => plugin.name).join(', '), 200) || 'plugin'
}
