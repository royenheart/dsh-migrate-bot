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
      return { code: 0, stdout: '# Verdict\nkeep\n', stderr: '' }
    },
  })
  const result = await runner.run({
    kind: 'absorption',
    prompt: 'review the plugin',
    workdir: process.cwd(),
    dsh: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      thinking: 'enabled',
      reasoningEffort: 'max',
      mode: 'anchored-standard',
    },
    apiKey: 'sk-test',
  })
  assert.equal(result.report, '# Verdict\nkeep')
  assert.deepEqual(captured?.args, ['--profile', 'migrate', 'review the plugin'])
  assert.equal(captured?.env.DEEPSEEK_API_KEY, 'sk-test')
  assert.equal(captured?.env.DSH_MIGRATE_MODEL, 'deepseek-v4-pro')
  assert.equal(captured?.env.DSH_MIGRATE_TASK, 'review the plugin')
  assert.equal(captured?.env.DSH_MIGRATE_MODE, 'anchored-standard')
})
