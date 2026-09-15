import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeGithubOutput } from '../../src/github/output.ts'
import { createDshRunner } from '../../src/agents/dsh.ts'

test('writeGithubOutput appends key=value lines and no-ops without GITHUB_OUTPUT', () => {
  const previous = process.env.GITHUB_OUTPUT
  delete process.env.GITHUB_OUTPUT
  writeGithubOutput({ status: 'compatible' })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-out-'))
  const file = join(dir, 'github-output')
  process.env.GITHUB_OUTPUT = file
  try {
    writeGithubOutput({ status: 'migrated', issue_url: 'https://example.test/i/1' })
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^status=migrated$/m)
    assert.match(text, /^issue_url=https:\/\/example\.test\/i\/1$/m)

    // A value with a newline is written with the heredoc form, and the delimiter
    // is drawn per write: a fixed one is a line a value could contain, and
    // everything after it would be read as the next output.
    writeGithubOutput({ command_reply: 'line one\nline two' })
    const multi = readFileSync(file, 'utf8').split('\n')
    const opener = multi.find(line => line.startsWith('command_reply<<'))
    assert.notEqual(opener, undefined)
    const delimiter = (opener ?? '').slice('command_reply<<'.length)
    assert.match(delimiter, /^MIGRATE_EOF_[0-9a-f]{32}$/)
    assert.equal(multi.filter(line => line === delimiter).length, 1)
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT
    else process.env.GITHUB_OUTPUT = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dsh runner passes profile, prompt, and DSH_MIGRATE_* env', async () => {
  let captured: { args: string[]; env: NodeJS.ProcessEnv } | undefined
  const runner = createDshRunner({
    spawnImpl: async (args, options) => {
      captured = { args, env: options.env }
      return { code: 0, stdout: '# Verdict\nkeep\n', stderr: '', timedOut: false }
    },
  })
  const result = await runner.run({
    kind: 'absorption',
    prompt: 'review the plugin',
    workdir: process.cwd(),
    dsh: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      thinking: 'enabled',
      reasoningEffort: 'max',
      mode: 'standard',
    },
    apiKey: 'sk-test',
  })
  assert.equal(result.report, '# Verdict\nkeep')
  assert.deepEqual(captured?.args, ['--profile', 'migrate', 'review the plugin'])
  assert.equal(captured?.env.DEEPSEEK_API_KEY, 'sk-test')
  assert.equal(captured?.env.DSH_MIGRATE_MODEL, 'deepseek-v4-flash')
  assert.equal(captured?.env.DSH_MIGRATE_TASK, 'review the plugin')
  assert.equal(captured?.env.DSH_MIGRATE_MODE, 'standard')
})
