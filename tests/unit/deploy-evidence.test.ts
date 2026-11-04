import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../../src/config/load.ts'
import { publishRunEvidence } from '../../src/deploy/evidence.ts'
import { buildRunManifest, serializeManifest, sha256 } from '../../src/observability/manifest.ts'
import type { MigrationFiles } from '../../src/observability/evidence.ts'

function evidenceFiles(): MigrationFiles {
  const prompt = 'review this plugin\n'
  const manifest = buildRunManifest({
    runId: 'run-1',
    migrationId: '0.2.0',
    plugin: ['@acme/plugin'],
    target: { tag: 'dsh-v0.2.0', version: '0.2.0' },
    agent: { provider: 'deepseek-official', model: 'deepseek-v4-flash', thinking: 'enabled', reasoningEffort: 'max', upgradeSkills: true },
    sessions: [{
      kind: 'overlap', name: 'overlap', prompt, promptSha256: sha256(prompt),
      startedAt: '2026-10-27T13:00:00.000Z', endedAt: '2026-10-27T13:05:00.000Z', outcome: 'completed',
      usage: { inputTokens: 10, outputTokens: 2, cacheHitTokens: 1, usd: 0.001 },
      progress: { turns: 1, steps: 2, elapsedSeconds: 300 }, toolCalls: 1, observations: [],
    }],
    checks: [], outcome: 'accepted', startedAt: '2026-10-27T13:00:00.000Z', endedAt: '2026-10-27T13:06:00.000Z',
  })
  const files = new Map<string, string>([
    ['migrations/0.2.0/runs/run-1/manifest.json', serializeManifest(manifest)],
    [`prompts/${sha256(prompt)}.md`, prompt],
  ])
  return {
    list(directory) { return [...files.keys()].filter(path => path.startsWith(`${directory}/`)) },
    readFile(path) { return files.get(path) },
  }
}

test('a run evidence bundle is posted to the deploy service and its URL is returned', async () => {
  let request: { url: string; init: RequestInit } | undefined
  const fetchImpl: typeof fetch = async (input, init) => {
    request = { url: String(input), init: init ?? {} }
    return new Response(JSON.stringify({ url: 'https://site.example/inspect.html?data=encoded' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const logs: string[] = []
  const url = await publishRunEvidence({
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.example' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    runId: 'run-1',
    repository: 'acme/plugin',
    migrationId: '0.2.0',
    store: evidenceFiles(),
    log: message => logs.push(message),
    fetchImpl,
  })
  assert.equal(url, 'https://site.example/inspect.html?data=encoded')
  assert.equal(request?.url, 'https://deploy.example/runs/run-1/evidence')
  assert.equal(new Headers(request?.init.headers).get('authorization'), 'Bearer secret')
  const body = JSON.parse(String(request?.init.body)) as { migrationId: string; runs: Array<{ prompts: Record<string, string> }> }
  assert.equal(body.migrationId, '0.2.0')
  assert.equal(body.runs[0]?.prompts.overlap, 'review this plugin\n')
  assert.deepEqual(logs, ['run evidence: https://site.example/inspect.html?data=encoded'])
})

test('evidence upload is a logged skip when no deploy service is configured', async () => {
  const logs: string[] = []
  const url = await publishRunEvidence({
    config: parseConfig({}),
    env: {}, runId: 'run-1', repository: 'acme/plugin', migrationId: '0.2.0', store: evidenceFiles(), log: message => logs.push(message),
    fetchImpl: async () => { throw new Error('must not fetch') },
  })
  assert.equal(url, undefined)
  assert.deepEqual(logs, [])
})

test('evidence opens the run when the log stream is off', async () => {
  const paths: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    paths.push(new URL(String(input)).pathname)
    return new Response(JSON.stringify({ url: 'https://deploy.example/view/run-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const url = await publishRunEvidence({
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.example', logStream: false } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' }, runId: 'run-1', repository: 'acme/plugin', migrationId: '0.2.0', store: evidenceFiles(), seal: true, log: () => {}, fetchImpl,
  })
  assert.equal(url, 'https://deploy.example/view/run-1')
  assert.deepEqual(paths, ['/runs', '/runs/run-1/finish', '/runs/run-1/evidence'])
})

test('an unsafe URL from the service is logged and not published', async () => {
  const logs: string[] = []
  const url = await publishRunEvidence({
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.example' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' }, runId: 'run-1', repository: 'acme/plugin', migrationId: '0.2.0', store: evidenceFiles(), log: message => logs.push(message),
    fetchImpl: async () => new Response(JSON.stringify({ url: 'javascript:alert(1)' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(url, undefined)
  assert.deepEqual(logs, ['run evidence: the service named an unsafe URL'])
})


test('a run that cannot be sealed is not given evidence', async () => {
  const paths: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    return path === '/runs'
      ? new Response(JSON.stringify({ url: 'https://deploy.example/view/run-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
  }
  const logs: string[] = []
  const url = await publishRunEvidence({
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.example', logStream: false } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' }, runId: 'run-1', repository: 'acme/plugin', migrationId: '0.2.0', store: evidenceFiles(), seal: true, log: message => logs.push(message), fetchImpl,
  })
  assert.equal(url, undefined)
  assert.deepEqual(paths, ['/runs', '/runs/run-1/finish', '/runs/run-1/finish'])
  assert.match(logs[0] ?? '', /could not be sealed/)
})
