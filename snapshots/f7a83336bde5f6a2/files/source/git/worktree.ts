import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, gitOut } from './run.ts'

/**
 * The plugin working tree the migration edits.
 *
 * Four paths live in it without ever being part of a migration: this Action's
 * own run directory, a local secrets file, the harness Agent Notes tree, which
 * the prompts forbid the agent to write and which is ignored here so that rule
 * does not depend on the model obeying it, and `node_modules/`, which the checks
 * install. In `.git/info/exclude` a directory pattern matches at any depth;
 * files already tracked stay tracked.
 */
export const IGNORED_PATHS = ['.dsh-migrate/', '.secrets.local.json', '.agents/notes/', 'node_modules/'] as const

/** Whether a repository-relative path is one of the ignored paths. */
export function isIgnoredPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  return IGNORED_PATHS.some(ignored => ignored.endsWith('/')
    ? normalized === ignored.slice(0, -1) || normalized.startsWith(ignored)
    : normalized === ignored)
}

/** Add the ignored paths to `.git/info/exclude`, so git never reports them. */
export function excludeIgnoredPaths(cwd: string): void {
  const dotGit = join(cwd, '.git')
  if (!existsSync(dotGit) || !statSync(dotGit).isDirectory()) return
  const exclude = join(dotGit, 'info', 'exclude')
  mkdirSync(join(dotGit, 'info'), { recursive: true })
  const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  const present = new Set(existing.split('\n').map(line => line.trim()))
  const missing = IGNORED_PATHS.filter(path => !present.has(path))
  if (missing.length === 0) return
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  writeFileSync(exclude, `${existing}${separator}${missing.join('\n')}\n`)
}

/** Paths that differ from `HEAD`, ignored paths left out. */
export function changedPaths(cwd: string): string[] {
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd })
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`)
  const paths: string[] = []
  // Not trimmed: the first column of an entry may be a space.
  const entries = status.stdout.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? ''
    if (entry.length < 4) continue
    // A rename is followed by its source path, which is not a second change.
    if (entry[0] === 'R' || entry[0] === 'C') index += 1
    const path = entry.slice(3)
    if (!isIgnoredPath(path)) paths.push(path)
  }
  return paths
}

/** Whether the tree differs from `HEAD` outside the ignored paths. */
export function isTreeChanged(cwd: string): boolean {
  return changedPaths(cwd).length > 0
}

/**
 * Stage every change except the ignored paths.
 *
 * The ignored paths are never named in the pathspec: git refuses an explicit
 * path that `.git/info/exclude` ignores, so they are staged and then reset.
 */
export function stageChanges(cwd: string): void {
  gitOut(['add', '-A', '--', '.'], { cwd })
  const staged = gitOut(['diff', '--cached', '--name-only', '-z'], { cwd }).split('\0').filter(Boolean)
  const ignored = staged.filter(isIgnoredPath)
  if (ignored.length > 0) gitOut(['reset', '-q', '--', ...ignored], { cwd })
}

/** The working tree's diff against `HEAD`, ignored paths left out. */
export function treeDiff(cwd: string): string {
  return gitOut(['diff', 'HEAD', '--', '.', ...IGNORED_PATHS.map(path => `:!${path.replace(/\/$/, '')}`)], { cwd })
}

/**
 * The consumer's default branch: `origin/HEAD` when the checkout has it, the
 * branch the checkout is on otherwise.
 */
export function defaultBranch(cwd: string): string {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd })
  if (head.status === 0 && head.stdout.trim() !== '') return head.stdout.trim().replace(/^origin\//, '')
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
}

/**
 * Put the tree back to `HEAD`: tracked files restored, untracked ones removed,
 * ignored paths kept. Only for a tree that has no change of its own yet.
 */
export function discardChanges(cwd: string): void {
  gitOut(['checkout', '--', '.'], { cwd })
  gitOut(['clean', '--force', '-d', '--quiet'], { cwd })
}
