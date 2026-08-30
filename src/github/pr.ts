import { spawnSync } from 'node:child_process'
import { githubGet } from './api.ts'
import { parseGithubRepo } from './publish.ts'

export type PullRequestMergeState = 'open' | 'merged' | 'closed' | 'missing'

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
  if (record.merged === true) return 'merged'
  if (record.state === 'open') return 'open'
  if (record.state === 'closed') return 'closed'
  return 'missing'
}
