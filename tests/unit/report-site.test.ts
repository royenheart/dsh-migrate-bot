import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fieldMetrics, fieldMigrations, type FieldMigration } from '../../src/evaluation/field.ts'
import { computeMetrics } from '../../src/evaluation/metrics.ts'
import { buildSite } from '../../scripts/site.ts'
import { storeSnapshot } from '../../scripts/snapshot.ts'
import { input, logOf, proposal, proposedEvents } from '../support/migration.ts'
import type { LogEntry } from '../../src/workflow/model.ts'
import type { BenchmarkRecord } from '../../src/evaluation/record.ts'

const at = (entries: LogEntry[], ...times: string[]): LogEntry[] => entries.map((entry, index) => ({ ...entry, at: times[index] ?? entry.at }))

test('a consumer migration reports when its proposal was published and how its pull request closed', () => {
  const events = proposedEvents(proposal(9))
  const log = logOf(input('0.2.0'), [...events, { type: 'pull-request.closed', number: 9, merged: true }])
  const times = [...log.map(() => '2026-10-01T00:00:00.000Z')]
  times[events.length] = '2026-10-01T06:00:00.000Z'
  times[events.length + 1] = '2026-10-02T06:00:00.000Z'
  const [migration] = fieldMigrations('acme/plugin', new Map([['0.2.0', at(log, ...times)]]))
  assert.deepEqual(migration?.proposal, {
    pullRequest: 9,
    url: 'https://github.com/acme/plugin/pull/9',
    publishedAt: '2026-10-01T06:00:00.000Z',
    closed: { at: '2026-10-02T06:00:00.000Z', merged: true },
  })
  const open = fieldMigrations('acme/plugin', new Map([['0.2.1', logOf(input('0.2.1'), proposedEvents())]]))
  assert.equal(open[0]?.proposal?.closed, undefined)
  assert.equal(fieldMigrations('acme/plugin', new Map([['0.2.2', logOf(input('0.2.2'), [])]]))[0]?.proposal, undefined)
})

test('field metrics count decided proposals, untouched merges and the median time to merge', () => {
  const migration = (closed: { at: string; merged: boolean } | undefined, maintainerCommits?: number): FieldMigration => ({
    consumer: 'acme/plugin',
    release: '0.2.0',
    state: 'reporting',
    startedAt: '2026-10-01T00:00:00Z',
    proposal: { pullRequest: 1, url: 'u', publishedAt: '2026-10-01T00:00:00Z', ...(closed === undefined ? {} : { closed }), ...(maintainerCommits === undefined ? {} : { maintainerCommits }) },
  })
  const metrics = fieldMetrics([
    migration({ at: '2026-10-01T02:00:00Z', merged: true }, 0),
    migration({ at: '2026-10-01T10:00:00Z', merged: true }, 2),
    migration({ at: '2026-10-01T05:00:00Z', merged: false }),
    migration(undefined),
    { consumer: 'acme/plugin', release: '0.1.0', state: 'compatible', startedAt: '2026-09-01T00:00:00Z' },
  ])
  assert.deepEqual(metrics, { proposals: 4, merged: 2, closedUnmerged: 1, open: 1, mergeRate: 2 / 3, mergedUntouched: 0.5, hoursToMergeP50: 6 })
  assert.deepEqual(fieldMetrics([]), { proposals: 0, merged: 0, closedUnmerged: 0, open: 0, mergeRate: null, mergedUntouched: null, hoursToMergeP50: null })
})

function writeRecord(records: string, id: string, createdAt: string, mutate: (record: BenchmarkRecord) => void = () => {}): void {
  const tasks = [{ id: 'M1', family: 'M', networkMode: 'public', agentTimeoutSec: 900, applicable: true, feasible: true }]
  const attempts: BenchmarkRecord['attempts'] = [{ task: 'M1', attempt: 1, trial: 'M1__x', outcome: 'scored', reward: 1, rewards: { reward: 1 }, durations: {}, artifacts: {} }]
  const record: BenchmarkRecord = {
    schema: 3,
    id,
    createdAt,
    producer: { commit: 'a'.repeat(40), version: '1.0.0', dirty: false, message: 'feat: a change', snapshot: storeSnapshot(records, new Map([['workflow.md', '# Workflow\n']])) },
    subject: { id: 'oracle', agentRuntime: 'none', attempts: 1, agentTimeoutMultiplier: 1 },
    suite: { repository: 'oh-my-dsh/dsh-plugin-upgrade-skill', commit: 'b'.repeat(40), tasks },
    model: { provider: 'none', model: 'none' },
    environment: { harbor: '0.24.0', docker: '29', os: 'Linux', concurrency: 1 },
    attempts,
    metrics: computeMetrics({ tasks, attempts, k: 1 }),
  }
  mutate(record)
  mkdirSync(join(records, 'records', id), { recursive: true })
  writeFileSync(join(records, 'records', id, 'record.json'), JSON.stringify(record))
}

test('the site carries the pages, the metric library, and the records newest first; an invalid record stops the build', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-site-'))
  try {
    const records = join(root, 'bench')
    writeRecord(records, 'old', '2026-10-01T00:00:00Z')
    writeRecord(records, 'new', '2026-10-02T00:00:00Z')
    const out = join(root, 'site')
    assert.equal(buildSite(records, out), 2)
    for (const page of ['index.html', 'compare.html', 'changes.html', 'task.html', 'diff.html', 'field.html', 'assets/metrics.js', 'data/records/new/record.json', 'data/snapshots/' + JSON.parse(readFileSync(join(records, 'records', 'new', 'record.json'), 'utf8')).producer.snapshot + '/files/workflow.md']) assert.ok(existsSync(join(out, page)), page)
    assert.doesNotMatch(readFileSync(join(out, 'assets', 'metrics.js'), 'utf8'), /^import /m)
    const index = JSON.parse(readFileSync(join(out, 'data', 'index.json'), 'utf8')) as { records: Array<{ id: string; attempts?: unknown }> }
    assert.deepEqual(index.records.map(record => record.id), ['new', 'old'])
    assert.equal(index.records[0]?.attempts, undefined)
    writeRecord(records, 'bad', '2026-10-03T00:00:00Z', (record) => { record.metrics.values.meanReward = 0.5 })
    assert.throws(() => buildSite(records, out), /bad: the stored metrics differ/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
