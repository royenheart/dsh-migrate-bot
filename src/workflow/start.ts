import type { Projection } from './projection.ts'
import type { Proposal, Release } from './model.ts'

/**
 * Whether a scheduled run starts a migration for the target release.
 *
 * This decision is made before a migration exists, so it is not part of the
 * machine: a skipped run leaves no log.
 */

export type StartDecision =
  | { action: 'skip'; reason: 'unchanged-release' | 'proposal-has-maintainer-commits' | 'proposal-open'; detail: string }
  | { action: 'start'; proposal?: Proposal; supersedes?: string }

export interface StartInput {
  target: Release
  projection: Projection
  /** Run even when the target release was already processed. */
  force: boolean
  /** Commits on the open proposal's branch that the bot did not author. */
  maintainerCommits: number
}

/**
 * Decide whether to start.
 *
 * An open proposal is taken over by the new migration, which force-pushes its
 * branch and edits its pull request; that would discard commits a maintainer
 * added, so a proposal carrying any is left alone until it is merged or closed.
 * A release whose own proposal is open is not migrated again: the new run
 * would replace the log that holds the proposal, and a run that did not
 * publish would leave the pull request open with no migration behind it.
 * @param input - the target, the projected state, and the facts the projection lacks.
 */
export function decideStart(input: StartInput): StartDecision {
  const { processed, open } = input.projection
  if (!input.force && processed !== undefined && processed.target.version === input.target.version) {
    return {
      action: 'skip',
      reason: 'unchanged-release',
      detail: `${input.target.tag} was already processed (${processed.state})`,
    }
  }
  const proposal = open?.context.proposal
  if (open === undefined || proposal === undefined) return { action: 'start' }
  if (open.id === input.target.version) {
    return {
      action: 'skip',
      reason: 'proposal-open',
      detail: `the proposal of ${input.target.tag}, pull request #${String(proposal.pullRequest.number)}, is open; merge or close it to migrate that release again`,
    }
  }
  if (input.maintainerCommits > 0) {
    return {
      action: 'skip',
      reason: 'proposal-has-maintainer-commits',
      detail: `pull request #${String(proposal.pullRequest.number)} has ${String(input.maintainerCommits)} commit(s) from a maintainer; merge or close it first`,
    }
  }
  return { action: 'start', proposal, supersedes: open.id }
}
