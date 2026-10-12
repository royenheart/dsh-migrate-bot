import type { PatchReport } from './patch-reports.ts'
import { inline } from '../render/text.ts'

export const OFFICIAL_HARNESS_OWNER = 'deepseek-ai'
export const OFFICIAL_HARNESS_REPO = 'deepseek-harness'
/** Feature-request drafts land in Ideas; that is the official feature category. */
export const OFFICIAL_DISCUSSION_CATEGORY = 'ideas'

export const OFFICIAL_DISCUSSION_NEW_PATH = `https://github.com/${OFFICIAL_HARNESS_OWNER}/${OFFICIAL_HARNESS_REPO}/discussions/new`

/**
 * Strip leftover ATX hashes so the discussion title is plain text.
 */
export function discussionTitleFromReport(report: PatchReport): string {
  return report.title.replace(/^#+\s+/, '').trim() || report.slug
}

/**
 * Ideas "new discussion" URL. Category is selected; title is a best-effort query
 * param (GitHub does not document or reliably honor `body=`).
 */
export function officialDiscussionNewUrl(title: string): string {
  const params = new URLSearchParams({ category: OFFICIAL_DISCUSSION_CATEGORY })
  const trimmed = title.trim()
  if (trimmed !== '') params.set('title', trimmed)
  return `${OFFICIAL_DISCUSSION_NEW_PATH}?${params.toString()}`
}

/**
 * Follow-up Issue comment under a draft patch report: link to open an official Ideas topic.
 */
export function formatOfficialDiscussionInvite(input: {
  report: PatchReport
}): string {
  const title = discussionTitleFromReport(input.report)
  const url = officialDiscussionNewUrl(title)
  return [
    `### Open official discussion: \`${inline(input.report.slug, 60)}\``,
    '',
    'No matching official discussion / issue / PR was found. Copy the draft in the previous comment, then start an Ideas topic:',
    '',
    `[Open Ideas on deepseek-harness](${url})`,
    '',
    'The category is Ideas. The title may prefill. Paste the draft body from the previous comment — GitHub does not reliably honor `body=` on this form.',
  ].join('\n')
}
