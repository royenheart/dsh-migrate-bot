import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateRecords } from '../../scripts/bench.ts'
import { botSnapshot, checkSnapshot, storeSnapshot } from '../../scripts/snapshot.ts'
import { attemptOf, finished, outcomeOf, type TrialResult } from '../../src/evaluation/harbor.ts'
import { AGENT_TIMEOUT, bootstrap, compare, computeMetrics, MIN_PAIRED_TASKS, taskScores, type MetricInput } from '../../src/evaluation/metrics.ts'
import type { Attempt, BenchmarkRecord, TaskEntry } from '../../src/evaluation/record.ts'

const task = (id: string, extra: Partial<TaskEntry> = {}): TaskEntry => ({ id, family: id[0] ?? 'M', networkMode: 'public', agentTimeoutSec: 1800, applicable: true, feasible: true, ...extra })

function attempt(taskId: string, reward: number | Attempt['outcome'], extra: Partial<Attempt> = {}): Attempt {
  const scored = typeof reward === 'number'
  return {
    task: taskId,
    attempt: 1,
    trial: `${taskId}__x`,
    outcome: scored ? 'scored' : reward,
    ...(scored ? { reward } : {}),
    rewards: scored ? { reward } : {},
    durations: { agentSec: 100 },
    artifacts: {},
    ...extra,
  }
}

const run = (tasks: TaskEntry[], attempts: Attempt[], k = 3): MetricInput => ({ tasks, attempts, k })

test('infrastructure attempts and ineligible tasks are not counted; a timeout or exception without a reward counts as 0', () => {
  const input = run(
    [task('M1'), task('M2', { feasible: false }), task('S1', { applicable: false })],
    [attempt('M1', 1), attempt('M1', 'timeout'), attempt('M1', 'infrastructure'), attempt('M1', 'exception'), attempt('M2', 1), attempt('S1', 1)],
  )
  assert.deepEqual(taskScores(input), [{ task: 'M1', family: 'M', rewards: [1, 0, 0] }])
  const { values } = computeMetrics(input)
  assert.equal(values.meanReward, 0.333333)
  assert.equal(values.infrastructureRate, 0.25)
  assert.equal(values.eligibleTasks, 1)
  assert.equal(values.infeasibleTasks, 1)
})

test('suite means weight every task equally', () => {
  const { values } = computeMetrics(run([task('M1'), task('M2')], [attempt('M1', 1), attempt('M1', 1), attempt('M1', 1), attempt('M2', 0)]))
  assert.equal(values.meanReward, 0.5)
  assert.equal(values['passRate@1.0'], 0.5)
  assert.equal(values['meanReward.M'], 0.5)
  assert.equal(values['meanReward.H'], null)
})

test('pass@k and pass^k follow the unbiased estimators, and fragility is the gap to pass@1', () => {
  // n = 4, c = 2, k = 2: pass@k = 1 - C(2,2)/C(4,2) = 5/6; pass^k = C(2,2)/C(4,2) = 1/6.
  const input = run([task('H1')], [attempt('H1', 1), attempt('H1', 1), attempt('H1', 0.5), attempt('H1', 0)], 2)
  const { values } = computeMetrics(input)
  assert.equal(values.passAtK, 0.833333)
  assert.equal(values.passHatK, 0.166667)
  assert.equal(values['passRate@1.0'], 0.5)
  assert.equal(values.fragility, 0.333333)
  assert.equal(values.unstableTaskShare, 1)
  // A task with fewer counted attempts than k has no pass@k.
  assert.equal(computeMetrics(run([task('H1')], [attempt('H1', 1)], 2)).values.passAtK, null)
})

test('usage and cost metrics read the reported usage only', () => {
  const usage = { inputTokens: 100, cacheHitTokens: 300, outputTokens: 10, usd: 0.5 }
  const { values } = computeMetrics(run([task('M1')], [attempt('M1', 1, { usage }), attempt('M1', 0, { usage }), attempt('M1', 0)]))
  assert.equal(values.cacheHitRatio, 0.75)
  assert.equal(values.costPerAttempt, 0.5)
  assert.equal(values.costPerSuccess, 1)
  assert.equal(values.inputTokens, 100)
})

test('the timeout rate counts timed-out attempts whether or not the verifier scored them', () => {
  const { values } = computeMetrics(run([task('M1')], [attempt('M1', 0.5, { exception: AGENT_TIMEOUT }), attempt('M1', 'timeout', { exception: AGENT_TIMEOUT }), attempt('M1', 1), attempt('M1', 1)]))
  assert.equal(values.timeoutRate, 0.5)
})

test('bootstrap intervals are deterministic and bracket the estimate', () => {
  const values = [0, 0.2, 0.5, 0.7, 1, 1, 1, 0.4]
  const statistic = (sample: readonly number[]): number => sample.reduce((sum, value) => sum + value, 0) / sample.length
  const first = bootstrap(values, statistic)
  assert.deepEqual(first, bootstrap(values, statistic))
  assert.ok(first !== undefined && first[0] < statistic(values) && statistic(values) < first[1])
  assert.equal(bootstrap([1], statistic), undefined)
})

test('a paired comparison reports a regression only when its interval excludes zero', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => task(`M${String(index)}`))
  const all = (reward: number): Attempt[] => tasks.map(entry => attempt(entry.id, reward))
  const [mean] = compare(run(tasks, all(1)), run(tasks, all(0)))
  assert.equal(mean?.verdict, 'regression')
  assert.equal(mean?.delta, -1)
  assert.equal(compare(run(tasks, all(1)), run(tasks, all(1)))[0]?.verdict, 'no-change')
  const noisy = tasks.map((entry, index) => attempt(entry.id, index % 2 === 0 ? 1 : 0))
  const flipped = tasks.map((entry, index) => attempt(entry.id, index % 2 === 0 ? 0 : 1))
  assert.equal(compare(run(tasks, noisy), run(tasks, flipped))[0]?.verdict, 'no-change')
  assert.equal(compare(run([task('M1')], [attempt('M1', 1)]), run([task('M2')], [attempt('M2', 1)]))[0]?.verdict, 'not-comparable')
  // Too few shared tasks give no verdict, however consistent their deltas.
  const few = tasks.slice(0, MIN_PAIRED_TASKS - 1)
  assert.deepEqual(compare(run(few, few.map(entry => attempt(entry.id, 1))), run(few, few.map(entry => attempt(entry.id, 0))))[0], { metric: 'meanReward', tasks: MIN_PAIRED_TASKS - 1, delta: -1, verdict: 'not-comparable' })
})

const trial = (extra: Partial<TrialResult>): TrialResult => ({ task_name: 'M1', trial_name: 'M1__abc', ...extra })
const span = { started_at: '2026-10-10T00:00:00Z', finished_at: '2026-10-10T00:01:30Z' }

test('the outcome of a trial is the phase that stopped it', () => {
  assert.equal(outcomeOf(trial({ verifier_result: { rewards: { reward: 0.5 } }, exception_info: { exception_type: AGENT_TIMEOUT }, agent_execution: span, verifier: span })), 'scored')
  assert.equal(outcomeOf(trial({ agent_execution: span, verifier: span, exception_info: { exception_type: 'RewardFileNotFoundError' } })), 'infrastructure')
  assert.equal(outcomeOf(trial({ agent_execution: span, exception_info: { exception_type: AGENT_TIMEOUT } })), 'timeout')
  assert.equal(outcomeOf(trial({ agent_execution: span, exception_info: { exception_type: 'RuntimeError' } })), 'exception')
  assert.equal(outcomeOf(trial({ exception_info: { exception_type: 'EnvironmentStartTimeoutError' } })), 'infrastructure')
})

test('a trial Harbor stopped has not finished, so the run resumes it rather than recording it', () => {
  assert.equal(finished(trial({ agent_execution: { started_at: span.started_at }, exception_info: { exception_type: 'CancelledError' } })), false)
  assert.equal(finished(trial({ agent_execution: span, exception_info: { exception_type: AGENT_TIMEOUT } })), true)
})

test('an attempt separates cache hits from Harbor input tokens and keeps the agent exit code', () => {
  const parsed = attemptOf(trial({
    started_at: '2026-10-10T00:00:00Z',
    finished_at: '2026-10-10T00:05:00Z',
    agent_execution: span,
    agent_result: { n_input_tokens: 1000, n_cache_tokens: 800, n_output_tokens: 50, cost_usd: 0.01, metadata: { agent_exit_code: 1 } },
    verifier_result: { rewards: { reward: 1, build: 1 } },
  }))
  assert.deepEqual(parsed, {
    task: 'M1',
    trial: 'M1__abc',
    outcome: 'scored',
    reward: 1,
    rewards: { reward: 1, build: 1 },
    agentExitCode: 1,
    durations: { agentSec: 90, totalSec: 300 },
    usage: { inputTokens: 200, cacheHitTokens: 800, outputTokens: 50, usd: 0.01 },
  })
})

test('a record validates while its metrics and kept files are what its attempts say', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-records-'))
  try {
    const id = 'aaaaaaaaaaaa__bbbbbbbbbbbb__session__20261010T000000Z'
    const dir = join(root, 'records', id)
    mkdirSync(join(dir, 'attempts', 'M1__x', 'agent'), { recursive: true })
    const diff = 'diff --git a/fixture/a b/fixture/a\n'
    writeFileSync(join(dir, 'attempts', 'M1__x', 'agent', 'proposed.diff'), diff)
    const tasks = [task('M1')]
    const attempts = [attempt('M1', 1, { artifacts: { 'agent/proposed.diff': { path: 'attempts/M1__x/agent/proposed.diff', sha256: createHash('sha256').update(diff).digest('hex'), bytes: diff.length } } })]
    const record: BenchmarkRecord = {
      schema: 3,
      id,
      createdAt: '2026-10-10T00:00:00Z',
      producer: { commit: 'a'.repeat(40), version: '1.0.0', dirty: false, message: 'feat: a change', snapshot: storeSnapshot(root, new Map([['prompts/overlap.md', 'Review the plugin.\n']])) },
      subject: { id: 'session', agentRuntime: '0.2.0-rc.2', attempts: 1, agentTimeoutMultiplier: 1 },
      suite: { repository: 'oh-my-dsh/dsh-plugin-upgrade-skill', commit: 'b'.repeat(40), tasks },
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      environment: { harbor: '0.24.0', docker: '29.6.1', os: 'Linux', concurrency: 1 },
      attempts,
      metrics: computeMetrics({ tasks, attempts, k: 1 }),
    }
    const write = (value: BenchmarkRecord): void => { writeFileSync(join(dir, 'record.json'), JSON.stringify(value)) }
    write(record)
    assert.deepEqual(validateRecords(root), [])
    write({ ...record, metrics: { ...record.metrics, values: { ...record.metrics.values, meanReward: 0.9 } } })
    assert.deepEqual(validateRecords(root), [`${id}: the stored metrics differ from the metrics its attempts compute to`])
    write(record)
    writeFileSync(join(dir, 'attempts', 'M1__x', 'agent', 'proposed.diff'), 'edited\n')
    assert.deepEqual(validateRecords(root), [`${id}: attempts/M1__x/agent/proposed.diff is missing or changed`])
    // A kept output must not quote a session token.
    writeFileSync(join(dir, 'attempts', 'M1__x', 'agent', 'proposed.diff'), diff)
    const output = 'dsh web: http://127.0.0.1:4100/?token=f00d\n'
    mkdirSync(join(dir, 'attempts', 'M1__x', 'verifier'), { recursive: true })
    writeFileSync(join(dir, 'attempts', 'M1__x', 'verifier', 'test-stdout.txt'), output)
    const first = attempts[0] as Attempt
    const kept = { ...first.artifacts, 'verifier/test-stdout.txt': { path: 'attempts/M1__x/verifier/test-stdout.txt', sha256: createHash('sha256').update(output).digest('hex'), bytes: output.length } }
    write({ ...record, attempts: [{ ...first, artifacts: kept }] })
    assert.deepEqual(validateRecords(root), [`${id}: attempts/M1__x/verifier/test-stdout.txt keeps a session token`])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a snapshot is stored once per content, and a changed file or a missing snapshot fails validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-snapshot-'))
  try {
    const files = new Map([['prompts/overlap.md', 'Review the plugin.\n'], ['workflow.md', '# Workflow\n']])
    const hash = storeSnapshot(root, files)
    assert.equal(storeSnapshot(root, new Map([...files].reverse())), hash)
    assert.notEqual(storeSnapshot(root, new Map([...files, ['workflow.md', '# Workflow v2\n']])), hash)
    assert.deepEqual(checkSnapshot(root, hash), [])
    writeFileSync(join(root, 'snapshots', hash, 'files', 'workflow.md'), '# edited\n')
    assert.deepEqual(checkSnapshot(root, hash), [`snapshot ${hash}: workflow.md is missing or changed`])
    assert.deepEqual(checkSnapshot(root, '0'.repeat(16)), [`snapshot ${'0'.repeat(16)} is missing`])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the snapshot of this checkout holds the statechart, every prompt, the runtime and the skills', async () => {
  const files = await botSnapshot()
  for (const path of ['workflow.md', 'configuration.md', 'prompts/overlap.md', 'prompts/extension-points.md', 'prompts/repair.md', 'prompts/e2e-authoring.md', 'prompts/report-upgrade-skill.md', 'runtime/agent-runtime.json', 'runtime/profile/migrate-runner.js', 'skills.json']) {
    assert.ok((files.get(path) ?? '').length > 0, path)
  }
  assert.match(files.get('prompts/repair.md') ?? '', /<output of the failing check>/)
  assert.match(files.get('workflow.md') ?? '', /stateDiagram|flowchart|graph/)
})
