import { badgeFromSeenState } from './badge.ts'
import { inline } from '../render/text.ts'
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
      // The tag came out of the state branch, and a log line is a line the
      // runner reads: one line of it.
      log(`pending PR #${previous.pending.pr} merged; verified ${inline(previous.pending.tag, 80)}`)
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
  message?: string,
): PersistResult {
  const files = {
    badge: badgeFromSeenState(seen),
    ...(seen === undefined ? {} : { seen }),
  }
  if (!stateFilesNeedWrite(workdir, files)) return { ok: true, commit: 'unchanged' }
  return persistStateBranch(workdir, files, message === undefined ? {} : { message })
}

/**
 * Retry a state-branch write that lost a race, and only that.
 *
 * The branch has several writers — the scheduled run, the badge job on a merge,
 * and a command being answered — and `persistStateBranch` builds its commit on
 * the freshly fetched tip, so a rejected push means somebody else pushed between
 * this attempt's read and its write. The next attempt reads again and writes on
 * top of what landed. A missing remote or a broken object store does not heal,
 * so those come back immediately.
 * @param attempt - one read-and-write, which re-reads for every call.
 * @param options - how many attempts, and where to say a race was lost.
 */
export function retryLostRace(
  attempt: () => PersistResult,
  options: { attempts: number; log: (message: string) => void },
): PersistResult {
  let result = attempt()
  for (let tried = 1; tried < options.attempts && lostRace(result); tried += 1) {
    options.log('the state branch moved under this write; retrying')
    result = attempt()
  }
  return result
}

/**
 * Whether a rejected push was this writer losing a race rather than git failing.
 *
 * A rejected token, a protected branch and a network partition all exit
 * non-zero and none of them heals by re-reading the branch; git says which one
 * it was, and only a stale parent is worth a second attempt.
 * @param result - the write that failed.
 */
function lostRace(result: PersistResult): boolean {
  return !result.ok
    && result.reason === 'push-failed'
    && /non-fast-forward|fetch first|\[rejected\]|stale info/i.test(result.detail)
}
