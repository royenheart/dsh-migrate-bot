import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseConfig } from '../../src/config/load.ts'
import { runMechanical } from '../../src/mechanical/run.ts'
import { checkoutHarness } from '../../src/harness/checkout.ts'
import { AgentTimeoutError, createDshRunner } from '../../src/agents/dsh.ts'
import { PACKAGE_ROOT } from '../../src/paths.ts'

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-timeout-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

test('the watchdog defaults are set and overridable', () => {
  const config = parseConfig({})
  assert.equal(config.timeouts.agentMs, 3_600_000)
  assert.equal(config.timeouts.commandMs, 1_200_000)
  assert.equal(config.timeouts.checkoutMs, 600_000)
  const tuned = parseConfig({ timeouts: { agentMs: 5000, commandMs: 4000, checkoutMs: 3000 } })
  assert.deepEqual(tuned.timeouts, { agentMs: 5000, commandMs: 4000, checkoutMs: 3000 })
})

test('nonsense watchdog values are rejected rather than silently ignored', () => {
  assert.throws(() => parseConfig({ timeouts: { agentMs: 10 } }), /timeouts\.agentMs/)
  assert.throws(() => parseConfig({ timeouts: { commandMs: 'soon' } }), /timeouts\.commandMs/)
  assert.throws(() => parseConfig({ timeouts: [] }), /expected object[\s\S]*at timeouts/)
})

test('a hung mechanical command is killed by the watchdog and reported as a failure', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ name: 'p', scripts: {} }) })
  try {
    const started = Date.now()
    const result = runMechanical(dir, parseConfig({ tests: { commands: ['sleep 30'] } }), { timeoutMs: 1_500 })
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.match(result.errors, /timed out after \d+s \(watchdog\): sleep 30/)
    assert.ok(elapsed < 20_000, `the watchdog must cut the command short, took ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a command that finishes inside the watchdog is unaffected', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ name: 'p', scripts: {} }) })
  try {
    const result = runMechanical(dir, parseConfig({ tests: { commands: ['echo fine'] } }), { timeoutMs: 30_000 })
    assert.equal(result.ok, true, result.errors)
    assert.match(result.log, /fine/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stalled harness checkout fails with a watchdog message instead of hanging', () => {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-mig-co-'))
  try {
    // A git runner that never returns is simulated by returning the shape git
    // produces when spawnSync hits its own timeout.
    const stalled = spawnSync('sleep', ['30'], { timeout: 1_000, encoding: 'utf8', killSignal: 'SIGKILL' })
    assert.equal((stalled.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', 'precondition')
    const result = checkoutHarness({ tag: 'dsh-v0.1.5-rc.1', dest, git: () => stalled })
    assert.equal(result.ok, false)
    assert.match(result.detail ?? '', /timed out \(watchdog\)/)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('a session that outlives its watchdog throws instead of holding the job', async () => {
  const runner = createDshRunner({
    timeoutMs: 25,
    spawnImpl: async (_args, options) => {
      assert.equal(options.timeoutMs, 25, 'the runner must pass its watchdog to the spawn')
      return { code: 143, stdout: 'partial output', stderr: 'working…', timedOut: true }
    },
  })
  await assert.rejects(
    () => runner.run({
      kind: 'fix',
      prompt: 'p',
      workdir: process.cwd(),
      agent: { provider: 'deepseek-official', model: 'm', thinking: 'enabled', reasoningEffort: 'max' },
      apiKey: 'k',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTimeoutError)
      assert.match(error.message, /exceeded its 0s watchdog|exceeded its 25s watchdog/)
      assert.match(error.message, /working/)
      return true
    },
  )
})

test('a session that finishes normally still returns its report', async () => {
  const runner = createDshRunner({
    timeoutMs: 1_000,
    spawnImpl: async (_args, options) => {
      assert.equal(options.timeoutMs, 1_000)
      return { code: 0, stdout: '# Report\nok\n', stderr: '', timedOut: false }
    },
  })
  const result = await runner.run({
    kind: 'absorption',
    prompt: 'p',
    workdir: process.cwd(),
    agent: { provider: 'deepseek-official', model: 'm', thinking: 'enabled', reasoningEffort: 'max' },
    apiKey: 'k',
  })
  assert.equal(result.report, '# Report\nok')
})

test('the package root a session is given holds the accounting that prices it', () => {
  assert.ok(existsSync(join(PACKAGE_ROOT, 'dist', 'src', 'agents', 'session-status.js')), `no session accounting under ${PACKAGE_ROOT}`)
})
