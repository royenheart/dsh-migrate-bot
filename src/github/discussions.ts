import type { IssuePrLanguage } from '../config/schema.ts'
import type { PatchReport } from './patch-reports.ts'

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
  language: IssuePrLanguage
}): string {
  const title = discussionTitleFromReport(input.report)
  const url = officialDiscussionNewUrl(title)
  if (input.language === 'zh') {
    return [
      `### 去官方开帖：\`${input.report.slug}\``,
      '',
      '未找到对应的官方 discussion / issue / PR。请复制上一条评论里的讨论草稿，再到官方 Ideas 开帖：',
      '',
      `[在 deepseek-harness 打开 Ideas](${url})`,
      '',
      '分类会进 Ideas。标题有时能预填；正文请从上一评论的草稿粘贴（GitHub 不保证 `body=` 生效）。',
    ].join('\n')
  }
  return [
    `### Open official discussion: \`${input.report.slug}\``,
    '',
    'No matching official discussion / issue / PR was found. Copy the draft in the previous comment, then start an Ideas topic:',
    '',
    `[Open Ideas on deepseek-harness](${url})`,
    '',
    'The category is Ideas. The title may prefill. Paste the draft body from the previous comment — GitHub does not reliably honor `body=` on this form.',
  ].join('\n')
}
