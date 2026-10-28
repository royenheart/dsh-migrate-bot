import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunRecorder, recorderFor } from '../../src/observability/recorder.ts'
import { sha256 } from '../../src/observability/manifest.ts'
import type { StateStore } from '../../src/state/store.ts'
import type { MigrationView } from '../../src/workflow/projection.ts'
import type { SessionRecord } from '../../src/observability/session.ts'
import type { AgentConfig } from '../../src/config/schema.ts'

const agent: AgentConfig = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  thinking: 'enabled',
  reasoningEffort: 'max',
  upgradeSkills: true,
}

const view = {
  id: '0.2.1-rc.2',
  target: { tag: 'dsh-v0.2.1-rc.2', version: '0.2.1-rc.2' },
  state: 'accepted',
  context: {
    input: {
      target: { tag: 'dsh-v0.2.1-rc.2', version: '0.2.1-rc.2' },
      settings: {},
    },
  },
} as unknown as MigrationView

test('a recorder writes prompts, observations, a run manifest, and a state-branch manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-migrate-manifest-'))
  try {
    const changes = new Map<string, string>()
    const store = {
      refresh: () => 'base',
      read: () => ({ tip: 'base', logs: new Map() }),
      write: (_base: string | undefined, files: ReadonlyMap<string, string>) => {
        for (const [path, text] of files) changes.set(path, text)
        return { ok: true as const, commit: 'commit' }
      },
    } as unknown as StateStore
    const recorder = new RunRecorder({
      runId: '123-1',
      plugin: ['plugin'],
      agent,
      startedAt: '2026-10-27T13:00:00.000Z',
    })
    const session: SessionRecord = {
      kind: 'overlap',
      name: 'overlap',
      prompt: 'review this plugin',
      promptSha256: sha256('review this plugin'),
      startedAt: '2026-10-27T13:00:00.000Z',
      endedAt: '2026-10-27T13:05:00.000Z',
      outcome: 'completed',
      usage: { inputTokens: 100, outputTokens: 20, cacheHitTokens: 30, usd: 0.01 },
      progress: { turns: 1, steps: 2, elapsedSeconds: 300 },
      toolCalls: 1,
      observations: [{ seq: 1, time: 1, type: 'tool-call', tool: { name: 'read' } }],
    }
    recorder.record(session)
    recorder.recordCheck({ check: 'mechanical', outcome: 'pass' })
    const manifest = await recorder.flush({ store, migrationId: view.id, runDir: dir, view })
    assert.equal(manifest.totals.sessions, 1)
    const promptPath = join(dir, 'prompts', `${sha256('review this plugin')}.md`)
    assert.equal(existsSync(promptPath), true)
    assert.equal(readFileSync(promptPath, 'utf8'), 'review this plugin')
    assert.equal(sha256(readFileSync(promptPath, 'utf8')), sha256('review this plugin'))
    assert.equal(existsSync(join(dir, 'observations', 'overlap.jsonl')), true)
    assert.equal(existsSync(join(dir, 'manifest.json')), true)
    assert.equal(changes.has('migrations/0.2.1-rc.2/runs/123-1/manifest.json'), true)
    assert.equal(changes.has(`prompts/${sha256('review this plugin')}.md`), true)
    assert.equal(sha256(changes.get(`prompts/${sha256('review this plugin')}.md`) ?? ''), sha256('review this plugin'))
    assert.match(readFileSync(join(dir, 'manifest.json'), 'utf8'), /"toolCalls": 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('Harbor variables become a manifest evaluation and empty values do not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-migrate-eval-'))
  try {
    const recorder = recorderFor({
      runId: 'eval-1',
      plugin: ['plugin'],
      agent,
      env: {
        DSH_MIGRATE_HARBOR_JOB: 'job-1',
        DSH_MIGRATE_HARBOR_TRIAL: 'trial-1',
        DSH_MIGRATE_HARBOR_RECORD: 'https://example.test/record',
      },
    })
    const manifest = await recorder.flush({ migrationId: view.id, runDir: dir, view })
    assert.deepEqual(manifest.evaluation, {
      harborJob: 'job-1',
      trialId: 'trial-1',
      record: 'https://example.test/record',
    })
    const empty = recorderFor({ runId: 'eval-2', plugin: ['plugin'], agent, env: { DSH_MIGRATE_HARBOR_JOB: '' } })
    const noEval = await empty.flush({ migrationId: view.id, runDir: dir, view })
    assert.equal(noEval.evaluation, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
