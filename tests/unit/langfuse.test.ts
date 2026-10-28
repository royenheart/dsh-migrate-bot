import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LangfuseExporter, buildOtlpPayload, langfuseSettings, traceIdFor } from '../../src/observability/langfuse.ts'
import { buildRunManifest } from '../../src/observability/manifest.ts'
import { sha256 } from '../../src/observability/manifest.ts'
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
  toolCalls: 1,
  observations: [
    { seq: 1, time: Date.parse('2026-10-27T13:00:10.000Z'), type: 'tool-call', tool: { name: 'read', arguments: '{\"path\":\"a.ts\"}' } },
    { seq: 2, time: Date.parse('2026-10-27T13:00:11.000Z'), type: 'tool-result', tool: { name: 'read', result: 'ok', failed: false } },
    { seq: 3, time: Date.parse('2026-10-27T13:00:20.000Z'), type: 'assistant', turn: 1, step: 1, text: 'done', usage: { inputTokens: 10, outputTokens: 2, cacheHitTokens: 0 } },
  ],
}

const manifest = buildRunManifest({
  runId: '123-1',
  migrationId: '0.2.1-rc.2',
  plugin: ['plugin'],
  target: { tag: 'dsh-v0.2.1-rc.2', version: '0.2.1-rc.2' },
  agent,
  sessions: [session],
  checks: [{ check: 'mechanical', outcome: 'pass' }],
  outcome: 'accepted',
  startedAt: '2026-10-27T13:00:00.000Z',
  endedAt: '2026-10-27T13:06:00.000Z',
  traceId: traceIdFor('123-1'),
})

test('OTLP payload carries a trace, an agent session, a tool and a generation', () => {
  const payload = buildOtlpPayload(manifest, [session])
  const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? []
  assert.equal(spans.length, 4)
  assert.equal(spans[0]?.traceId, traceIdFor('123-1'))
  assert.equal(spans.every(span => span.traceId === traceIdFor('123-1')), true)
  const types = spans.flatMap(span => span.attributes.filter(attribute => attribute.key === 'langfuse.observation.type').map(attribute => attribute.value))
  assert.deepEqual(types, [{ stringValue: 'span' }, { stringValue: 'agent' }, { stringValue: 'tool' }, { stringValue: 'generation' }])
  assert.equal(spans.find(span => span.name.startsWith('tool '))?.parentSpanId, spans[1]?.spanId)
  assert.equal(spans.find(span => span.name.startsWith('assistant '))?.parentSpanId, spans[1]?.spanId)
})

test('the exporter posts OTLP JSON with basic auth and the real-time header', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const exporter = new LangfuseExporter(
    { host: 'https://langfuse.example', publicKey: 'pk-lf-test', secretKey: 'sk-lf-test' },
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response('{}', { status: 200 })
    },
  )
  const result = await exporter.export(manifest, [session])
  assert.equal(result.exported, true)
  assert.equal(calls[0]?.url, 'https://langfuse.example/api/public/otel/v1/traces')
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`)
  assert.equal((calls[0]?.init.headers as Record<string, string>)['x-langfuse-ingestion-version'], '4')
  assert.match(String(calls[0]?.init.body), /resourceSpans/)
})

test('a failed export is reported, never thrown', async () => {
  const exporter = new LangfuseExporter(
    { host: 'https://langfuse.example', publicKey: 'pk', secretKey: 'sk' },
    async () => new Response('nope', { status: 401 }),
  )
  const result = await exporter.export(manifest, [session])
  assert.equal(result.exported, false)
  assert.match(result.detail ?? '', /401/)
})

test('the exporter is disabled without all three variables', () => {
  assert.equal(langfuseSettings({}), undefined)
  assert.equal(langfuseSettings({ LANGFUSE_HOST: 'https://x', LANGFUSE_PUBLIC_KEY: 'pk' }), undefined)
  assert.deepEqual(langfuseSettings({ LANGFUSE_HOST: 'https://x/', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }), {
    host: 'https://x',
    publicKey: 'pk',
    secretKey: 'sk',
  })
})
