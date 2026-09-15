/**
 * What a run says when it is over.
 *
 * Two places already hold this information — the step summary a person reads on
 * the run page, and the thread the migration belongs to — and keeping the two
 * together is what makes the run page findable from where somebody is actually
 * looking. It is one unit rather than three lines inside the CLI so it can be
 * tested: a test that spawns a whole migration needs an API key, a harness
 * install and an agent session, which is why "the run names its own page" was
 * the one behaviour no test pinned.
 */

import { renderStepSummary } from '../github/summary.ts'
import { announceLiveView } from '../deploy/announce.ts'
import type { PipelineResult } from './types.ts'
import type { ResolvedVersion } from '../watch/dsh-version.ts'

export interface FinishRunInput {
  /** The live view, when a target served one. */
  view: { url?: string | undefined }
  result: PipelineResult
  target: ResolvedVersion
  pluginName: string
  runDir: string
  workdir: string
  /** Token that can comment on the run's issue, when the run may use one. */
  token: string | undefined
  /** Where the summary goes; the return value says whether it was written. */
  writeSummary: (markdown: string) => boolean
  /** Posts one comment as the publisher does, when there is an issue and a token. */
  comment: ((issueNumber: number, body: string, workdir: string) => Promise<void>) | undefined
  log: (message: string) => void
}

/**
 * Render the summary, write it, and put the run page where a person is.
 *
 * Both halves are best effort: a step summary that cannot be written is logged,
 * and a comment that cannot be posted is a line in the log, because a migration
 * that succeeded is not failed by either.
 * @param input - the finished run and the two destinations.
 */
export async function finishRun(input: FinishRunInput): Promise<string> {
  // A run that succeeded is not failed by the page it failed to describe: the
  // summary is rendered defensively, and the announcement below still happens so
  // the thread can name the page even when the run page cannot.
  let summary = ''
  try {
    summary = renderStepSummary({
      status: input.result.status,
      target: input.target,
      pluginName: input.pluginName,
      result: input.result,
      ...(input.result.published.issueUrl === undefined ? {} : { issueUrl: input.result.published.issueUrl }),
      ...(input.result.published.pullRequestUrl === undefined
        ? {}
        : { pullRequestUrl: input.result.published.pullRequestUrl }),
      ...(input.view.url === undefined ? {} : { liveViewUrl: input.view.url }),
      runDir: input.runDir,
    })
  } catch (error) {
    input.log(`the run page could not be rendered: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (summary !== '' && !input.writeSummary(summary)) input.log(summary)

  if (input.token === undefined || input.comment === undefined) return summary
  await announceLiveView({
    url: input.view.url,
    issueNumber: input.result.published.issueNumber,
    workdir: input.workdir,
    comment: input.comment,
    log: input.log,
  })
  return summary
}
