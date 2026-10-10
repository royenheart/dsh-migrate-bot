import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { appRootFrom } from '../../src/paths.ts'

const root = appRootFrom(import.meta.url)
const entrypoint = resolve(root, 'container/entrypoint.sh')

/** Run the entrypoint with a stand-in CLI and return the arguments it received. */
function argv(inputs: Record<string, string>, args: string[] = []): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-entry-'))
  try {
    const out = join(dir, 'argv.json')
    const cli = join(dir, 'cli.mjs')
    writeFileSync(cli, "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))\n")
    const result = spawnSync('bash', [entrypoint, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: dir, GITHUB_WORKSPACE: dir, DSH_MIGRATE_CLI: cli, ARGV_OUT: out, ...inputs },
    })
    assert.equal(result.status, 0, result.stderr)
    return (JSON.parse(readFileSync(out, 'utf8')) as string[]).map(arg => arg.replace(dir, '<workspace>'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the inputs of a run become its arguments, and an empty input none', () => {
  assert.deepEqual(argv({ INPUT_WORKDIR: '.', INPUT_CONFIG: 'cfg.yml', INPUT_TARGET: '', INPUT_FORCE: 'true', INPUT_SKIP_GITHUB: 'false' }), [
    'run', '--workdir', '<workspace>/.', '--config', 'cfg.yml', '--force',
  ])
})

test('a closed pull request and a comment carry their own inputs', () => {
  assert.deepEqual(argv({ INPUT_COMMAND: 'pull-request-closed', INPUT_PULL_REQUEST: '9', INPUT_MERGED: 'true' }), [
    'pull-request-closed', '--workdir', '<workspace>/.', '--number', '9', '--merged', 'true',
  ])
  const comment = argv({ INPUT_COMMAND: 'comment', INPUT_COMMENT_BODY: '/dsh-migrate status\n--force', INPUT_COMMENT_ID: '77', INPUT_ISSUE_NUMBER: '9' })
  assert.deepEqual(comment.slice(0, 1), ['comment'])
  // A comment body is one argument whatever it contains.
  assert.equal(comment[comment.indexOf('--body') + 1], '/dsh-migrate status\n--force')
})

test('arguments given to docker run pass through unchanged', () => {
  assert.deepEqual(argv({ INPUT_COMMAND: 'run' }, ['self-test']), ['self-test'])
})

test('every input the action declares is mapped by the entrypoint', () => {
  const action = parse(readFileSync(resolve(root, 'action.yml'), 'utf8')) as { inputs: Record<string, unknown> }
  const script = readFileSync(entrypoint, 'utf8')
  for (const input of Object.keys(action.inputs)) {
    assert.ok(script.includes(`INPUT_${input.toUpperCase()}`), `${input} is declared but not mapped`)
  }
})
