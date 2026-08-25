import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderDocuments } from '../../src/github/templates.ts'
import {
  formatErrorExcerpt,
  formatWorkingTree,
  parseDiffPaths,
  sanitizeFlowingMarkdown,
  summarizeAgentReport,
  wrapFenced,
} from '../../src/github/issue-format.ts'
import { appRootFrom } from '../../src/paths.ts'

const fixture = (...parts: string[]) => join(appRootFrom(import.meta.url), 'tests/fixtures/omo-issue1', ...parts)

const reportA = readFileSync(fixture('report-a.md'), 'utf8')
const reportB = readFileSync(fixture('report-b.md'), 'utf8')
const worktree = readFileSync(fixture('worktree.diff'), 'utf8')

const omo = {
  language: 'en' as const,
  status: 'migrated' as const,
  target: { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' },
  pluginName: '@royenheart/dsh-plugin-opencode-omo',
  skippedReview: false,
  fixAttempts: 0,
  mechanical: { ok: true, errors: '', log: 'ok' },
  verdictA: reportA,
  verdictB: reportB,
  diff: worktree,
}

function outline(markdown: string): string[] {
  return markdown.split(/\r?\n/).filter(line => /^#{1,2}\s/.test(line))
}

test('omo issue #1 A/B summaries drop H1 and keep a verdict', () => {
  const a = summarizeAgentReport(reportA, '_Not run._')
  const b = summarizeAgentReport(reportB, '_Not run._')
  assert.doesNotMatch(a, /^# /m)
  assert.doesNotMatch(b, /^# /m)
  assert.match(a, /Verdict: `keep`/)
  assert.match(a, /### Plugin purpose/)
  assert.match(a, /### Concrete edits/)
  assert.match(a, /b150a55/)
  assert.match(a, /discussion #2407/)
  assert.match(b, /### Current seams/)
  assert.match(b, /self-contained dsh bundle/)
  assert.doesNotMatch(a, /An adjacent but non-substitute proposal is\s*$/)
})

test('omo issue #1 diff lists files and does not leak nested fences', () => {
  assert.deepEqual(parseDiffPaths(worktree), [
    'README.md',
    'design.md',
    'package.json',
    'patches/0001-agent-pre-step-assistant-prefill.patch',
    'patches/README.md',
  ])
  const block = formatWorkingTree(worktree, 'en')
  assert.match(block, /`README\.md`/)
  assert.match(block, /~~~~diff/)
  assert.match(block, /```sh/)
  assert.match(block, /Truncated/)
  const fences = block.match(/~~~~/g) ?? []
  assert.equal(fences.length, 2)
})

test('fences in errors, previews, and diffs cannot steal later sections', () => {
  const docs = renderDocuments({
    ...omo,
    verdictA: '# Review\n\nHere is a config sample that must not open a fence.\n\n```yaml\nfoo: a-long-enough-mapping-value\n```\n\n## 3. Verdict\nkeep\n',
    mechanical: { ok: false, errors: 'failed\n```\nnot a fence closer\n```\n', log: '' },
    diff: [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '+ </details>',
      '+ ~~~~~',
      '+ ```sh',
      '+ echo hi',
    ].join('\n'),
  })
  const heads = outline(docs.issue)
  assert.deepEqual(heads, [
    '# Migration report: @royenheart/dsh-plugin-opencode-omo × DeepSeek Harness 0.1.1-rc.2',
    '## Summary',
    '## Root cause',
    '## Official overlap (A)',
    '## Design alignment (B)',
    '## Mechanical test report',
    '## Working tree',
    '## Notes',
  ])
  assert.match(docs.issue, /&lt;\/details/)
  assert.match(docs.issue, /` ``yaml/)
  const notesAt = docs.issue.indexOf('## Notes')
  const detailsClose = docs.issue.lastIndexOf('</details>')
  assert.ok(detailsClose > 0 && notesAt > detailsClose)
  assert.match(formatErrorExcerpt('```\nbad\n```', '(empty)'), /~~~~/)
  assert.match(sanitizeFlowingMarkdown('```yaml\nfoo: 1'), /` ``yaml/)
  assert.ok(wrapFenced('~~~~~\nbody', 'diff').startsWith('~~~~~~diff'))
})

test('rendered omo issue keeps a single H1 and the template outline', () => {
  const docs = renderDocuments(omo)
  const heads = outline(docs.issue)
  assert.deepEqual(heads, [
    '# Migration report: @royenheart/dsh-plugin-opencode-omo × DeepSeek Harness 0.1.1-rc.2',
    '## Summary',
    '## Root cause',
    '## Official overlap (A)',
    '## Design alignment (B)',
    '## Mechanical test report',
    '## Working tree',
    '## Notes',
  ])
  assert.doesNotMatch(docs.issue, /^## Remaining gaps/m)
  assert.doesNotMatch(docs.issue, /^## 1\. Current seams/m)
  assert.match(docs.issue, /Verdict: `keep`/)
  assert.match(docs.issue, /Overlap verdict: `keep`/)
  assert.match(docs.issue, /assistantPrefill/)
  assert.match(docs.issue, /### Plugin purpose/)
  assert.match(docs.issue, /### Remaining gaps/)
  assert.match(docs.issue, /<\/details>/)
  const notesAt = docs.issue.indexOf('## Notes')
  const detailsAt = docs.issue.indexOf('</details>')
  assert.ok(detailsAt > 0 && notesAt > detailsAt)
})
