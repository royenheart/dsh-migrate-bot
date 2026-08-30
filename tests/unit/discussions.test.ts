import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  discussionTitleFromReport,
  formatOfficialDiscussionInvite,
  officialDiscussionNewUrl,
} from '../../src/github/discussions.ts'
import type { PatchReport } from '../../src/github/patch-reports.ts'

const draft: PatchReport = {
  slug: 'pre-step',
  title: '[Feature request] pre-step hook',
  body: '# [Feature request] pre-step hook\n\n> Add a hook.\n',
  kind: 'draft',
  links: [],
}

test('discussion title drops a leftover ATX prefix', () => {
  assert.equal(discussionTitleFromReport(draft), '[Feature request] pre-step hook')
  assert.equal(discussionTitleFromReport({
    ...draft,
    title: '# leftover hashes',
  }), 'leftover hashes')
})

test('new-discussion URL selects Ideas and encodes the title', () => {
  const url = officialDiscussionNewUrl('[Feature request] pre-step hook')
  assert.match(url, /^https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/discussions\/new\?/)
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('category'), 'ideas')
  assert.equal(parsed.searchParams.get('title'), '[Feature request] pre-step hook')
  assert.equal(parsed.searchParams.get('body'), null)
})

test('invite comment is a follow-up under the draft', () => {
  const en = formatOfficialDiscussionInvite({ report: draft, language: 'en' })
  assert.match(en, /Open official discussion: `pre-step`/)
  assert.match(en, /Open Ideas on deepseek-harness/)
  assert.match(en, /category=ideas/)
  const zh = formatOfficialDiscussionInvite({ report: draft, language: 'zh' })
  assert.match(zh, /去官方开帖：`pre-step`/)
  assert.match(zh, /打开 Ideas/)
})
