import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appRootFrom } from '../../src/paths.ts'

const root = appRootFrom(import.meta.url)
const suite = join(root, 'bench', 'tasks')
const tasks = existsSync(suite) ? readdirSync(suite).filter(id => existsSync(join(suite, id, 'task.toml'))) : []

test('every task of the span suite runs the current verifier', () => {
  for (const file of ['judge.mjs', 'test.sh']) {
    const current = readFileSync(join(root, 'bench', 'judge', file), 'utf8')
    for (const id of tasks) assert.equal(readFileSync(join(suite, id, 'tests', file), 'utf8'), current, `${id}/tests/${file} is stale: copy bench/judge/${file}`)
  }
})

test('every task installs the release its verifier targets, as the registry stood at the migration', () => {
  for (const id of tasks) {
    const config = JSON.parse(readFileSync(join(suite, id, 'tests', 'task.json'), 'utf8')) as { target: string; before: string }
    const dockerfile = readFileSync(join(suite, id, 'environment', 'Dockerfile'), 'utf8')
    assert.match(dockerfile, new RegExp(`npm install -g --before=${config.before} @deepseek-ai/dsh@${config.target.replaceAll('.', '\\.')}\\n`), id)
    assert.match(readFileSync(join(suite, id, 'README.md'), 'utf8'), /\| Repository \| https:\/\/github\.com\//, `${id} names where it came from`)
  }
})
