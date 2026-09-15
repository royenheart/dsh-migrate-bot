import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackageName, readPluginName } from '../../src/mechanical/run.ts'
import { renderDocuments } from '../../src/github/templates.ts'

/** A tree whose `package.json` holds exactly what a test wants it to hold. */
function tree(packageJson: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-name-'))
  if (packageJson !== undefined) writeFileSync(join(dir, 'package.json'), packageJson)
  return dir
}

test('a tree names its plugin, and a tree that cannot is called plugin', () => {
  const named = tree('{"name": "@acme/dsh-plugin-x"}')
  const absent = tree(undefined)
  const empty = tree('{"name": ""}')
  const wrongType = tree('{"name": 42}')
  const notJson = tree('{"name": "@acme/x",')
  try {
    assert.equal(readPluginName(named), '@acme/dsh-plugin-x')
    assert.equal(readPackageName(named), '@acme/dsh-plugin-x')
    assert.equal(readPluginName(absent), 'plugin')
    assert.equal(readPluginName(empty), 'plugin')
    assert.equal(readPluginName(wrongType), 'plugin')
    // The migration edits this file, so a tree that no longer parses is a tree
    // without a name rather than a crash in whatever renders the report.
    assert.equal(readPluginName(notJson), 'plugin')
    assert.equal(readPackageName(notJson), undefined)
  } finally {
    for (const dir of [named, absent, empty, wrongType, notJson]) rmSync(dir, { recursive: true, force: true })
  }
})

test('a package name cannot forge a line in the report it names', () => {
  // The name is the migrated tree's own text and it lands in an issue title and
  // body, where a newline would start a section of somebody else's making.
  const dir = tree('{"name": "evil\\n## Forged\\n- item"}')
  try {
    const pluginName = readPluginName(dir)
    assert.equal(pluginName.includes('\n'), false)
    assert.match(pluginName, /^evil ## Forged - item$/)

    const docs = renderDocuments({
      language: 'en',
      status: 'migrated',
      target: { tag: 'dsh-v0.1.5', version: '0.1.5' },
      pluginName,
      skippedReview: false,
      fixAttempts: 0,
      mechanical: { ok: true, errors: '', log: 'ok', checks: 1 },
      diff: '+ name: x',
    })
    assert.equal(docs.title.includes('\n'), false)
    assert.equal(docs.issue.split('\n').some(line => line.startsWith('## Forged')), false)
    assert.match(docs.issue, /# Migration report: evil ## Forged - item/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
