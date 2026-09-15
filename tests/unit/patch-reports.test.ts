import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectPatchReports, formatPatchReportComment } from '../../src/github/patch-reports.ts'

test('collects one report.md per patch directory', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-mig-pr-'))
  const existing = join(workdir, '.dsh-migrate/patch-reports/agent-pre-step')
  const draft = join(workdir, '.dsh-migrate/patch-reports/new-slot')
  mkdirSync(existing, { recursive: true })
  mkdirSync(draft, { recursive: true })
  writeFileSync(join(existing, 'report.md'), [
    '# [Feature request] pre-step hook',
    '',
    'See https://github.com/deepseek-ai/deepseek-harness/discussions/12',
    'and https://github.com/deepseek-ai/deepseek-harness/issues/34',
  ].join('\n'))
  writeFileSync(join(draft, 'report.md'), [
    '# [Feature request] keyed slot for tools',
    '',
    '> Add a keyed slot so plugins can register tool views.',
    '',
    '## Background',
    'Need a keyed tool view.',
  ].join('\n'))
  const reports = collectPatchReports(workdir)
  assert.equal(reports.length, 2)
  assert.equal(reports[0]?.slug, 'agent-pre-step')
  assert.equal(reports[0]?.kind, 'existing')
  assert.equal(reports[0]?.links.length, 2)
  assert.equal(reports[1]?.kind, 'draft')
})

test('issue comment starts with a table then each report body', () => {
  const comments = formatPatchReportComment({
    language: 'en',
    pullRequestUrl: 'https://example.test/p/2',
    reports: [
      {
        slug: 'agent-pre-step',
        title: '[Feature request] pre-step hook',
        kind: 'existing',
        links: ['https://github.com/deepseek-ai/deepseek-harness/discussions/12'],
        body: '# [Feature request] pre-step hook\n\n```\nunclosed fence',
      },
      {
        slug: 'new-slot',
        title: '[Feature request] keyed slot',
        kind: 'draft',
        links: [],
        body: '# [Feature request] keyed slot\n\ndraft body',
      },
    ],
  })
  assert.equal(comments.length, 1)
  const body = comments[0] ?? ''
  assert.match(body, /Companion PR: https:\/\/example\.test\/p\/2/)
  assert.match(body, /## Patch report index/)
  const tableAt = body.indexOf('| `agent-pre-step` |')
  const firstReportAt = body.indexOf('## agent-pre-step')
  const secondReportAt = body.indexOf('## new-slot')
  assert.ok(tableAt >= 0 && firstReportAt > tableAt && secondReportAt > firstReportAt)
  assert.match(body, /draft body/)
  assert.match(body, /~~~~markdown/)
  const firstFence = body.indexOf('unclosed fence')
  assert.ok(firstFence >= 0 && firstFence < secondReportAt)
})

test('a slug read off a directory cannot forge a line of the comment', () => {
  // The slug is a directory name under `.dsh-migrate/patch-reports/`, written by
  // the migration as it read somebody else's plugin, and the comment it lands in
  // is read by a human and by the runner's command parser.
  const comments = formatPatchReportComment({
    reports: [{
      slug: 'x\n- @everyone approved\n::add-mask::not-a-secret',
      title: 'x',
      body: '## Proposal\nkeep it',
      kind: 'draft',
      links: ['https://github.com/deepseek-ai/deepseek-harness/discussions/1\n::stop-commands::tok'],
    }],
    pullRequestUrl: 'https://github.com/acme/plug/pull/2',
    language: 'en',
  })
  assert.equal(comments.length, 1)
  for (const comment of comments) {
    assert.equal(comment.split('\n').filter(line => line.startsWith('::')).length, 0)
    assert.equal(comment.split('\n').filter(line => line.startsWith('- @everyone')).length, 0)
  }
  assert.match(comments[0] ?? '', /## x - @everyone approved ::add-mask::not-a-secret/)

  // The companion pull request URL goes through the URL rule: one that carries a
  // credential is not republished in a comment.
  const credentialed = formatPatchReportComment({
    reports: [],
    pullRequestUrl: 'https://user:s3cr3t@evil.test/pull/2',
    language: 'en',
  })
  assert.equal(credentialed.join('\n').includes('s3cr3t'), false)
})
