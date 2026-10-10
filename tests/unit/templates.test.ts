import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROPOSAL_MARKER, renderProposal } from '../../src/github/templates.ts'
import { contextOf, input } from '../support/migration.ts'
import type { MigrationEvent } from '../../src/workflow/model.ts'

const repaired: MigrationEvent[] = [
  { type: 'check.done', result: { check: 'mechanical', outcome: 'fail', fingerprint: 'mechanical: TS2304', detail: '' } },
  { type: 'session.done', kind: 'overlap', outcome: 'completed', blocker: 'none', detail: '' },
  { type: 'session.done', kind: 'extension-points', outcome: 'completed', blocker: 'none', detail: '' },
  { type: 'check.done', result: { check: 'mechanical', outcome: 'fail', fingerprint: 'mechanical: TS2551', detail: '' } },
  { type: 'session.done', kind: 'repair', outcome: 'completed', blocker: 'none', detail: '' },
]

function render(pluginName = '@acme/plugin') {
  return renderProposal({
    context: contextOf(input('0.2.0', { source: { release: { tag: 'dsh-v0.1.7', version: '0.1.7' }, origin: 'verified' } }), repaired),
    pluginName,
    checks: [
      { check: 'mechanical', outcome: 'pass', fingerprint: '', detail: '' },
      { check: 'e2e', outcome: 'fail', fingerprint: 'e2e: login spec', detail: 'expected heading' },
    ],
    reports: { overlap: '# Overlap\n\n## 3. Decision\nshrink', extensionPoints: '## Edits\nuse the official slot', repairs: ['## Root cause\nrenamed export'] },
    diff: 'diff --git a/index.ts b/index.ts\n+ key: x',
    runUrl: 'https://github.com/acme/plugin/actions/runs/1',
  })
}

test('the proposal names the release range, the attempts and every check', () => {
  const docs = render()
  assert.match(docs.title, /^Migrate @acme\/plugin to DeepSeek Harness 0\.2\.0$/)
  assert.match(docs.issue, /Source release: `dsh-v0\.1\.7` \(verified\)/)
  assert.match(docs.issue, /Repair attempts: 1/)
  assert.match(docs.issue, /End-to-end check: fail \(e2e: login spec\)/)
  assert.match(docs.pullRequest, /expected heading/)
  assert.match(docs.pullRequest, /actions\/runs\/1/)
})

test('the issue carries each review and repair report under its own heading', () => {
  const docs = render()
  const outline = docs.issue.split('\n').filter(line => /^#{1,2} /.test(line))
  assert.deepEqual(outline, [
    '# Migration of @acme/plugin to dsh-v0.2.0',
    '## Summary',
    '## Checks',
    '## Overlap review',
    '## Extension-point review',
    '## Repair attempts',
    '## Working tree',
  ])
  assert.match(docs.issue, /### Decision\n\nshrink/)
  assert.match(docs.issue, /### Repair attempt 1/)
})

test('both bodies carry the marker that finds them again', () => {
  const docs = render()
  assert.ok(docs.issue.startsWith(PROPOSAL_MARKER))
  assert.ok(docs.pullRequest.startsWith(PROPOSAL_MARKER))
})

test('a plugin name cannot forge a line of the title or the issue', () => {
  const docs = render('evil\n## Forged\n- item')
  assert.equal(docs.title.includes('\n'), false)
  assert.equal(docs.issue.split('\n').some(line => line.startsWith('## Forged')), false)
})
