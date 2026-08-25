import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { join } from 'node:path'

const GIT_SAFE = ['-c', 'safe.directory=*'] as const

function git(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync('git', [...GIT_SAFE, ...args], { cwd, encoding: 'utf8' })
}

/**
 * Paths that live in the plugin worktree for convenience (reports, local
 * secrets) but must not count as a dirty migration or be committed.
 */
export function isMigrateNoisePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  const file = normalized.includes(' -> ')
    ? normalized.slice(normalized.lastIndexOf(' -> ') + 4).trim()
    : normalized
  return file === '.dsh-migrate'
    || file.startsWith('.dsh-migrate/')
    || file === '.secrets.local.json'
}

function porcelainPath(line: string): string {
  return line.slice(3).trim()
}

function gitDir(cwd: string): string | undefined {
  const dotGit = join(cwd, '.git')
  if (!existsSync(dotGit)) return undefined
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Ignore `.dsh-migrate/` in this clone without committing a `.gitignore`.
 * Reports stay on disk for Action artifacts.
 */
export function ensureMigrateGitExclude(cwd: string): void {
  const dir = gitDir(cwd)
  if (dir === undefined) return
  const info = join(dir, 'info')
  mkdirSync(info, { recursive: true })
  const exclude = join(info, 'exclude')
  const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  const lines = existing.split(/\r?\n/)
  const additions: string[] = []
  if (!lines.some(line => line.trim() === '.dsh-migrate/')) additions.push('.dsh-migrate/')
  if (!lines.some(line => line.trim() === '.secrets.local.json')) additions.push('.secrets.local.json')
  if (additions.length === 0) return
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
  writeFileSync(exclude, `${existing}${prefix}${additions.join('\n')}\n`, 'utf8')
}

/**
 * True when the working tree or index differs from HEAD, ignoring migrate noise.
 * @param cwd - git repository root
 */
export function isWorktreeDirty(cwd: string): boolean {
  const result = git(['status', '--porcelain'], cwd)
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr}`)
  }
  return result.stdout.split(/\r?\n/).some(line => {
    if (line.trim() === '') return false
    return !isMigrateNoisePath(porcelainPath(line))
  })
}

/**
 * `git diff` text for the Issue/PR body. Empty when clean.
 * @param cwd - git repository root
 */
export function worktreeDiff(cwd: string): string {
  const result = git(['diff', 'HEAD', '--', '.', ':!.dsh-migrate', ':!.secrets.local.json'], cwd)
  if (result.status !== 0) {
    throw new Error(`git diff failed: ${result.stderr}`)
  }
  return result.stdout
}
