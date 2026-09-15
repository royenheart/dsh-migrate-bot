import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../../src/config/load.ts'
import { createReportStore } from '../../src/reports/store.ts'
import { runPipeline } from '../../src/pipeline/orchestrator.ts'
import type { AgentRequest, AgentResult } from '../../src/agents/types.ts'
import type { PipelinePorts, VerificationResult } from '../../src/pipeline/types.ts'

const target = { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1' }

function store() {
  return createReportStore(mkdtempSync(join(tmpdir(), 'dsh-mig-v-')))
}

function agentReturning(reportFor: (request: AgentRequest) => string = request => `${request.kind} ok`) {
  const calls: AgentRequest['kind'][] = []
  return {
    calls,
    async run(request: AgentRequest): Promise<AgentResult> {
      calls.push(request.kind)
      const report = reportFor(request)
      return { report, raw: report }
    },
  }
}

function boot(ok: boolean, signature = ok ? 'pass' : 'load: broken'): VerificationResult {
  return { ok, layer: 'boot', signature, detail: ok ? '' : 'dsh: plugin(s) failed to load: broken' }
}

function e2e(ok: boolean, signature = ok ? 'e2e: pass' : 'e2e: 1) settings panel'): VerificationResult {
  return { ok, layer: 'e2e', signature, detail: ok ? '' : '1) settings panel failed' }
}

function ports(overrides: Partial<PipelinePorts> & { config?: ReturnType<typeof parseConfig> } = {}): PipelinePorts {
  const config = overrides.config ?? parseConfig({})
  return {
    config,
    workdir: process.cwd(),
    target,
    store: store(),
    apiKey: 'k',
    runMechanical: () => ({ ok: true, errors: '', log: 'ok', checks: 1 }),
    isDirty: () => true,
    diff: () => '',
    agent: agentReturning(),
    ...overrides,
  }
}

test('a failing boot probe drives a repair round and then converges', async () => {
  let round = 0
  const agent = agentReturning()
  const result = await runPipeline(ports({
    agent,
    probeTarget: async () => {
      round += 1
      return round === 1 ? boot(false) : boot(true)
    },
  }))
  assert.deepEqual(agent.calls, ['absorption', 'alignment', 'fix'])
  assert.equal(result.fixAttempts, 1)
  assert.equal(result.status, 'migrated')
  assert.equal(result.verification?.ok, true)
  assert.equal(result.stoppedBy, 'budget')
})

test('two rounds with the same failure signature stop the loop early', async () => {
  const agent = agentReturning()
  const result = await runPipeline(ports({
    agent,
    probeTarget: async () => boot(false, 'load: same every time'),
  }))
  // One repair attempt, then the unchanged signature ends the loop.
  assert.equal(result.fixAttempts, 1)
  assert.equal(result.stoppedBy, 'stalled')
  assert.equal(result.status, 'failed')
})

test('the line that reports a stalled signature is one line', async () => {
  // A signature is the probe's own output — npm's text, the harness's text — and
  // this line is written to stdout unprefixed.
  const logged: string[] = []
  const signature = 'probe unavailable: npm error code ECONNREFUSED\nnpm error syscall connect\n::add-mask::forged'
  const result = await runPipeline(ports({
    agent: agentReturning(),
    probeTarget: async () => boot(false, signature),
  }), { info: (message: string) => logged.push(message) })
  assert.equal(result.stoppedBy, 'stalled')
  const line = logged.find(message => message.includes('failure signature unchanged'))
  assert.notEqual(line, undefined)
  assert.equal(line?.split('\n').length, 1)
  assert.deepEqual(logged.filter(message => message.split('\n').some(part => part.startsWith('::'))), [])
})

test('a changing signature keeps spending the full budget', async () => {
  let round = 0
  const agent = agentReturning()
  const result = await runPipeline(ports({
    agent,
    config: parseConfig({ loop: { maxAttempts: 3 } }),
    probeTarget: async () => {
      round += 1
      return boot(false, `load: failure ${round}`)
    },
  }))
  assert.equal(result.fixAttempts, 3)
  assert.equal(result.stoppedBy, 'budget')
  assert.equal(result.status, 'failed')
})

test('an evidence-backed upstream blocker stops the loop after one round', async () => {
  const agent = agentReturning(request => (request.kind === 'fix'
    ? `BLOCKER: upstream
REASON: missing slot.
ATTEMPTED: renamed the registration, still fails.
HARNESS: packages/client/ui-slots/src/index.ts:120
WHY-NOT-PLUGIN: the host resolves the slot before plugins run.
`
    : `${request.kind} ok`))
  const result = await runPipeline(ports({
    agent,
    probeTarget: async () => boot(false, 'load: broken'),
  }))
  assert.equal(result.fixAttempts, 1)
  assert.equal(result.stoppedBy, 'blocker')
})

test('a blocker without evidence does not stop the loop', async () => {
  const agent = agentReturning(request => (request.kind === 'fix'
    ? 'BLOCKER: upstream\nREASON: this is hard.\n'
    : `${request.kind} ok`))
  const result = await runPipeline(ports({
    agent,
    config: parseConfig({ loop: { maxAttempts: 2 } }),
    // Signatures differ so the stalled-signature rule cannot end it either.
    probeTarget: (() => {
      let round = 0
      return async () => {
        round += 1
        return boot(false, `load: attempt ${round}`)
      }
    })(),
  }))
  assert.equal(result.fixAttempts, 2)
  assert.notEqual(result.stoppedBy, 'blocker')
})

test('a boot failure fails the run even when the e2e gate is advisory', async () => {
  const result = await runPipeline(ports({
    probeTarget: async () => boot(false, 'load: broken'),
    runE2E: async () => e2e(true),
  }))
  assert.equal(result.status, 'failed')
  assert.equal(result.verification?.layer, 'boot')
})

test('an e2e failure is reported but not fatal under the advisory gate', async () => {
  const result = await runPipeline(ports({
    config: parseConfig({ e2e: { gate: 'advisory' } }),
    probeTarget: async () => boot(true),
    runE2E: async () => e2e(false),
  }))
  assert.equal(result.verification?.ok, false)
  assert.equal(result.verification?.layer, 'e2e')
  assert.equal(result.status, 'migrated')
})

test('the same e2e failure is fatal under the blocking gate', async () => {
  const result = await runPipeline(ports({
    config: parseConfig({ e2e: { gate: 'blocking' }, loop: { maxAttempts: 1 } }),
    probeTarget: async () => boot(true),
    runE2E: async () => e2e(false),
  }))
  assert.equal(result.status, 'failed')
})

test('a passing loop still runs the full suite once at the end', async () => {
  const modes: string[] = []
  const result = await runPipeline(ports({
    probeTarget: async () => boot(true),
    runE2E: async (mode) => {
      modes.push(mode)
      return e2e(true)
    },
  }))
  assert.deepEqual(modes, ['subset', 'full'])
  assert.equal(result.verification?.ok, true)
})

test('the boot probe short-circuits the browser suite while it is failing', async () => {
  let e2eCalls = 0
  await runPipeline(ports({
    config: parseConfig({ loop: { maxAttempts: 1 } }),
    probeTarget: async () => boot(false, 'load: broken'),
    runE2E: async () => {
      e2eCalls += 1
      return e2e(true)
    },
  }))
  assert.equal(e2eCalls, 0)
})

test('a failed fast gate skips verification entirels and reports it', async () => {
  const result = await runPipeline(ports({
    runMechanical: () => ({ ok: false, errors: 'TS2304: cannot find name', log: '', checks: 1 }),
    probeTarget: async () => boot(true),
    config: parseConfig({ loop: { maxAttempts: 1 } }),
  }))
  assert.equal(result.status, 'failed')
  assert.match(result.verification?.signature ?? '', /fast-gate/)
})

test('the E2E branch sync runs after verification and never blocks the run', async () => {
  let synced = 0
  const result = await runPipeline(ports({
    probeTarget: async () => boot(true),
    runE2E: async () => e2e(true),
    syncE2E: async () => {
      synced += 1
      return { ok: false, pushed: false, reason: 'push-failed', detail: 'no credentials' }
    },
  }))
  assert.equal(synced, 1)
  assert.equal(result.status, 'migrated')
  assert.equal(result.e2eSync?.reason, 'push-failed')
})

test('attribution reaches the result and the fix prompt', async () => {
  const prompts: string[] = []
  const agent = {
    async run(request: AgentRequest): Promise<AgentResult> {
      prompts.push(request.prompt)
      return { report: `${request.kind} ok`, raw: '' }
    },
  }
  const attribution = {
    preExisting: true,
    regression: false,
    summary: 'baseline already broken (state): look further back than from→to',
  }
  const result = await runPipeline(ports({
    agent,
    attribution,
    config: parseConfig({ loop: { maxAttempts: 1 } }),
    probeTarget: async () => boot(false, 'load: broken'),
  }))
  assert.equal(result.attribution?.preExisting, true)
  assert.match(prompts.at(-1) ?? '', /look further back than from→to/)
})

test('the web smoke runs once, at final verification, and never inside the loop', async () => {
  const calls: string[] = []
  await runPipeline(ports({
    probeTarget: async () => boot(true),
    probeWeb: async () => {
      calls.push('web')
      return { ok: true, layer: 'web', signature: 'web: server ready', detail: '' }
    },
    runE2E: async (mode) => {
      calls.push(`e2e:${mode}`)
      return e2e(true)
    },
  }))
  assert.deepEqual(calls, ['e2e:subset', 'web', 'e2e:full'])
})

test('a web smoke failure fails the run like a boot failure', async () => {
  const result = await runPipeline(ports({
    probeTarget: async () => boot(true),
    probeWeb: async () => ({
      ok: false,
      layer: 'web',
      signature: 'web: exited before serving',
      detail: 'dsh web: exited',
    }),
    runE2E: async () => e2e(true),
  }))
  assert.equal(result.status, 'failed')
  assert.equal(result.verification?.layer, 'web')
})

test('a skipped web smoke does not count as a failure', async () => {
  const result = await runPipeline(ports({
    probeTarget: async () => boot(true),
    probeWeb: async () => ({
      ok: true,
      layer: 'web',
      signature: 'web: no client surface',
      detail: '',
      skipped: 'the plugin declares no dsh.client surface',
    }),
    runE2E: async () => e2e(true),
  }))
  assert.equal(result.status, 'migrated')
  assert.equal(result.verification?.ok, true)
})

test('a run with no verification ports still completes and says so', async () => {
  // This is the shape the live e2e and any `verify.*: false` configuration
  // takes: no probe, no suite, so verification must not silently claim a pass
  // it never earned.
  const result = await runPipeline(ports({}))
  assert.equal(result.status, 'migrated')
  assert.equal(result.verification?.ok, true)
  assert.match(result.verification?.skipped ?? '', /no verification layer is enabled/)
})

test('disabling the fast gate path still reports the failing layer honestly', async () => {
  const result = await runPipeline(ports({
    probeTarget: async () => boot(true),
    runE2E: async () => e2e(true),
  }))
  assert.equal(result.verification?.layer, 'e2e')
  assert.equal(result.verification?.skipped, undefined)
})
