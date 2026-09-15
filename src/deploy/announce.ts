/**
 * Putting the run page where a person already is.
 *
 * The step summary is not where a maintainer looks while a migration runs; the
 * thread is. The link is posted once, after the run, because the target keeps the
 * record and the link stays useful afterwards — and it is best effort, because a
 * migration that succeeded is not failed by a comment that did not post.
 */

import { inline } from '../render/text.ts'

export interface AnnounceInput {
  /** The read-only page, when a deploy target served one. */
  url?: string | undefined
  /** The issue the run opened, when it opened one. */
  issueNumber?: number | undefined
  workdir: string
  /** Posts a comment; the caller owns the token and the API. */
  comment: (issueNumber: number, body: string, workdir: string) => Promise<void>
  log: (message: string) => void
}

/** What the thread is told, as one line plus the reason it is worth opening. */
export function liveViewAnnouncement(url: string): string {
  return `This run can be watched at ${inline(url, 300)} — read-only, and the target keeps the log after the run ends.`
}

/**
 * Post the link, or say why nothing was posted.
 *
 * A run with no target, no issue, or no token posts nothing and says nothing:
 * there is no thread to put it on, and the step summary already carries it.
 * @param input - the page, the thread, and the means to post.
 */
export async function announceLiveView(input: AnnounceInput): Promise<void> {
  if (input.url === undefined || input.url.trim() === '') {
    // No page to name: there is nothing to post, and the step summary says so by
    // not carrying a link either.
    return
  }
  if (input.issueNumber === undefined) {
    input.log('live view: no issue was opened, so the link stays in the step summary')
    return
  }
  const issue = input.issueNumber
  try {
    await input.comment(issue, liveViewAnnouncement(input.url), input.workdir)
    input.log(`live view: link posted on #${String(issue)}`)
  } catch (error) {
    input.log(
      `live view: the link could not be posted on #${String(issue)}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
