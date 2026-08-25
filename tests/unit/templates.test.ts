import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderDocuments } from '../../src/github/templates.ts'

const base = {
  status: 'migrated' as const,
  target: { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' },
  pluginName: '@me/dsh-plugin-x',
  skippedReview: false,
  fixAttempts: 2,
  mechanical: { ok: true, errors: '', log: 'ok' },
  verdictA: '## Verdict\nshrink',
  verdictB: '## Edits\nuse official slot',
  diff: '+ key: x',
}

test('English documents have root-cause and test sections', () => {
  const docs = renderDocuments({ ...base, language: 'en' })
  assert.match(docs.title, /0\.1\.1-rc\.2/)
  assert.match(docs.issue, /## Root cause/)
  assert.match(docs.issue, /## Mechanical test report/)
  assert.match(docs.issue, /patch-reports/)
  assert.match(docs.pr, /## Test plan/)
  assert.match(docs.pr, /## Risk/)
})

test('Chinese documents keep the same section set', () => {
  const docs = renderDocuments({ ...base, language: 'zh' })
  assert.match(docs.issue, /## 根因/)
  assert.match(docs.issue, /## 机械测试报告/)
  assert.match(docs.issue, /patch-reports/)
  assert.match(docs.pr, /## 测试计划/)
})
