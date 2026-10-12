import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPlugins, pluginNames } from '../../src/plugins.ts'

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugins-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const plugin = (name: string): string => JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } })

test('a plugin at the root is the repository; nothing below it is searched', () => {
  const root = repository({ 'package.json': plugin('@acme/root'), 'examples/demo/package.json': plugin('@acme/demo') })
  try {
    assert.deepEqual(findPlugins(root).map(found => [found.dir, found.name]), [['', '@acme/root']])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('without a root plugin, every plugin below is found, in path order', () => {
  const root = repository({
    'package.json': JSON.stringify({ name: 'workspace', private: true }),
    'drill-web/package.json': plugin('@acme/web'),
    'drill-host/package.json': plugin('@acme/host'),
    'packages/tools/package.json': plugin('@acme/tools'),
    'packages/tools/node_modules/@acme/dep/package.json': plugin('@acme/dep'),
    'node_modules/@acme/other/package.json': plugin('@acme/other'),
    '.dsh-migrate/runs/x/package.json': plugin('@acme/run'),
    'docs/package.json': JSON.stringify({ name: 'docs' }),
    'broken/package.json': '{ not json',
    'nameless/package.json': JSON.stringify({ dsh: { bundle: {} } }),
  })
  try {
    assert.deepEqual(findPlugins(root).map(found => [found.dir, found.name]), [['drill-host', '@acme/host'], ['drill-web', '@acme/web'], ['packages/tools', '@acme/tools']])
    assert.equal(pluginNames(root), '@acme/host, @acme/web, @acme/tools')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plugin names are one bounded line, and a repository without a plugin is called plugin', () => {
  const root = repository({ 'package.json': plugin('evil\n## Forged\n- item') })
  const empty = repository({ 'README.md': '# nothing\n' })
  try {
    assert.equal(pluginNames(root), 'evil ## Forged - item')
    assert.equal(pluginNames(empty), 'plugin')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})
