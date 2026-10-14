import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botEnv, git, gitOut } from '../git/run.ts'
import { logEntrySchema, type LogEntry } from '../workflow/model.ts'

/**
 * The state branch: the only durable store this Action has.
 *
 * `dsh-migrate/state` in the consumer repository holds one directory per
 * migration (`migrations/<version>/`) with its event log and the review reports
 * a later merge report quotes, plus `badge.json` for the README badge. The
 * branch is written with git plumbing and never checked out, so the plugin
 * working tree is untouched.
 *
 * Writers are serialised by the reusable workflow's concurrency group. A push
 * that still loses a race is rebuilt on the new tip when the other writer
 * touched none of this write's files, and is an error when it did.
 *
 * A checkout without an `origin` remote (a local run, a benchmark task
 * container) keeps the branch as a local ref and pushes nothing.
 */

export const STATE_BRANCH = 'dsh-migrate/state'
export const BADGE_FILE = 'badge.json'
const REMOTE = 'origin'
const REMOTE_REF = `refs/remotes/${REMOTE}/${STATE_BRANCH}`
const PUSH_ATTEMPTS = 3

export function logPath(migration: string): string {
  return `migrations/${migration}/events.jsonl`
}

export function migrationFile(migration: string, name: string): string {
  return `migrations/${migration}/${name}`
}

export interface StateSnapshot {
  /** The commit the snapshot was read from; absent when the branch does not exist yet. */
  tip: string | undefined
  /** Every migration log, by migration id. */
  logs: Map<string, LogEntry[]>
}

export type WriteResult =
  | { ok: true; commit: string | 'unchanged' }
  | { ok: false; reason: 'conflict' | 'push-failed'; detail: string }

export class StateLogError extends Error {
  override readonly name = 'StateLogError'
}

/** Parse one event log; a line that does not validate is an error, never skipped. */
export function parseLog(path: string, text: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new StateLogError(`${path}:${String(index + 1)} is not JSON: ${(error as Error).message}`)
    }
    const parsed = logEntrySchema.safeParse(raw)
    if (!parsed.success) throw new StateLogError(`${path}:${String(index + 1)} is not a log entry: ${parsed.error.message}`)
    entries.push(parsed.data)
  }
  return entries
}

export function serializeLog(entries: readonly LogEntry[]): string {
  return entries.map(entry => `${JSON.stringify(entry)}\n`).join('')
}

export class StateStore {
  /** Whether the branch lives on `origin`; otherwise it is a local ref. */
  private readonly remote: boolean
  /** The ref the branch is read from. */
  private readonly ref: string

  constructor(private readonly cwd: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.remote = git(['remote', 'get-url', REMOTE], { cwd }).status === 0
    this.ref = this.remote ? REMOTE_REF : `refs/heads/${STATE_BRANCH}`
  }

  private fetch(): string | undefined {
    if (this.remote) git(['fetch', '--quiet', REMOTE, `+refs/heads/${STATE_BRANCH}:${REMOTE_REF}`], { cwd: this.cwd })
    const tip = git(['rev-parse', '--verify', '--quiet', this.ref], { cwd: this.cwd })
    return tip.status === 0 ? tip.stdout.trim() : undefined
  }

  private files(tip: string): Map<string, string> {
    const listing = gitOut(['ls-tree', '-r', '--full-tree', tip], { cwd: this.cwd })
    const files = new Map<string, string>()
    for (const line of listing.split('\n')) {
      if (line === '') continue
      const [meta, path] = line.split('\t')
      const blob = meta?.split(' ')[2]
      if (path !== undefined && blob !== undefined) files.set(path, blob)
    }
    return files
  }

  /** Fetch the branch and read every migration log. */
  read(): StateSnapshot {
    const tip = this.fetch()
    const logs = new Map<string, LogEntry[]>()
    if (tip === undefined) return { tip, logs }
    for (const [path, blob] of this.files(tip)) {
      const parts = path.split('/')
      if (parts.length !== 3 || parts[0] !== 'migrations' || parts[2] !== 'events.jsonl') continue
      logs.set(parts[1] as string, parseLog(path, gitOut(['cat-file', 'blob', blob], { cwd: this.cwd })))
    }
    return { tip, logs }
  }

  /** Paths of the branch as last fetched, below a directory. */
  list(directory: string): string[] {
    const listed = git(['ls-tree', '-r', '--name-only', this.ref, '--', directory], { cwd: this.cwd })
    return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean) : []
  }

  /** One file of the branch as last fetched, or `undefined`. */
  readFile(path: string): string | undefined {
    const shown = git(['show', `${this.ref}:${path}`], { cwd: this.cwd })
    return shown.status === 0 ? shown.stdout : undefined
  }

  /**
   * Commit file contents on top of `base` and push.
   * @param base - the tip the caller read; its files are the ones the caller saw.
   * @param changes - repository-relative path to full content.
   * @param message - the commit subject.
   */
  write(base: string | undefined, changes: ReadonlyMap<string, string>, message: string): WriteResult {
    let parent = base
    for (let attempt = 1; ; attempt += 1) {
      const commit = this.commit(parent, changes, message)
      if (commit === undefined) return { ok: true, commit: 'unchanged' }
      if (!this.remote) {
        // A compare-and-swap on the local ref: it moves only from the tip this write was built on.
        const moved = git(['update-ref', this.ref, commit, parent ?? ''], { cwd: this.cwd })
        return moved.status === 0 ? { ok: true, commit } : { ok: false, reason: 'conflict', detail: moved.stderr.trim() }
      }
      const pushed = git(['push', '--quiet', REMOTE, `${commit}:refs/heads/${STATE_BRANCH}`], { cwd: this.cwd })
      if (pushed.status === 0) {
        gitOut(['update-ref', REMOTE_REF, commit], { cwd: this.cwd })
        return { ok: true, commit }
      }
      if (attempt >= PUSH_ATTEMPTS) return { ok: false, reason: 'push-failed', detail: pushed.stderr.trim() }
      const tip = this.fetch()
      if (tip === undefined || tip === parent) return { ok: false, reason: 'push-failed', detail: pushed.stderr.trim() }
      const touched = parent === undefined
        ? [...changes.keys()].filter(path => git(['cat-file', '-e', `${tip}:${path}`], { cwd: this.cwd }).status === 0)
        : gitOut(['diff', '--name-only', parent, tip, '--', ...changes.keys()], { cwd: this.cwd }).split('\n').filter(Boolean)
      const ownFiles = touched.filter(path => path !== BADGE_FILE)
      if (ownFiles.length > 0) {
        return { ok: false, reason: 'conflict', detail: `another writer changed ${ownFiles.join(', ')}` }
      }
      parent = tip
    }
  }

  /** Build the commit; `undefined` when it would not change the tree. */
  private commit(parent: string | undefined, changes: ReadonlyMap<string, string>, message: string): string | undefined {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-migrate-index-'))
    const env = { ...botEnv(this.env), GIT_INDEX_FILE: join(dir, 'index') }
    try {
      gitOut(parent === undefined ? ['read-tree', '--empty'] : ['read-tree', parent], { cwd: this.cwd, env })
      for (const [path, content] of changes) {
        const blob = gitOut(['hash-object', '-w', '--stdin'], { cwd: this.cwd, input: content })
        gitOut(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { cwd: this.cwd, env })
      }
      const tree = gitOut(['write-tree'], { cwd: this.cwd, env })
      if (parent !== undefined && gitOut(['rev-parse', `${parent}^{tree}`], { cwd: this.cwd }) === tree) return undefined
      return gitOut(['commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', message], { cwd: this.cwd, env })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
