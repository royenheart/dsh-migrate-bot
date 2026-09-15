import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderDocuments } from '../../src/github/templates.ts'

const base = {
  status: 'migrated' as const,
  target: { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' },
  pluginName: '@me/dsh-plugin-x',
  skippedReview: false,
  fixAttempts: 2,
  mechanical: { ok: true, errors: '', log: 'ok', checks: 1 },
  verdictA: '## Verdict\nshrink',
  verdictB: '## Edits\nuse official slot',
  diff: '+ key: x',
}

test('English documents have root-cause and test sections', () => {
  const docs = renderDocuments({ ...base, language: 'en' })
  assert.match(docs.title, /0\.1\.1-rc\.2/)
  assert.match(docs.issue, /## Root cause/)
  assert.match(docs.issue, /Overlap verdict: `shrink`/)
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

test('the report renders the baseline attribution and the verification layer', () => {
  const docs = renderDocuments({
    language: 'en',
    status: 'failed',
    target: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' },
    pluginName: '@acme/plugin',
    skippedReview: false,
    fixAttempts: 2,
    mechanical: { ok: true, errors: '', log: '', checks: 1 },
    diff: '',
    attribution: { preExisting: true, regression: false, summary: 'baseline already broken (state): look further back' },
    verification: {
      ok: false,
      layer: 'web',
      signature: 'web: exited before serving',
      detail: 'dsh web: exited before serving',
    },
  })
  assert.match(docs.issue, /## Layered verification/)
  assert.match(docs.issue, /Baseline: baseline already broken/)
  assert.match(docs.issue, /web smoke: fail/)
  assert.match(docs.issue, /dsh web: exited before serving/)
})

test('the Chinese report names every layer in Chinese', () => {
  const docs = renderDocuments({
    language: 'zh',
    status: 'migrated',
    target: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' },
    pluginName: '@acme/plugin',
    skippedReview: false,
    fixAttempts: 0,
    mechanical: { ok: true, errors: '', log: '', checks: 1 },
    diff: '',
    verification: { ok: true, layer: 'boot', signature: 'pass', detail: '' },
  })
  assert.match(docs.issue, /## 分层验证/)
  assert.match(docs.issue, /boot 探针: pass/)
})

test('a report with no verification section stays unchanged', () => {
  const docs = renderDocuments({
    language: 'en',
    status: 'compatible',
    target: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' },
    pluginName: '@acme/plugin',
    skippedReview: true,
    fixAttempts: 0,
    mechanical: { ok: true, errors: '', log: '', checks: 1 },
    diff: '',
  })
  assert.doesNotMatch(docs.issue, /## Layered verification/)
})

test('a harness tag from an input cannot forge a line of the issue or the pull request', () => {
  // `dsh_version` is a free-form action input, so the tag is operator text until
  // the resolver turns it into one: it lands in an issue title and body.
  const docs = renderDocuments({
    ...base,
    language: 'en',
    target: { tag: 'dsh-v0.1.6\n## Injected heading\n- @everyone', version: '0.1.6\n::add-mask::x' },
    verification: {
      ok: false,
      layer: 'boot',
      signature: 'load: failed',
      detail: 'the plugin did not load\n```\n</details>\n# Injected\n',
    },
  })
  assert.equal(docs.title.split('\n').length, 1)
  assert.equal(docs.issue.split('\n').filter(line => line.startsWith('## Injected')).length, 0)
  assert.equal(docs.issue.split('\n').filter(line => line.startsWith('- @everyone')).length, 0)
  assert.equal(docs.pr.split('\n').filter(line => line.startsWith('::')).length, 0)
  assert.equal(docs.issue.includes('```\n</details>'), false)
  assert.match(docs.issue, /dsh-v0\.1\.6 ## Injected heading - @everyone/)
})
