import { spawnSync } from 'node:child_process'
import { githubGet } from './api.ts'
import { parseGithubRepo } from './publish.ts'

export type PullRequestMergeState = 'open' | 'merged' | 'closed' | 'missing'

/** The pull request fields a feedback run reports on. */
export interface PullRequestDetail {
  state: PullRequestMergeState
  number: number
  url: string
  title: string
  body: string
  mergedAt?: string | undefined
  mergedBy?: string | undefined
  mergeCommitSha?: string | undefined
  headSha?: string | undefined
  author?: string | undefined
  headRef?: string | undefined
  /**
   * `owner/name` of the repository the head branch lives in.
   *
   * Equal to the base repository for every pull request this Action opens, and
   * different for a fork — which is what tells a caller that pushing to
   * `headRef` would write to the wrong repository.
   */
  headRepo?: string | undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function mergeStateOf(record: { state?: unknown; merged?: unknown }): PullRequestMergeState {
  if (record.merged === true) return 'merged'
  if (record.state === 'open') return 'open'
  if (record.state === 'closed') return 'closed'
  return 'missing'
}

/**
 * Read one pull request, including the merge fields the verification signal
 * alone does not need but a feedback report does.
 *
 * A 404 is `missing` rather than an error: the state reconciler treats a
 * deleted pull request exactly like an unmerged close.
 * @param input.token - a token that can read `input.owner`/`input.repo`.
 * @param input.number - pull request number.
 * @param input.fetchImpl - injectable fetch.
 */
export async function fetchPullRequestDetail(input: {
  token: string
  owner: string
  repo: string
  number: number
  fetchImpl?: typeof fetch
}): Promise<PullRequestDetail | undefined> {
  const result = await githubGet(
    input.token,
    `/repos/${input.owner}/${input.repo}/pulls/${input.number}`,
    input.fetchImpl ?? fetch,
  )
  if (!result.ok) {
    if (result.status === 404) return undefined
    throw new Error(`GitHub GET pull/${String(input.number)} failed: ${String(result.status)} ${result.detail}`)
  }
  if (typeof result.body !== 'object' || result.body === null) return undefined
  const record = result.body as Record<string, unknown>
  const user = typeof record.user === 'object' && record.user !== null
    ? (record.user as { login?: unknown }).login
    : undefined
  const mergedBy = typeof record.merged_by === 'object' && record.merged_by !== null
    ? (record.merged_by as { login?: unknown }).login
    : undefined
  const head = typeof record.head === 'object' && record.head !== null
    ? (record.head as { sha?: unknown; ref?: unknown })
    : undefined
  return {
    state: mergeStateOf(record),
    number: typeof record.number === 'number' ? record.number : input.number,
    url: asString(record.html_url) ?? `https://github.com/${input.owner}/${input.repo}/pull/${String(input.number)}`,
    title: asString(record.title) ?? '',
    body: typeof record.body === 'string' ? record.body : '',
    ...(asString(record.merged_at) === undefined ? {} : { mergedAt: asString(record.merged_at) as string }),
    ...(asString(mergedBy) === undefined ? {} : { mergedBy: asString(mergedBy) as string }),
    ...(asString(record.merge_commit_sha) === undefined ? {} : { mergeCommitSha: asString(record.merge_commit_sha) as string }),
    ...(asString(head?.sha) === undefined ? {} : { headSha: asString(head?.sha) as string }),
    ...(asString(user) === undefined ? {} : { author: asString(user) as string }),
    ...(asString(head?.ref) === undefined ? {} : { headRef: asString(head?.ref) as string }),
    ...(asStringRepoNamespace(head) === undefined ? {} : { headRepo: asStringRepoNamespace(head) as string }),
  }
}

/** `head.repo.full_name`, when the API included it. */
function asStringRepoNamespace(head: unknown): string | undefined {
  if (typeof head !== 'object' || head === null) return undefined
  const full = (head as { repo?: { full_name?: unknown } }).repo?.full_name
  return asString(full)
}

export function parsePullRequestNumber(url: string | undefined): number | undefined {
  if (url === undefined || url === '') return undefined
  const match = url.match(/\/pull\/(\d+)(?:\/|$|\?)/)
  if (match?.[1] === undefined) return undefined
  const n = Number(match[1])
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export function resolveRepo(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { owner: string; repo: string } {
  const origin = spawnSync('git', ['-c', 'safe.directory=*', 'remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
  })
  return parseGithubRepo(origin.status === 0 ? origin.stdout.trim() : '', env)
}

/**
 * `merged` is the verification signal. A closed-but-unmerged PR is `closed`.
 * 404 is `missing` (treat like unmerged close). Other HTTP errors throw.
 */
export async function fetchPullRequestState(input: {
  token: string
  owner: string
  repo: string
  pr: number
  fetchImpl?: typeof fetch
}): Promise<PullRequestMergeState> {
  const result = await githubGet(
    input.token,
    `/repos/${input.owner}/${input.repo}/pulls/${input.pr}`,
    input.fetchImpl ?? fetch,
  )
  if (!result.ok) {
    if (result.status === 404) return 'missing'
    throw new Error(`GitHub GET pull/${input.pr} failed: ${result.status} ${result.detail}`)
  }
  if (typeof result.body !== 'object' || result.body === null) return 'missing'
  const record = result.body as { state?: unknown; merged?: unknown }
  return mergeStateOf(record)
}
