import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type { ResolvedVersion } from './dsh-version.ts'
import { badgeFromSeenState, serializeBadge, type ShieldsEndpoint } from './badge.ts'
import type { PullRequestMergeState } from '../github/pr.ts'

/** Branch in the *consumer* plugin repo. Only this Action writes it. */
export const STATE_BRANCH = 'dsh-migrate/state'
export const STATE_FILE = 'seen.json'
export const BADGE_FILE = 'badge.json'

const GIT_SAFE = ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false'] as const
const BOT_NAME = 'dsh-migrate[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

export interface VersionRef {
  tag: string
  version: string
}

export interface PendingMigration extends VersionRef {
  pr: number
  prUrl?: string
}

export interface SeenState {
  /** Last processed dsh version (watch cursor). */
  tag: string
  version: string
  recordedAt: string
  /** Default-branch support: compatible run, or a merged migrate PR. */
  verified?: VersionRef
  /** Open migrate PR that has not been accepted yet. */
  pending?: PendingMigration
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

function parseVersionRef(raw: unknown): VersionRef | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.tag !== 'string' || record.tag.trim() === '') return undefined
  if (typeof record.version !== 'string' || record.version.trim() === '') return undefined
  return { tag: record.tag, version: record.version }
}

function parsePending(raw: unknown): PendingMigration | undefined {
  const base = parseVersionRef(raw)
  if (base === undefined || typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.pr !== 'number' || !Number.isInteger(record.pr) || record.pr <= 0) return undefined
  const pending: PendingMigration = { tag: base.tag, version: base.version, pr: record.pr }
  if (typeof record.prUrl === 'string' && record.prUrl.trim() !== '') pending.prUrl = record.prUrl
  return pending
}

/**
 * Parse the JSON blob stored on the state branch. Invalid payloads are treated
 * as missing so a corrupt file retriggers a run (first-run semantics).
 * Unknown / invalid `verified` and `pending` fields are dropped, not the blob.
 */
export function parseSeenState(text: string): SeenState | undefined {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    if (typeof record.tag !== 'string' || record.tag.trim() === '') return undefined
    if (typeof record.version !== 'string' || record.version.trim() === '') return undefined
    const state: SeenState = {
      tag: record.tag,
      version: record.version,
      recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : '',
    }
    const verified = parseVersionRef(record.verified)
    if (verified !== undefined) state.verified = verified
    const pending = parsePending(record.pending)
    if (pending !== undefined) state.pending = pending
    return state
  } catch {
    return undefined
  }
}

export function serializeSeenState(state: SeenState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

export function seenStateFingerprint(state: SeenState | undefined): string {
  if (state === undefined) return ''
  return JSON.stringify({
    tag: state.tag,
    version: state.version,
    verified: state.verified ?? null,
    pending: state.pending === undefined
      ? null
      : { tag: state.pending.tag, version: state.pending.version, pr: state.pending.pr },
  })
}

/**
 * Watch cursor vs default-branch verification.
 * `compatible` verifies immediately. `migrated` records a pending PR when one
 * was opened. `failed` / `skipped` leave the previous blob untouched.
 */
export function applyRunToSeenState(
  previous: SeenState | undefined,
  input: {
    target: ResolvedVersion
    status: 'compatible' | 'migrated' | 'failed' | 'skipped'
    pullRequest?: { number: number; url?: string }
    now?: Date
  },
): SeenState | undefined {
  if (input.status === 'failed' || input.status === 'skipped') return previous
  const recordedAt = (input.now ?? new Date()).toISOString()
  const next: SeenState = {
    tag: input.target.tag,
    version: input.target.version,
    recordedAt,
    ...(previous?.verified === undefined ? {} : { verified: previous.verified }),
    ...(previous?.pending === undefined ? {} : { pending: previous.pending }),
  }
  if (input.status === 'compatible') {
    next.verified = { tag: input.target.tag, version: input.target.version }
    delete next.pending
    return next
  }
  if (input.pullRequest !== undefined) {
    next.pending = {
      tag: input.target.tag,
      version: input.target.version,
      pr: input.pullRequest.number,
      ...(input.pullRequest.url === undefined ? {} : { prUrl: input.pullRequest.url }),
    }
  }
  return next
}

/**
 * Apply the stored pending PR's merge state. `merged` promotes it to verified.
 * `closed` / `missing` drop the pending row and keep the last verified version.
 */
export function applyPullRequestToSeenState(
  state: SeenState,
  prState: PullRequestMergeState,
): SeenState {
  if (state.pending === undefined) return state
  if (prState === 'open') return state
  if (prState === 'merged') {
    const { pending, ...rest } = state
    return {
      ...rest,
      verified: { tag: pending.tag, version: pending.version },
    }
  }
  const { pending: _dropped, ...rest } = state
  return rest
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

export function readStateFile(cwd: string, file: string, remote = 'origin'): string | undefined {
  if (!isGitRepo(cwd) || !hasRemote(cwd, remote)) return undefined
  fetchStateRef(cwd, remote)
  const shown = git(cwd, ['show', `${remoteRef(remote)}:${file}`])
  if (shown.status !== 0) return undefined
  return shown.stdout
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

function hashBlob(cwd: string, content: string): { ok: true; blob: string } | { ok: false; detail: string } {
  const hashed = git(cwd, ['hash-object', '-w', '--stdin'], { input: content })
  if (hashed.status !== 0 || hashed.stdout.trim() === '') {
    return { ok: false, detail: hashed.stderr || 'hash-object failed' }
  }
  return { ok: true, blob: hashed.stdout.trim() }
}

/**
 * Commit files onto `dsh-migrate/state` via git objects and push. Replaces the
 * branch tree with exactly these files. Never checks out that branch.
 */
export function persistStateBranch(
  cwd: string,
  files: { seen?: SeenState; badge: ShieldsEndpoint },
  options: { remote?: string; env?: NodeJS.ProcessEnv; message?: string } = {},
): PersistResult {
  const remote = options.remote ?? 'origin'
  if (!isGitRepo(cwd)) return { ok: false, reason: 'no-git', detail: 'not a git repository' }
  if (!hasRemote(cwd, remote)) return { ok: false, reason: 'no-remote', detail: `no remote ${remote}` }

  fetchStateRef(cwd, remote)
  const parentResult = git(cwd, ['rev-parse', '--verify', remoteRef(remote)])
  const parent = parentResult.status === 0 ? parentResult.stdout.trim() : undefined

  const entries: { name: string; content: string }[] = [
    { name: BADGE_FILE, content: serializeBadge(files.badge) },
  ]
  if (files.seen !== undefined) {
    entries.push({ name: STATE_FILE, content: serializeSeenState(files.seen) })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const lines: string[] = []
  for (const entry of entries) {
    const hashed = hashBlob(cwd, entry.content)
    if (!hashed.ok) return { ok: false, reason: 'git-failed', detail: hashed.detail }
    lines.push(`100644 blob ${hashed.blob}\t${entry.name}`)
  }
  const treed = git(cwd, ['mktree'], { input: `${lines.join('\n')}\n` })
  if (treed.status !== 0 || treed.stdout.trim() === '') {
    return { ok: false, reason: 'git-failed', detail: treed.stderr || 'mktree failed' }
  }
  const tree = treed.stdout.trim()
  const message = options.message
    ?? (files.seen === undefined ? 'dsh-migrate: refresh badge' : `dsh-migrate: record ${files.seen.tag}`)
  const commitArgs = ['commit-tree', tree, '-m', message]
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

/**
 * Commit `seen.json` + `badge.json` onto `dsh-migrate/state`.
 */
export function persistSeenState(
  cwd: string,
  state: SeenState,
  options: { remote?: string; env?: NodeJS.ProcessEnv; message?: string } = {},
): PersistResult {
  return persistStateBranch(cwd, { seen: state, badge: badgeFromSeenState(state) }, options)
}

export function stateFilesNeedWrite(
  cwd: string,
  files: { seen?: SeenState; badge: ShieldsEndpoint },
  remote = 'origin',
): boolean {
  if (!isGitRepo(cwd) || !hasRemote(cwd, remote)) return true
  fetchStateRef(cwd, remote)
  const wanted: Record<string, string> = {
    [BADGE_FILE]: serializeBadge(files.badge),
  }
  if (files.seen !== undefined) wanted[STATE_FILE] = serializeSeenState(files.seen)
  for (const [name, content] of Object.entries(wanted)) {
    const shown = git(cwd, ['show', `${remoteRef(remote)}:${name}`])
    if (shown.status !== 0 || shown.stdout !== content) return true
  }
  if (files.seen === undefined) {
    const leftover = git(cwd, ['show', `${remoteRef(remote)}:${STATE_FILE}`])
    if (leftover.status === 0) return true
  }
  return false
}
