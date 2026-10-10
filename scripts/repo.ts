/**
 * Shared repository scanning for the documentation gates.
 *
 * Every gate walks the same tree under the same exclusions, so the list lives
 * here once. Anything generated, vendored, or installed is excluded: a gate that
 * failed on `node_modules` or on upstream's own Markdown would be reporting on
 * somebody else's files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** Directory names never scanned, at any depth. */
export const EXCLUDED_DIRS = new Set([
  '.bench',
  '.git',
  '.dsh-migrate',
  '.venv',
  'dist',
  'node_modules',
  'vendor',
])

/**
 * Walk up from a starting directory to the repository root, identified by the
 * package manifest plus the commitizen config. Resolving from the module's own
 * location rather than the cwd keeps the gates correct when they run from
 * `dist/scripts/` after a build and from `scripts/` when run directly.
 * @param start - directory to start from.
 * @returns the absolute repository root.
 */
function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.cz.toml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`repository root not found above ${start}`)
    dir = parent
  }
}

/** Repository root, derived from this file's location rather than the cwd. */
export const REPO_ROOT = findRepoRoot(import.meta.dirname)

/**
 * List repository files whose extension is in `extensions`, skipping excluded
 * directories.
 * @param extensions - extensions to keep, each including the dot (`.md`).
 * @param root - directory to walk; defaults to the repository root.
 * @returns absolute paths, in stable sorted order.
 */
export function repoFiles(extensions: readonly string[], root: string = REPO_ROOT): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (extensions.some(extension => entry.name.endsWith(extension))) found.push(join(dir, entry.name))
    }
  }
  walk(root)
  return found
}

/**
 * Read a file as UTF-8 text.
 * @param path - absolute path.
 * @returns the file's contents.
 */
export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * True when `path` is an existing regular file.
 * @param path - absolute path.
 * @returns whether the path names a file.
 */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Render a path relative to the repository root, for gate output.
 * @param path - an absolute path.
 * @returns the repository-relative path.
 */
export function rel(path: string): string {
  return relative(REPO_ROOT, path)
}
