import { project } from '../workflow/projection.ts'
import type { LogEntry } from '../workflow/model.ts'

/**
 * What became of the proposals in the consumer repositories.
 *
 * Everything here is derived from a consumer's state branch when the report is
 * built: the event log records when a proposal was published and when its pull
 * request closed, merged or not. Nothing is stored, because the logs keep it.
 * The only fact the logs lack, the maintainer commits on a proposal, is asked
 * of GitHub by the caller.
 */

export interface FieldMigration {
  consumer: string
  release: string
  state: string
  startedAt: string
  proposal?: {
    pullRequest: number
    url: string
    publishedAt: string
    /** When the closing of the pull request was delivered, and whether it was merged. */
    closed?: { at: string; merged: boolean }
    /** Commits on the proposal not made by the Action, when they were counted. */
    maintainerCommits?: number
  }
}

/** The migrations of one consumer, newest first. */
export function fieldMigrations(consumer: string, logs: ReadonlyMap<string, readonly LogEntry[]>): FieldMigration[] {
  return project(logs).migrations.map((view) => {
    const entries = logs.get(view.id) ?? []
    // A superseding run starts the log again; the last run is the one the view describes.
    const run = entries.slice(entries.findLastIndex(entry => entry.kind === 'started'))
    const published = run.find(entry => entry.kind === 'event' && entry.event.type === 'proposal.published')
    const closed = run.find(entry => entry.kind === 'event' && entry.event.type === 'pull-request.closed')
    const proposal = view.context.proposal
    return {
      consumer,
      release: view.id,
      state: view.state,
      startedAt: view.startedAt,
      ...(proposal === undefined || published === undefined
        ? {}
        : {
            proposal: {
              pullRequest: proposal.pullRequest.number,
              url: proposal.pullRequest.url,
              publishedAt: published.at,
              ...(closed?.kind === 'event' && closed.event.type === 'pull-request.closed' ? { closed: { at: closed.at, merged: closed.event.merged } } : {}),
            },
          }),
    }
  })
}

export interface FieldMetrics {
  proposals: number
  merged: number
  closedUnmerged: number
  open: number
  /** `merged / (merged + closed unmerged)`: the share of decided proposals that were accepted. */
  mergeRate: number | null
  /** Share of merged proposals with no maintainer commit, among those whose commits were counted. */
  mergedUntouched: number | null
  /** Median hours from publishing to merging. */
  hoursToMergeP50: number | null
}

export function fieldMetrics(migrations: readonly FieldMigration[]): FieldMetrics {
  const proposals = migrations.flatMap(migration => migration.proposal ?? [])
  const merged = proposals.filter(proposal => proposal.closed?.merged === true)
  const closedUnmerged = proposals.filter(proposal => proposal.closed?.merged === false).length
  const counted = merged.filter(proposal => proposal.maintainerCommits !== undefined)
  const hours = merged.map(proposal => (Date.parse(proposal.closed?.at ?? '') - Date.parse(proposal.publishedAt)) / 3_600_000).sort((a, b) => a - b)
  const middle = Math.floor(hours.length / 2)
  return {
    proposals: proposals.length,
    merged: merged.length,
    closedUnmerged,
    open: proposals.filter(proposal => proposal.closed === undefined).length,
    mergeRate: merged.length + closedUnmerged === 0 ? null : merged.length / (merged.length + closedUnmerged),
    mergedUntouched: counted.length === 0 ? null : counted.filter(proposal => proposal.maintainerCommits === 0).length / counted.length,
    hoursToMergeP50: hours.length === 0 ? null : hours.length % 2 === 1 ? hours[middle] ?? null : ((hours[middle - 1] ?? 0) + (hours[middle] ?? 0)) / 2,
  }
}
