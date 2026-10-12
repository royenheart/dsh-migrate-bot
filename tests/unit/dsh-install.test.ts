import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDsh, installArgs } from '../../src/verify/dsh-install.ts'

function cacheRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-mig-cache-'))
}

/** Stand in for a real `npm install -g --prefix`. */
function fakeInstall(behaviour: 'ok' | 'fail' | 'ok-without-bin') {
  return (prefix: string, version: string): { ok: boolean; detail: string } => {
    if (behaviour === 'fail') return { ok: false, detail: `npm install exited 1: E404 ${version}` }
    if (behaviour === 'ok-without-bin') return { ok: true, detail: 'claimed success' }
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    const bin = join(prefix, 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
    return { ok: true, detail: `installed ${version} at ${prefix}` }
  }
}

test('an already installed version is reused instead of reinstalled', () => {
  const root = cacheRoot()
  try {
    const prefix = join(root, 'dsh-0.1.5-rc.1')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(join(prefix, 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '#!/bin/sh\n')
    let installed = false
    const result = ensureDsh('0.1.5-rc.1', root, {
      install: (target, version) => {
        installed = true
        return fakeInstall('ok')(target, version)
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.bin, join(prefix, 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'))
    assert.match(result.detail, /^cached at /)
    assert.equal(installed, false, 'a cached binary must not trigger an install')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing version is installed into a per-version prefix', () => {
  const root = cacheRoot()
  try {
    let seen: { prefix: string; version: string } | undefined
    const result = ensureDsh('0.1.5-rc.1', root, {
      install: (prefix, version) => {
        seen = { prefix, version }
        return fakeInstall('ok')(prefix, version)
      },
    })
    assert.equal(result.ok, true)
    assert.equal(seen?.version, '0.1.5-rc.1')
    assert.equal(seen?.prefix, join(root, 'dsh-0.1.5-rc.1'))
    assert.match(result.detail, /installed 0\.1\.5-rc\.1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed install reports npm output instead of pretending to work', () => {
  const root = cacheRoot()
  try {
    const result = ensureDsh('9.9.9', root, { install: fakeInstall('fail') })
    assert.equal(result.ok, false)
    assert.equal(result.bin, undefined)
    assert.match(result.detail, /E404/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a silent install that produced no binary is a failure, not a success', () => {
  const root = cacheRoot()
  try {
    const result = ensureDsh('0.1.5-rc.1', root, { install: fakeInstall('ok-without-bin') })
    assert.equal(result.ok, false)
    assert.match(result.detail, /is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two versions never share a prefix', () => {
  const root = cacheRoot()
  try {
    const prefixes: string[] = []
    const install = (prefix: string, version: string): { ok: boolean; detail: string } => {
      prefixes.push(prefix)
      return fakeInstall('ok')(prefix, version)
    }
    ensureDsh('0.1.5-rc.1', root, { install })
    ensureDsh('0.1.2-alpha.3', root, { install })
    assert.equal(new Set(prefixes).size, 2)
    assert.notEqual(prefixes[0], prefixes[1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a release is installed with the dependencies it was published with', () => {
  assert.deepEqual(installArgs('/cache/dsh-0.1.0-rc.6', '0.1.0-rc.6', '2026-08-13T12:35:03.812Z'), [
    'install', '-g', '--prefix', '/cache/dsh-0.1.0-rc.6', '--no-fund', '--no-audit', '--before', '2026-08-13T13:35:03.812Z', '@deepseek-ai/dsh@0.1.0-rc.6',
  ])
})
