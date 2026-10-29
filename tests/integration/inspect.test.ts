import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildRunManifest, serializeManifest, sha256 } from '../../src/observability/manifest.ts'
import { StateStore } from '../../src/state/store.ts'
import { checkout } from '../support/repository.ts'
import { PACKAGE_ROOT } from '../../src/paths.ts'

test('inspect reads a seeded state branch and writes the live evidence page', () => {
  const repo = checkout()
  try {
    const prompt = 'review this plugin\n'
    const promptSha = sha256(prompt)
    const manifest = buildRunManifest({
      runId: 'run-1',
      migrationId: '0.2.0',
      plugin: ['@acme/plugin'],
      target: { tag: 'dsh-v0.2.0', version: '0.2.0' },
      agent: { provider: 'deepseek-official', model: 'deepseek-v4-flash', thinking: 'enabled', reasoningEffort: 'max', upgradeSkills: true },
      sessions: [{
        kind: 'overlap',
        name: 'overlap',
        prompt,
        promptSha256: promptSha,
        startedAt: '2026-10-27T13:00:00.000Z',
        endedAt: '2026-10-27T13:05:00.000Z',
        outcome: 'completed',
        usage: { inputTokens: 10, outputTokens: 2, cacheHitTokens: 1, usd: 0.001 },
        progress: { turns: 1, steps: 2, elapsedSeconds: 300 },
        toolCalls: 1,
        observations: [],
      }],
      checks: [],
      outcome: 'accepted',
      startedAt: '2026-10-27T13:00:00.000Z',
      endedAt: '2026-10-27T13:06:00.000Z',
    })
    mkdirSync(join(repo.work, '.github'), { recursive: true })
    writeFileSync(join(repo.work, '.github', 'dsh-migrate.yml'), 'this is not a valid config\n')
    new StateStore(repo.work).write(undefined, new Map([
      ['migrations/0.2.0/runs/run-1/manifest.json', serializeManifest(manifest)],
      [`prompts/${promptSha}.md`, prompt],
      ['migrations/0.3.0/events.jsonl', 'not json\n'],
    ]), 'seed evidence')

    const run = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'dist', 'src', 'cli.js'), 'inspect', '--workdir', repo.work, '--migration', '0.2.0', '--out', 'evidence'], { cwd: repo.work, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const page = join(repo.work, 'evidence', 'index.html')
    assert.equal(existsSync(page), true)
    const html = readFileSync(page, 'utf8')
    assert.match(html, /0\.2\.0/)
    assert.match(html, /review this plugin/)
    assert.match(html, /stateDiagram-v2/)

    const jsonRun = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'dist', 'src', 'cli.js'), 'inspect', '--workdir', repo.work, '--migration', '0.2.0', '--out', 'evidence-json', '--json'], { cwd: repo.work, encoding: 'utf8' })
    assert.equal(jsonRun.status, 0, jsonRun.stderr)
    const bundle = JSON.parse(readFileSync(join(repo.work, 'evidence-json', 'inspect.json'), 'utf8')) as { runs: Array<{ prompts: Record<string, string> }> }
    assert.equal(bundle.runs[0]?.prompts.overlap, 'review this plugin\n')
  } finally {
    repo.cleanup()
  }
})
