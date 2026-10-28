import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reportStyleProblems } from '../../src/merge-reports/style.ts'
import { renderMigrateBotReport } from '../../src/merge-reports/render.ts'
import type { Evidence } from '../../src/merge-reports/evidence.ts'

test('defensive contrastive negation is detected', () => {
  assert.deepEqual(reportStyleProblems('This is not just a bump, it is a rewrite.'), ['not just / not only'])
  assert.deepEqual(reportStyleProblems('It is not a bump but a rewrite.'), ['not X but Y'])
  assert.deepEqual(reportStyleProblems('It is not a defect; the plugin already behaved this way.'), ['not a defect / finding / regression / failure'])
  assert.deepEqual(reportStyleProblems('The Action failed, rather than the plugin.'), ['rather than'])
  assert.deepEqual(reportStyleProblems('The check passed.'), [])
})

test('the deterministic report template reads as findings, not as a defense', () => {
  const evidence: Evidence = {
    plugin: 'acme/plugin',
    from: 'dsh-v0.1.0',
    to: 'dsh-v0.2.0',
    pullRequest: { number: 9, url: 'https://github.com/acme/plugin/pull/9', title: 'Migrate', body: '', merged: true, mergedAt: '2026-10-27T13:24:12Z', mergedBy: 'maintainer' },
    actionVersion: '1.0.0-rc.3',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash', thinking: 'enabled', reasoningEffort: 'max' },
    issueUrl: 'https://github.com/acme/plugin/issues/8',
    comments: [],
    maintainerChanges: { known: true, files: [{ filename: 'index.js', status: 'modified', additions: 1, deletions: 1 }] },
    checks: ['Boot check: skipped', 'Web check: pass'],
    warnings: [],
    reports: { repairs: [] },
    patchReports: [],
    candidates: [],
  }
  const rendered = renderMigrateBotReport(evidence, {
    title: 'The web check missed the preset',
    findings: [
      { stage: 'web check', severity: 'high', finding: 'The ready line passed without the preset being registered.', evidence: 'The maintainer enabled it by hand in index.js.', fix: 'Assert the preset is registered.', attribution: 'action' },
      { stage: 'e2e', severity: 'low', finding: 'No live child turn ran.', evidence: 'The maintainer ran one on the branch.', fix: 'Require a live child turn.', attribution: 'pre-existing' },
    ],
    limits: ['The raw diff was not in the evidence.'],
  })
  assert.match(rendered.body, /## Findings/)
  assert.match(rendered.body, /### 1\. \[high\] web check:/)
  assert.match(rendered.body, /\*\*Attribution\.\*\* Pre-existing\./)
  assert.deepEqual(reportStyleProblems(rendered.body), [])
})
