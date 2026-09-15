import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderStepSummary, writeStepSummary } from '../../src/github/summary.ts'

const base = {
  status: 'migrated' as const,
  target: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' },
  pluginName: '@acme/dsh-plugin-foo',
  runDir: '/w/.dsh-migrate/runs/x',
}

test('a passing run summarizes the verdict, baseline and layers', () => {
  const markdown = renderStepSummary({
    ...base,
    result: {
      mechanical: { ok: true, errors: '', log: '', checks: 1 },
      fixAttempts: 1,
      skippedReview: false,
      attribution: { preExisting: false, regression: true, summary: 'baseline passed: the corridor caused this' },
      verification: { ok: true, layer: 'boot', signature: 'pass: reached the model call', detail: '' },
      stoppedBy: 'budget',
      e2eSync: { ok: true, pushed: true },
    },
    issueUrl: 'https://example.test/i/1',
    pullRequestUrl: 'https://example.test/p/2',
  })
  assert.match(markdown, /## dsh-migrate: 🔧 migrated/)
  assert.match(markdown, /`dsh-v0\.1\.5-rc\.1`/)
  assert.match(markdown, /fast gate: pass · repair rounds: 1/)
  assert.match(markdown, /\*\*Baseline\*\* — baseline passed/)
  assert.match(markdown, /\*\*Verification\*\* — boot probe: pass/)
  assert.match(markdown, /\*\*E2E branch\*\* — updated/)
  assert.match(markdown, /https:\/\/example\.test\/i\/1 · https:\/\/example\.test\/p\/2/)
})

test('a failure shows the failing layer output and why the loop stopped', () => {
  const markdown = renderStepSummary({
    ...base,
    status: 'failed',
    result: {
      mechanical: { ok: true, errors: '', log: '', checks: 1 },
      fixAttempts: 2,
      skippedReview: false,
      verification: {
        ok: false,
        layer: 'boot',
        signature: 'load: broken',
        detail: 'dsh: plugin(s) failed to load: broken',
      },
      stoppedBy: 'blocker',
      e2eSync: { ok: false, pushed: false, reason: 'no-draft' },
    },
  })
  assert.match(markdown, /## dsh-migrate: ❌ failed/)
  assert.match(markdown, /loop stopped: blocker/)
  assert.match(markdown, /boot probe: fail/)
  assert.match(markdown, /plugin\(s\) failed to load: broken/)
  assert.match(markdown, /E2E branch\*\* — not updated \(no-draft\)/)
})

test('a skipped review and a skipped verification layer are both stated', () => {
  const markdown = renderStepSummary({
    ...base,
    status: 'compatible',
    result: {
      mechanical: { ok: true, errors: '', log: '', checks: 1 },
      fixAttempts: 0,
      skippedReview: true,
      verification: {
        ok: true,
        layer: 'e2e',
        signature: 'e2e: no suite yet',
        detail: '',
        skipped: 'no dsh-migrate/e2e branch yet',
      },
    },
  })
  assert.match(markdown, /review skipped/)
  assert.match(markdown, /E2E suite: pass \(skipped: no dsh-migrate\/e2e branch yet\)/)
})

test('the summary is appended to the Actions step summary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-sum-'))
  const file = join(dir, 'summary.md')
  try {
    assert.equal(writeStepSummary('first\n', { GITHUB_STEP_SUMMARY: file }), true)
    assert.equal(writeStepSummary('second\n', { GITHUB_STEP_SUMMARY: file }), true)
    assert.equal(readFileSync(file, 'utf8'), 'first\nsecond\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without a step summary file nothing is written and nothing throws', () => {
  assert.equal(writeStepSummary('x\n', {}), false)
  assert.equal(writeStepSummary('x\n', { GITHUB_STEP_SUMMARY: '/nonexistent-dir/summary.md' }), false)
})

test('each verification layer is named correctly, including the web smoke', () => {
  // Observed live: the web smoke reported "skipped: the plugin declares no
  // dsh.client surface" while the summary labelled it "E2E suite".
  const markdown = renderStepSummary({
    ...base,
    result: {
      mechanical: { ok: true, errors: '', log: '', checks: 1 },
      fixAttempts: 0,
      skippedReview: false,
      verification: {
        ok: true,
        layer: 'web',
        signature: 'web: no client surface',
        detail: '',
        skipped: 'the plugin declares no dsh.client surface',
      },
    },
  })
  assert.match(markdown, /\*\*Verification\*\* — web smoke: pass/)
  assert.doesNotMatch(markdown, /E2E suite/)
})

test('a value from outside cannot forge a line or leave a fence in the summary', () => {
  // The tag is a free-form input and the failing layer's detail is the plugin's
  // own output: the summary is what a human reads on the run page, so neither may
  // start a line of its own or end the fence it sits in.
  const markdown = renderStepSummary({
    ...base,
    target: { tag: 'dsh-v0.1.6\n## Injected heading\n::add-mask::not-a-secret', version: '0.1.6' },
    result: {
      mechanical: { ok: false, errors: '', log: '', checks: 1 },
      fixAttempts: 0,
      skippedReview: false,
      attribution: { preExisting: false, regression: false, summary: 'baseline\n- @everyone approved' },
      verification: {
        ok: false,
        layer: 'boot',
        signature: 'load: failed',
        detail: 'the plugin did not load\n```\n</details>\n# Injected\n',
        skipped: 'not this time\n::stop-commands::tok',
      },
      stoppedBy: 'budget',
      e2eSync: { ok: false, pushed: false, reason: 'the suite branch is gone\n::add-mask::x' },
    },
    issueUrl: 'https://user:s3cr3t@evil.test/private',
    liveViewUrl: 'javascript:fetch("https://evil.test")',
  })
  assert.equal(markdown.split('\n').filter(line => line.startsWith('## Injected')).length, 0)
  assert.equal(markdown.split('\n').filter(line => line.startsWith('::')).length, 0)
  assert.equal(markdown.includes('```\n</details>'), false)
  assert.equal(markdown.split('```').length - 1, 2)
  assert.equal(markdown.includes('s3cr3t'), false)
  assert.equal(markdown.includes('javascript:'), false)
  // A reader can tell a target that named nothing from one whose page was refused.
  assert.match(markdown, /named a page this Action will not link/)
  assert.match(markdown, /dsh-v0\.1\.6 ## Injected heading ::add-mask::not-a-secret/)
})
