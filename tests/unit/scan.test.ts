import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { scanKeyedSlots, scanPluginShape } from '../../src/mechanical/scan.ts'
import { appRootFrom } from '../../src/paths.ts'

const fixtures = resolve(appRootFrom(import.meta.url), 'fixtures/plugins')

test('typecheck-ok has a valid plugin shape', () => {
  assert.deepEqual(scanPluginShape(resolve(fixtures, 'typecheck-ok')), [])
})

test('slot-key-break is flagged for a missing keyed-slot key', () => {
  const findings = scanKeyedSlots(resolve(fixtures, 'slot-key-break'))
  assert.ok(findings.some(item => item.message.includes('options.key')))
})

test('overlap fixture registers the keyed slot with a key', () => {
  assert.deepEqual(scanKeyedSlots(resolve(fixtures, 'official-overlap-markdown')), [])
})
