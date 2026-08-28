import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { parseConfig } from '../../src/config/load.ts'
import { runMechanical } from '../../src/mechanical/run.ts'
import { appRootFrom } from '../../src/paths.ts'

const fixtures = resolve(appRootFrom(import.meta.url), 'fixtures/plugins')

test('typecheck-ok passes default mechanical checks', () => {
  const result = runMechanical(resolve(fixtures, 'typecheck-ok'), parseConfig({}))
  assert.equal(result.ok, true, result.errors)
})

test('typecheck without a plugin-local tsc uses the migrator compiler', () => {
  const result = runMechanical(resolve(fixtures, 'typecheck-no-local-tsc'), parseConfig({}))
  assert.equal(result.ok, true, result.errors)
  assert.doesNotMatch(result.log, /\$ npx tsc --noEmit/)
  assert.doesNotMatch(result.log, /This is not the tsc command you are looking for/)
  assert.match(result.log, /--noEmit/)
})

test('slot-key-break fails default mechanical checks', () => {
  const result = runMechanical(resolve(fixtures, 'slot-key-break'), parseConfig({}))
  assert.equal(result.ok, false)
  assert.match(result.errors, /options\.key/)
})

test('official-overlap-markdown is mechanically valid', () => {
  const result = runMechanical(resolve(fixtures, 'official-overlap-markdown'), parseConfig({}))
  assert.equal(result.ok, true, result.errors)
})

test('user commands replace the default suite', () => {
  const result = runMechanical(resolve(fixtures, 'slot-key-break'), parseConfig({
    tests: { commands: ['node -e "process.exit(0)"'] },
  }))
  assert.equal(result.ok, true)
})

test('user commands can still fail', () => {
  const result = runMechanical(resolve(fixtures, 'typecheck-ok'), parseConfig({
    tests: { commands: ['node -e "console.error(\\"error: boom\\"); process.exit(1)"'] },
  }))
  assert.equal(result.ok, false)
  assert.match(result.errors, /boom/)
})
