import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractReport } from '../../src/agents/dsh.ts'

test('extracts the last heading block from agent stdout', () => {
  const report = extractReport('noise\n# Verdict\nshrink\n')
  assert.equal(report, '# Verdict\nshrink')
})

test('unwraps a markdown fence', () => {
  const report = extractReport('```markdown\n# A\nok\n```')
  assert.equal(report, '# A\nok')
})
