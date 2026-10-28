import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunManifest, manifestPath, runManifestSchema, serializeManifest, sha256 } from '../../src/observability/manifest.ts'
import type { SessionRecord } from '../../src/observability/session.ts'
import type { AgentConfig } from '../../src/config/schema.ts'

const agent: AgentConfig = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  thinking: 'enabled',
  reasoningEffort: 'max',
  upgradeSkills: true,
}

const session: SessionRecord = {
  kind: 'overlap',
  name: 'overlap',
  prompt: 'review this plugin',
  promptSha256: sha256('review this plugin'),
  startedAt: '2026-10-27T13:00:00.000Z',
  endedAt: '2026-10-27T13:05:00.000Z',
  outcome: 'completed',
  output: '# report',
  usage: { inputTokens: 100, outputTokens: 20, cacheHitTokens: 30, usd: 0.01 },
  progress: { turns: 3, steps: 7, elapsedSeconds: 300 },
  toolCalls: 4,
  observations: [],
}

test('a manifest totals sessions and keeps prompt hashes, not prompt text', () => {
  const manifest = buildRunManifest({
    runId: '123-1',
    migrationId: '0.2.1-rc.2',
    plugin: ['dsh-plugin-opencode-omo'],
    target: { tag: 'dsh-v0.2.1-rc.2', version: '0.2.1-rc.2' },
    agent,
    sessions: [session],
    checks: [{ check: 'mechanical', outcome: 'pass' }],
    outcome: 'accepted',
    state: 'accepted',
    evaluation: { harborJob: 'job-1', trialId: 'trial-1', record: 'https://example.test/record' },
    startedAt: '2026-10-27T13:00:00.000Z',
    endedAt: '2026-10-27T13:06:00.000Z',
  })
  assert.equal(manifest.totals.sessions, 1)
  assert.equal(manifest.totals.turns, 3)
  assert.equal(manifest.totals.steps, 7)
  assert.equal(manifest.totals.toolCalls, 4)
  assert.equal(manifest.totals.usd, 0.01)
  assert.equal(manifest.prompts.overlap?.path, `prompts/${sha256('review this plugin')}.md`)
  assert.equal(JSON.stringify(manifest).includes('review this plugin'), false)
  assert.equal(manifest.workflow.hash.length, 64)
  assert.equal(manifest.workflow.state, 'accepted')
  assert.equal(manifest.evaluation?.trialId, 'trial-1')
  assert.equal(runManifestSchema.safeParse(manifest).success, true)
  assert.equal(manifestPath('0.2.1-rc.2', '123-1'), 'migrations/0.2.1-rc.2/runs/123-1/manifest.json')
  assert.match(serializeManifest(manifest), /"totals"/)
})

test('a trace id is recorded beside an export flag', () => {
  const manifest = buildRunManifest({
    runId: '123-1',
    migrationId: '0.2.1-rc.2',
    plugin: ['plugin'],
    target: { tag: 'dsh-v0.2.1-rc.2', version: '0.2.1-rc.2' },
    agent,
    sessions: [],
    checks: [],
    outcome: 'compatible',
    startedAt: '2026-10-27T13:00:00.000Z',
    endedAt: '2026-10-27T13:06:00.000Z',
    traceId: '0123456789abcdef0123456789abcdef',
    traceExported: false,
  })
  assert.deepEqual(manifest.trace, { id: '0123456789abcdef0123456789abcdef', exported: false })
})
