import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTscBin, NPX_TYPESCRIPT_TSC, typecheckCommand } from '../../src/mechanical/typecheck.ts'

test('never uses bare npx tsc (the placeholder npm package)', () => {
  const command = typecheckCommand('/no/such/plugin', fileURLToPath(import.meta.url))
  assert.doesNotMatch(command, /^npx tsc\b/)
  assert.notEqual(command, 'npx tsc --noEmit')
})

test('uses the plugin-local tsc when one exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-migrate-tsc-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'tsc')
  writeFileSync(bin, '')
  const command = typecheckCommand(root, fileURLToPath(import.meta.url))
  assert.equal(findTscBin(root, fileURLToPath(import.meta.url)), bin)
  assert.match(command, /--noEmit$/)
  assert.ok(command.includes(JSON.stringify(bin)))
})

test('falls back to the migrator typescript, else npx --package typescript', () => {
  const command = typecheckCommand('/no/such/plugin', fileURLToPath(import.meta.url))
  const bundled = findTscBin('/no/such/plugin', fileURLToPath(import.meta.url))
  if (bundled === undefined) {
    assert.equal(command, NPX_TYPESCRIPT_TSC)
    return
  }
  assert.ok(command.includes(JSON.stringify(bundled)))
  assert.doesNotMatch(command, /npx tsc/)
})
