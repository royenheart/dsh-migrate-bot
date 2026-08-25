import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../../src/config/load.ts'
import { createReportStore } from '../../src/reports/store.ts'
import { runPipeline } from '../../src/pipeline/orchestrator.ts'
import type { AgentRequest, AgentResult } from '../../src/agents/types.ts'
import type { MechanicalResult } from '../../src/mechanical/run.ts'
import type { GithubPublisher } from '../../src/pipeline/types.ts'

function target() {
  return { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' }
}

function fakeAgent(reports: Partial<Record<AgentRequest['kind'], string>> = {}) {
  const calls: AgentRequest['kind'][] = []
  return {
    calls,
    async run(request: AgentRequest): Promise<AgentResult> {
      calls.push(request.kind)
      const report = reports[request.kind] ?? `${request.kind} ok`
      return { report, raw: report }
    },
  }
}

test('skip-if-mechanical-pass on a clean tree does not review or publish', async () => {
  const store = createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-')))
  const published: string[] = []
  const github: GithubPublisher = {
    async publish() {
      published.push('yes')
      return { issueUrl: 'https://example.test/i/1' }
    },
  }
  const agent = fakeAgent()
  const result = await runPipeline({
    config: parseConfig({ review: { policy: 'skip-if-mechanical-pass' } }),
    workdir: process.cwd(),
    target: target(),
    store,
    apiKey: 'k',
    runMechanical: () => ({ ok: true, errors: '', log: 'ok' }),
    isDirty: () => false,
    diff: () => '',
    agent,
    github,
  })
  assert.equal(result.status, 'compatible')
  assert.equal(result.skippedReview, true)
  assert.deepEqual(agent.calls, [])
  assert.deepEqual(published, [])
})

test('always reviews even when mechanical already passed', async () => {
  const store = createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-')))
  const agent = fakeAgent()
  const result = await runPipeline({
    config: parseConfig({ review: { policy: 'always' } }),
    workdir: process.cwd(),
    target: target(),
    store,
    apiKey: 'k',
    runMechanical: () => ({ ok: true, errors: '', log: 'ok' }),
    isDirty: () => false,
    diff: () => '',
    agent,
  })
  assert.deepEqual(agent.calls, ['absorption', 'alignment'])
  assert.equal(result.status, 'compatible')
  assert.equal(store.read('A'), 'absorption ok')
})

test('failed retest starts C-loop with errors only and stops when green', async () => {
  const store = createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-')))
  const mechanical: MechanicalResult[] = [
    { ok: false, errors: 'error: first', log: 'FULL LOG one' },
    { ok: false, errors: 'error: after-review', log: 'FULL LOG two' },
    { ok: true, errors: '', log: 'ok' },
  ]
  const agent = fakeAgent({
    fix: 'changed client.js',
  })
  let seenPrompt = ''
  const wrapped = {
    async run(request: AgentRequest): Promise<AgentResult> {
      if (request.kind === 'fix') seenPrompt = request.prompt
      return agent.run(request)
    },
  }
  const result = await runPipeline({
    config: parseConfig({ loop: { maxAttempts: 3 } }),
    workdir: process.cwd(),
    target: target(),
    store,
    apiKey: 'k',
    runMechanical: () => mechanical.shift() ?? { ok: true, errors: '', log: '' },
    isDirty: () => false,
    diff: () => '',
    agent: wrapped,
  })
  assert.equal(result.fixAttempts, 1)
  assert.equal(result.status, 'compatible')
  assert.match(seenPrompt, /error: after-review/)
  assert.doesNotMatch(seenPrompt, /FULL LOG/)
  assert.equal(store.read('C1'), 'changed client.js')
})

test('dirty tree publishes Issue and PR; clean tree never does', async () => {
  const store = createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-')))
  const titles: string[] = []
  const branches: string[] = []
  const github: GithubPublisher = {
    async publish(input) {
      titles.push(input.title)
      branches.push(input.branch)
      return { issueUrl: 'https://example.test/i/2', pullRequestUrl: 'https://example.test/p/2' }
    },
  }
  const dirty = await runPipeline({
    config: parseConfig({ review: { policy: 'skip-if-mechanical-pass' } }),
    workdir: process.cwd(),
    target: target(),
    store,
    apiKey: 'k',
    runMechanical: () => ({ ok: true, errors: '', log: 'ok' }),
    isDirty: () => true,
    diff: () => 'diff --git a/x',
    agent: fakeAgent(),
    github,
  })
  assert.equal(dirty.status, 'migrated')
  assert.equal(dirty.published.pullRequestUrl, 'https://example.test/p/2')
  assert.equal(titles.length, 1)
  assert.match(branches[0] ?? '', /^dsh-migrate\/0\.1\.1-rc\.2-/)
})
