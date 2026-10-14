import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDsh, installArgs, releaseCutoff } from '../../src/verify/dsh-install.ts'

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

test('a release is cut off before the next prerelease of its line, and one without a later prerelease is not cut off', () => {
  // Publication times from the registry. One package of 0.2.0-rc.2 came 80 minutes after dsh itself, and
  // some of 0.1.2-alpha.3's came before it: the cutoff sits before the next prerelease of the same line.
  const times = {
    created: '2026-08-01T00:00:00.000Z',
    '0.1.2-alpha.2': '2026-08-30T14:10:52.613Z',
    '0.1.2-alpha.3': '2026-08-31T16:20:52.856Z',
    '0.2.0-rc.2': '2026-09-29T09:56:27.792Z',
    '0.2.1-alpha.1': '2026-10-03T04:53:22.343Z',
  }
  assert.equal(releaseCutoff(times, '0.1.2-alpha.2'), '2026-08-31T14:20:52.856Z')
  assert.equal(releaseCutoff(times, '0.2.0-rc.2'), undefined, 'a later release of another line cannot satisfy its ranges')
  assert.equal(releaseCutoff(times, '0.2.1-alpha.1'), undefined)
  assert.deepEqual(installArgs('/cache/dsh-0.1.2-alpha.2', '0.1.2-alpha.2', releaseCutoff(times, '0.1.2-alpha.2')), [
    'install', '-g', '--prefix', '/cache/dsh-0.1.2-alpha.2', '--no-fund', '--no-audit', '--before', '2026-08-31T14:20:52.856Z', '@deepseek-ai/dsh@0.1.2-alpha.2',
  ])
  assert.deepEqual(installArgs('/cache/dsh-0.2.0-rc.2', '0.2.0-rc.2', undefined), ['install', '-g', '--prefix', '/cache/dsh-0.2.0-rc.2', '--no-fund', '--no-audit', '@deepseek-ai/dsh@0.2.0-rc.2'])
})
