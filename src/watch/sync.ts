import { badgeFromSeenState } from './badge.ts'
import {
  applyPullRequestToSeenState,
  persistStateBranch,
  stateFilesNeedWrite,
  type PersistResult,
  type SeenState,
} from './seen.ts'
import { fetchPullRequestState, parsePullRequestNumber, resolveRepo } from '../github/pr.ts'
import type { PublishResult } from '../pipeline/types.ts'

export function publishedPullRequest(
  published: PublishResult,
): { number: number; url?: string } | undefined {
  const number = published.pullRequestNumber ?? parsePullRequestNumber(published.pullRequestUrl)
  if (number === undefined) return undefined
  return {
    number,
    ...(published.pullRequestUrl === undefined ? {} : { url: published.pullRequestUrl }),
  }
}

export async function reconcilePendingState(
  workdir: string,
  previous: SeenState | undefined,
  token: string | undefined,
  log: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<SeenState | undefined> {
  if (previous?.pending === undefined) return previous
  if (token === undefined || token === '') {
    log(`pending PR #${previous.pending.pr} not checked (no GITHUB_TOKEN)`)
    return previous
  }
  try {
    const { owner, repo } = resolveRepo(workdir)
    const prState = await fetchPullRequestState({
      token,
      owner,
      repo,
      pr: previous.pending.pr,
      fetchImpl,
    })
    const next = applyPullRequestToSeenState(previous, prState)
    if (prState === 'merged') {
      log(`pending PR #${previous.pending.pr} merged; verified ${previous.pending.tag}`)
    } else if (prState === 'closed' || prState === 'missing') {
      log(`pending PR #${previous.pending.pr} closed without merge`)
    }
    return next
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(`pending PR #${previous.pending.pr} lookup failed: ${detail}`)
    return previous
  }
}

export function writeStateBranch(
  workdir: string,
  seen: SeenState | undefined,
  message: string,
): PersistResult {
  const files = {
    badge: badgeFromSeenState(seen),
    ...(seen === undefined ? {} : { seen }),
  }
  if (!stateFilesNeedWrite(workdir, files)) return { ok: true, commit: 'unchanged' }
  return persistStateBranch(workdir, files, { message })
}
