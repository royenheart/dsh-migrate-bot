import type { FeedbackMethod } from '../config/schema.ts'
import type { PatchReport } from '../github/patch-reports.ts'

/** How a channel decides what to write. */
export type FeedbackChannelKind = 'analysis' | 'dedupe'

/** One channel after config, built-ins and evidence are resolved. */
export interface ResolvedChannel {
  id: string
  repo: string
  method: FeedbackMethod
  tokenEnv: string
  kind: FeedbackChannelKind
  labels: string[]
  discussionCategory: string
  /** User prompt override, replacing the channel's shipped prompt. */
  prompt?: string | undefined
  builtin: boolean
}

/** A comment left on the migrate issue or pull request by a human. */
export interface AuthoredComment {
  source: 'issue' | 'pull' | 'review'
  author: string
  createdAt: string
  path?: string | undefined
  body: string
}

/** One file the maintainer changed on the branch before merging. */
export interface ChangedFile {
  filename: string
  status: string
  additions: number
  deletions: number
}

/** Everything a feedback session reasons over. Rendered, never re-fetched. */
export interface FeedbackEvidence {
  plugin: { owner: string; repo: string; url: string }
  from?: string | undefined
  to?: string | undefined
  pullRequest: {
    number: number
    url: string
    title: string
    body: string
    /** `merged`, `open`, `closed`, or `missing`. */
    state: string
    mergedAt?: string | undefined
    mergedBy?: string | undefined
    mergeCommitSha?: string | undefined
    author?: string | undefined
  }
  issue?: { number: number; url: string; title: string; body: string } | undefined
  comments: AuthoredComment[]
  /** What changed between the branch the Action pushed and the merge commit. */
  maintainerChanges: {
    known: boolean
    files: ChangedFile[]
    /** Why the comparison is missing when it is. */
    note?: string | undefined
  }
  reports: {
    runDir?: string | undefined
    absorption?: string | undefined
    alignment?: string | undefined
    fixes: string[]
    mechanical?: string | undefined
    patchReports: PatchReport[]
  }
  /** Threads the Action already found, for the duplicate-check channel. */
  candidates: Array<{ url: string; title: string }>
}

/** What one channel did. */
export type FeedbackOutcome =
  | { channel: string; status: 'delivered'; method: FeedbackMethod; url?: string | undefined; detail?: string | undefined }
  | { channel: string; status: 'held'; reason: string }
  /** A dry run produced the payload and delivered nothing. */
  | { channel: string; status: 'dry-run'; method: FeedbackMethod; title: string; bodyPreview: string }
  | { channel: string; status: 'skipped'; reason: string }
  | { channel: string; status: 'failed'; reason: string }

/** The whole feedback stage's result. */
export interface FeedbackResult {
  /** Absent when the stage did not run at all (no merged PR, or the stage is off). */
  ran: boolean
  reason?: string | undefined
  outcomes: FeedbackOutcome[]
}
