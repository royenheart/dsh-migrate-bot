import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutHarness, type GitRunner } from '../../src/harness/checkout.ts'
import type { SpawnSyncReturns } from 'node:child_process'

function ok(stdout = ''): SpawnSyncReturns<string> {
  return { status: 0, stdout, stderr: '', pid: 1, output: [null, stdout, ''], signal: null }
}

function fail(stderr: string): SpawnSyncReturns<string> {
  return { status: 1, stdout: '', stderr, pid: 1, output: [null, '', stderr], signal: null }
}

test('first checkout is a shallow sparse clone of the tag', () => {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-harness-'))
  const calls: string[][] = []
  const git: GitRunner = (args) => {
    calls.push([...args])
    if (args[0] === 'clone') {
      mkdirSync(join(dest, '.git'))
      return ok()
    }
    return ok()
  }
  const result = checkoutHarness({ tag: 'dsh-v0.1.1-rc.2', dest, git })
  assert.equal(result.ok, true)
  assert.ok(calls[0]?.includes('--sparse'))
  assert.ok(calls[0]?.includes('--filter=blob:none'))
  assert.ok(calls[0]?.includes('dsh-v0.1.1-rc.2'))
  assert.deepEqual(calls[1]?.slice(0, 2), ['sparse-checkout', 'set'])
  assert.equal(readFileSync(join(dest, '.dsh-migrate-tag'), 'utf8').trim(), 'dsh-v0.1.1-rc.2')
})

test('reuses a dest that already has the same tag', () => {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-harness-'))
  mkdirSync(join(dest, '.git'))
  writeFileSync(join(dest, '.dsh-migrate-tag'), 'dsh-v0.1.1-rc.2\n')
  let called = 0
  const result = checkoutHarness({
    tag: 'dsh-v0.1.1-rc.2',
    dest,
    git: () => {
      called += 1
      return ok()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(called, 0)
})

test('clone failure is returned, not thrown', () => {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-harness-'))
  const result = checkoutHarness({
    tag: 'dsh-v9.9.9',
    dest,
    git: () => fail('repository not found'),
  })
  assert.equal(result.ok, false)
  assert.match(result.detail ?? '', /repository not found/)
})
