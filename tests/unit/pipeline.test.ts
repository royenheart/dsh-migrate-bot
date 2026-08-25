import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

test('A and B prompts include the harness checkout note', async () => {
  const store = createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-')))
  const seen: string[] = []
  const agent = {
    async run(request: AgentRequest): Promise<AgentResult> {
      seen.push(request.prompt)
      return { report: `${request.kind} ok`, raw: `${request.kind} ok` }
    },
  }
  await runPipeline({
    config: parseConfig({}),
    workdir: process.cwd(),
    target: target(),
    store,
    apiKey: 'k',
    runMechanical: () => ({ ok: true, errors: '', log: 'ok' }),
    isDirty: () => false,
    diff: () => '',
    agent,
    harness: { path: '/opt/harness', tag: 'dsh-v0.1.1-rc.2' },
  })
  assert.match(seen[0] ?? '', /\/opt\/harness/)
  assert.match(seen[1] ?? '', /dsh-v0\.1\.1-rc\.2/)
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

test('this-run USD limit aborts before B after A reports usage', async () => {
  const store = createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-')))
  const calls: AgentRequest['kind'][] = []
  const agent = {
    async run(request: AgentRequest): Promise<AgentResult> {
      calls.push(request.kind)
      return {
        report: `${request.kind} ok`,
        raw: `${request.kind} ok`,
        usage: {
          turns: 1,
          steps: 1,
          elapsedSeconds: 10,
          inputTokens: 8000,
          outputTokens: 2000,
          cacheHitTokens: 1000,
          cacheMissTokens: 8000,
          costUsd: 0.02,
        },
      }
    },
  }
  await assert.rejects(
    () => runPipeline({
      config: parseConfig({ quota: { limit: 0.01 } }),
      workdir: process.cwd(),
      target: target(),
      store,
      apiKey: 'k',
      runMechanical: () => ({ ok: true, errors: '', log: 'ok' }),
      isDirty: () => false,
      diff: () => '',
      agent,
      quota: {
        query: () => Promise.resolve({
          kind: 'available',
          provider: 'deepseek-official',
          queriedAt: '2026-08-17T00:00:00.000Z',
          remaining: 99,
          currency: 'CNY',
        }),
      },
    }),
    /quota limit exceeded/,
  )
  assert.deepEqual(calls, ['absorption'])
})

test('insufficient official balance aborts before the agent', async () => {
  const store = createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-')))
  const agent = fakeAgent()
  await assert.rejects(
    () => runPipeline({
      config: parseConfig({}),
      workdir: process.cwd(),
      target: target(),
      store,
      apiKey: 'k',
      runMechanical: () => ({ ok: true, errors: '', log: 'ok' }),
      isDirty: () => false,
      diff: () => '',
      agent,
      quota: {
        query: () => Promise.resolve({
          kind: 'unavailable',
          provider: 'deepseek-official',
          queriedAt: '2026-08-17T00:00:00.000Z',
          remaining: 0,
          currency: 'CNY',
        }),
      },
    }),
    /insufficient balance/,
  )
  assert.deepEqual(agent.calls, [])
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

test('opened Issue gets a comment with the patch-report table and bodies', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-mig-issue-'))
  const reportDir = join(workdir, '.dsh-migrate/patch-reports/pre-step')
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'report.md'), '# [Feature request] pre-step\n\ndraft')
  const comments: string[] = []
  const github: GithubPublisher = {
    async publish() {
      return {
        issueUrl: 'https://example.test/i/3',
        issueNumber: 3,
        pullRequestUrl: 'https://example.test/p/3',
      }
    },
    async commentIssue(issueNumber, body) {
      assert.equal(issueNumber, 3)
      comments.push(body)
    },
  }
  await runPipeline({
    config: parseConfig({ review: { policy: 'skip-if-mechanical-pass' } }),
    workdir,
    target: target(),
    store: createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-'))),
    apiKey: 'k',
    runMechanical: () => ({ ok: true, errors: '', log: 'ok' }),
    isDirty: () => true,
    diff: () => 'diff --git a/x',
    agent: fakeAgent(),
    github,
  })
  assert.equal(comments.length, 1)
  assert.match(comments[0] ?? '', /Companion PR: https:\/\/example\.test\/p\/3/)
  assert.match(comments[0] ?? '', /## Patch report index/)
  assert.match(comments[0] ?? '', /## pre-step/)
  assert.match(comments[0] ?? '', /draft/)
})
