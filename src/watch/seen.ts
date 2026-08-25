import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type { ResolvedVersion } from './dsh-version.ts'

/** Branch in the *consumer* plugin repo. Only this Action writes it. */
export const STATE_BRANCH = 'dsh-migrate/state'
export const STATE_FILE = 'seen.json'

const GIT_SAFE = ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false'] as const
const BOT_NAME = 'dsh-migrate[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

export interface SeenState {
  tag: string
  version: string
  recordedAt: string
}

export type PersistFailureReason = 'no-git' | 'no-remote' | 'push-failed' | 'git-failed'

export type PersistResult =
  | { ok: true; commit: string }
  | { ok: false; reason: PersistFailureReason; detail: string }

function git(
  cwd: string,
  args: readonly string[],
  extra: { input?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<string> {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd,
    encoding: 'utf8',
    ...(extra.input === undefined ? {} : { input: extra.input }),
    env: extra.env,
  })
}

function remoteRef(remote: string): string {
  return `refs/remotes/${remote}/${STATE_BRANCH}`
}

/**
 * Parse the JSON blob stored on the state branch. Invalid payloads are treated
 * as missing so a corrupt file retriggers a run (first-run semantics).
 */
export function parseSeenState(text: string): SeenState | undefined {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    if (typeof record.tag !== 'string' || record.tag.trim() === '') return undefined
    if (typeof record.version !== 'string' || record.version.trim() === '') return undefined
    return {
      tag: record.tag,
      version: record.version,
      recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : '',
    }
  } catch {
    return undefined
  }
}

export function serializeSeenState(state: SeenState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).status === 0
}

function hasRemote(cwd: string, remote: string): boolean {
  return git(cwd, ['remote', 'get-url', remote]).status === 0
}

function fetchStateRef(cwd: string, remote: string): boolean {
  const spec = `+refs/heads/${STATE_BRANCH}:${remoteRef(remote)}`
  return git(cwd, ['fetch', remote, spec]).status === 0
}

/**
 * Read the last processed dsh version from `origin/dsh-migrate/state`.
 * Missing branch, missing file, or invalid JSON → `undefined` (first run).
 * Does not check out the branch; the plugin worktree is untouched.
 */
export function readSeenState(cwd: string, remote = 'origin'): SeenState | undefined {
  if (!isGitRepo(cwd) || !hasRemote(cwd, remote)) return undefined
  fetchStateRef(cwd, remote)
  const shown = git(cwd, ['show', `${remoteRef(remote)}:${STATE_FILE}`])
  if (shown.status !== 0) return undefined
  return parseSeenState(shown.stdout)
}

function authorEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_AUTHOR_NAME: base.GIT_AUTHOR_NAME ?? BOT_NAME,
    GIT_AUTHOR_EMAIL: base.GIT_AUTHOR_EMAIL ?? BOT_EMAIL,
    GIT_COMMITTER_NAME: base.GIT_COMMITTER_NAME ?? BOT_NAME,
    GIT_COMMITTER_EMAIL: base.GIT_COMMITTER_EMAIL ?? BOT_EMAIL,
  }
}

/**
 * Commit `seen.json` onto `dsh-migrate/state` via git objects (hash-object /
 * mktree / commit-tree) and push. Never checks out that branch, so user files
 * on the default branch stay unmodified.
 */
export function persistSeenState(
  cwd: string,
  current: ResolvedVersion,
  options: { remote?: string; now?: Date; env?: NodeJS.ProcessEnv } = {},
): PersistResult {
  const remote = options.remote ?? 'origin'
  if (!isGitRepo(cwd)) return { ok: false, reason: 'no-git', detail: 'not a git repository' }
  if (!hasRemote(cwd, remote)) return { ok: false, reason: 'no-remote', detail: `no remote ${remote}` }

  fetchStateRef(cwd, remote)
  const parentResult = git(cwd, ['rev-parse', '--verify', remoteRef(remote)])
  const parent = parentResult.status === 0 ? parentResult.stdout.trim() : undefined

  const payload = serializeSeenState({
    tag: current.tag,
    version: current.version,
    recordedAt: (options.now ?? new Date()).toISOString(),
  })
  const hashed = git(cwd, ['hash-object', '-w', '--stdin'], { input: payload })
  if (hashed.status !== 0 || hashed.stdout.trim() === '') {
    return { ok: false, reason: 'git-failed', detail: hashed.stderr || 'hash-object failed' }
  }
  const blob = hashed.stdout.trim()
  const treeIn = `100644 blob ${blob}\t${STATE_FILE}\n`
  const treed = git(cwd, ['mktree'], { input: treeIn })
  if (treed.status !== 0 || treed.stdout.trim() === '') {
    return { ok: false, reason: 'git-failed', detail: treed.stderr || 'mktree failed' }
  }
  const tree = treed.stdout.trim()
  const commitArgs = ['commit-tree', tree, '-m', `dsh-migrate: record ${current.tag}`]
  if (parent !== undefined && parent !== '') commitArgs.push('-p', parent)
  const committed = git(cwd, commitArgs, { env: authorEnv(options.env ?? process.env) })
  if (committed.status !== 0 || committed.stdout.trim() === '') {
    return { ok: false, reason: 'git-failed', detail: committed.stderr || 'commit-tree failed' }
  }
  const commit = committed.stdout.trim()
  const pushed = git(cwd, ['push', remote, `${commit}:refs/heads/${STATE_BRANCH}`])
  if (pushed.status !== 0) {
    return { ok: false, reason: 'push-failed', detail: pushed.stderr || pushed.stdout }
  }
  return { ok: true, commit }
}
