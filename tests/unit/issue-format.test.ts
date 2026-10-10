import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatAgentReport,
  formatWorkingTree,
  parseDiffPaths,
  sanitizeFlowingMarkdown,
  wrapFenced,
} from '../../src/github/issue-format.ts'
import { appRootFrom } from '../../src/paths.ts'

const fixture = (...parts: string[]) => join(appRootFrom(import.meta.url), 'tests/fixtures/omo-issue1', ...parts)

const reportA = readFileSync(fixture('report-a.md'), 'utf8')
const reportB = readFileSync(fixture('report-b.md'), 'utf8')
const worktree = readFileSync(fixture('worktree.diff'), 'utf8')

test('omo issue #1 review reports drop their H1 and keep their sections', () => {
  const a = formatAgentReport(reportA, '_Not run._')
  const b = formatAgentReport(reportB, '_Not run._')
  assert.doesNotMatch(a, /^# /m)
  assert.doesNotMatch(b, /^# /m)
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
  const block = formatWorkingTree(worktree)
  assert.match(block, /`README\.md`/)
  assert.match(block, /~~~~diff/)
  assert.match(block, /```sh/)
  assert.match(block, /Truncated/)
  const fences = block.match(/~~~~/g) ?? []
  assert.equal(fences.length, 2)
})

test('fences in reports and diffs cannot steal later sections', () => {
  const report = formatAgentReport('# Review\n\nA sample that must not open a fence.\n\n```yaml\nfoo: a-long-enough-mapping-value\n```\n\n## 3. Decision\nkeep\n', '_Not run._')
  assert.doesNotMatch(report, /^#{1,2} /m)
  assert.match(report, /` ``yaml/)
  const tree = formatWorkingTree(['diff --git a/README.md b/README.md', '+ </details>', '+ ~~~~~', '+ ```sh'].join('\n'))
  assert.match(tree, /&lt;\/details/)
  assert.equal(tree.match(/<\/details>/g)?.length, 1)
  assert.match(sanitizeFlowingMarkdown('```yaml\nfoo: 1'), /` ``yaml/)
  assert.ok(wrapFenced('~~~~~\nbody', 'diff').startsWith('~~~~~~diff'))
})
