import { chip, day, diffHref, escape, fail, fmt, interval, loadField, loadIndex, loadRecord, nav, params, select, setParams, short } from './common.js'
import { choosePair } from './pairing.js'
import { compare, METRICS, pairedTaskCount } from './metrics.js'

nav('Overview')

const $ = id => document.getElementById(id)
const state = { index: undefined, suite: '', subject: '', base: params.get('base') ?? '', head: params.get('head') ?? '', task: params.get('task') ?? '' }
let selectionVersion = 0
let taskVersion = 0

/** How many records one task detail loads; the table names the cap when it applies. */
const TASK_HISTORY_LIMIT = 50

const label = record => `${record.subject.id} · ${short(record.producer.commit)} · ${day(record.createdAt)}`
const pairLabel = record => record.suite.repository === state.suite ? label(record) : `${record.suite.repository} · ${label(record)}`
const attemptInput = record => ({ tasks: record.suite.tasks, attempts: record.attempts, k: record.subject.attempts })

function chart(records, subject) {
  const point = record => ({
    id: record.id,
    subject: record.subject.id,
    at: record.createdAt,
    commit: short(record.producer.commit),
    message: record.producer.message,
    meanReward: record.metrics.values.meanReward,
    low: record.metrics.intervals.meanReward?.[0] ?? record.metrics.values.meanReward,
    high: record.metrics.intervals.meanReward?.[1] ?? record.metrics.values.meanReward,
    passRate: record.metrics.values['passRate@1.0'],
  })
  const values = records.filter(record => !['oracle', 'nop'].includes(record.subject.id)).map(point)
  const selected = { filter: `datum.subject === '${subject}'` }
  const x = { field: 'at', type: 'temporal', title: 'UTC', scale: { type: 'utc' }, axis: { labelAngle: -30, labelOverlap: 'greedy', tickCount: 6 } }
  const tooltip = [
    { field: 'subject' }, { field: 'commit' }, { field: 'message' },
    { field: 'meanReward', format: '.3f' }, { field: 'low', format: '.3f' }, { field: 'high', format: '.3f' },
  ]
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container', height: 280, data: { values },
    layer: [
      { transform: [selected], mark: { type: 'errorband', opacity: 0.15 }, encoding: { x, y: { field: 'low', type: 'quantitative', title: 'score', scale: { domain: [0, 1] } }, y2: { field: 'high' } } },
      { mark: { type: 'line', point: true }, encoding: { x, y: { field: 'meanReward', type: 'quantitative' }, color: { field: 'subject', type: 'nominal', title: 'subject', legend: { orient: 'bottom' } }, tooltip } },
      { transform: [selected], mark: { type: 'line', strokeDash: [4, 3], point: true, color: '#1a7f37' }, encoding: { x, y: { field: 'passRate', type: 'quantitative' }, tooltip: [{ field: 'subject' }, { field: 'commit' }, { field: 'passRate', title: 'passRate@1.0', format: '.3f' }] } },
    ],
  }
  globalThis.vegaEmbed('#chart', spec, { actions: false }).then(({ view }) => {
    view.addEventListener('click', (_event, item) => {
      const same = values.filter(value => value.subject === item?.datum?.subject)
      const index = same.findIndex(value => value.id === item?.datum?.id)
      if (index > 0) void showChartPair(item?.datum?.subject, same[index - 1].id, same[index].id)
    })
  })
}

function recordsTable(records) {
  $('records').innerHTML = `<thead><tr><th>Date (UTC)</th><th>Commit</th><th>Suite</th><th class="num">Tasks × n</th><th class="num">Mean reward</th><th class="num">Pass rate @ 1.0</th><th class="num">Pass^k</th><th class="num">Cost / success</th><th class="num">Infrastructure rate</th><th></th></tr></thead><tbody>${records.map((record, index) => {
    const values = record.metrics.values
    const previous = records[index + 1]
    const compareLink = previous === undefined
      ? ''
      : `<a href="#compare" data-base="${escape(previous.id)}" data-head="${escape(record.id)}">compare</a> · ${previous.producer.snapshot === record.producer.snapshot ? '<span class="muted">Action unchanged</span>' : `<a href="changes.html?from=${encodeURIComponent(previous.id)}&to=${encodeURIComponent(record.id)}">what changed</a>`} · `
    return `<tr><td>${day(record.createdAt)}</td><td><span class="mono">${short(record.producer.commit)}</span>${record.producer.dirty ? ' <span class="muted">(dirty)</span>' : ''}<br><span class="muted commit-message" title="${escape(record.producer.message)}">${escape(record.producer.message)}</span></td><td class="mono">${short(record.suite.commit)}</td><td class="num">${fmt(values.eligibleTasks)} × ${record.subject.attempts}</td><td class="num">${fmt(values.meanReward)}${interval(record.metrics.intervals.meanReward)}</td><td class="num">${fmt(values['passRate@1.0'])}${interval(record.metrics.intervals['passRate@1.0'])}</td><td class="num">${fmt(values.passHatK)}</td><td class="num">${values.costPerSuccess === null ? '—' : `$${fmt(values.costPerSuccess, 2)}`}</td><td class="num">${fmt(values.infrastructureRate)}</td><td>${compareLink}<a href="data/records/${encodeURIComponent(record.id)}/record.json">record</a></td></tr>`
  }).join('')}</tbody>`
}

$('records').addEventListener('click', event => {
  const link = event.target.closest('[data-base]')
  if (link === null || link === undefined) return
  event.preventDefault()
  void setPair(link.dataset.base, link.dataset.head)
})

function verdictsTable(base, head) {
  $('verdicts').innerHTML = `<thead><tr><th>Metric</th><th class="num">Paired tasks</th><th class="num">Change</th><th>Verdict</th></tr></thead><tbody>${compare(attemptInput(base), attemptInput(head)).map(row => `<tr><td><code>${row.metric}</code></td><td class="num">${row.tasks}</td><td class="num">${fmt(row.delta)}${interval(row.interval)}</td><td class="${row.verdict}">${row.verdict}</td></tr>`).join('')}</tbody>`
}

function metricsTable(base, head) {
  $('metrics').innerHTML = `<thead><tr><th>Metric</th><th>Quality</th><th class="num">Base</th><th class="num">Head</th><th class="num">Change</th></tr></thead><tbody>${METRICS.map(metric => {
    const a = base.metrics.values[metric.id]
    const b = head.metrics.values[metric.id]
    const delta = a === null || b === null || a === undefined || b === undefined ? null : b - a
    return `<tr><td><code>${metric.id}</code></td><td>${metric.quality}</td><td class="num">${fmt(a)}${interval(base.metrics.intervals[metric.id])}</td><td class="num">${fmt(b)}${interval(head.metrics.intervals[metric.id])}</td><td class="num">${fmt(delta)}</td></tr>`
  }).join('')}</tbody>`
}

function tasksTable(base, head) {
  const ids = [...new Set([...base.suite.tasks, ...head.suite.tasks].map(entry => entry.id))].sort()
  const cell = (record, task) => {
    const entry = record.suite.tasks.find(candidate => candidate.id === task)
    if (entry === undefined) return '<td class="muted">not in suite</td>'
    if (!entry.applicable) return '<td class="muted">not applicable</td>'
    if (!entry.feasible) return '<td class="muted">infeasible</td>'
    return `<td>${record.attempts.filter(attempt => attempt.task === task).map(attempt => chip(attempt, diffHref({
      subject: record.subject.id,
      task,
      from: record === base ? base.id : head.id,
      fromAttempt: record === base ? attempt.attempt : 1,
      to: record === base ? head.id : head.id,
      toAttempt: record === base ? 1 : attempt.attempt,
    }))).join('')}</td>`
  }
  $('tasks').innerHTML = `<thead><tr><th>Task</th><th>Base attempts</th><th>Head attempts</th></tr></thead><tbody>${ids.map(task => `<tr><td><a href="#task" data-task="${escape(task)}">${escape(task)}</a></td>${cell(base, task)}${cell(head, task)}</tr>`).join('')}</tbody>`
  $('tasks').querySelectorAll('[data-task]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault()
    state.task = link.dataset.task
    $('task-select').value = state.task
    void showTask(state.subject, state.task, state.suite)
  }))
}

async function showChartPair(subject, baseId, headId) {
  if (typeof subject !== 'string') return
  selectionVersion += 1
  state.subject = subject
  state.base = baseId
  state.head = headId
  setParams({ subject, base: baseId, head: headId })
  $('subject').value = subject
  const records = state.index.records.filter(record => record.suite.repository === state.suite && record.subject.id === subject)
  chart(state.index.records.filter(record => record.suite.repository === state.suite).reverse(), subject)
  recordsTable(records)
  $('trend-note').textContent = `${records.length} record(s) · ${subject}`
  select('base', records.map(record => [record.id, label(record)]), baseId, value => { void setPair(value, state.head) })
  select('head', records.map(record => [record.id, label(record)]), headId, value => { void setPair(state.base, value) })
  await showCompare(baseId, headId)
}

async function showCompare(baseId, headId) {
  if (baseId === undefined || headId === undefined) return
  const version = selectionVersion
  const [base, head] = await Promise.all([loadRecord(baseId), loadRecord(headId)])
  if (version !== selectionVersion) return
  state.base = baseId
  state.head = headId
  $('base').value = baseId
  $('head').value = headId
  $('compare-note').textContent = `${short(base.producer.commit)} · ${day(base.createdAt)} → ${short(head.producer.commit)} · ${day(head.createdAt)} · ${String(pairedTaskCount(attemptInput(base), attemptInput(head)))} paired task(s)`
  setParams({ base: baseId, head: headId })
  const notes = []
  if (base.subject.id !== head.subject.id) notes.push(`The subjects differ (${base.subject.id} → ${head.subject.id}): the comparison measures the subjects, not a change to one.`)
  if (base.suite.repository !== head.suite.repository) notes.push(`The suites differ (${base.suite.repository} → ${head.suite.repository}): the tasks and suite revisions are different.`)
  if (base.suite.repository !== state.suite || head.suite.repository !== state.suite) notes.push(`The selected suite is ${state.suite}, but the comparison uses ${base.suite.repository} and ${head.suite.repository}.`)
  if (base.suite.commit !== head.suite.commit) notes.push(`The suite commits differ (${short(base.suite.commit)} → ${short(head.suite.commit)}): only the tasks both scored are paired.`)
  const judge = record => record.suite.judge === undefined ? 'none' : `${record.suite.judge.model} at ${record.suite.judge.baseUrl}`
  if (judge(base) !== judge(head)) notes.push(`The report judges differ (${judge(base)} → ${judge(head)}): scores of the reports they graded do not compare.`)
  if (base.producer.dirty || head.producer.dirty) notes.push('A record was produced from a tree with uncommitted changes.')
  $('compare-notes').innerHTML = notes.map(note => `<p class="warning">${escape(note)}</p>`).join('')
    + `<p>${base.producer.snapshot === head.producer.snapshot ? 'The Action was the same in both runs.' : `<a href="changes.html?from=${encodeURIComponent(base.id)}&to=${encodeURIComponent(head.id)}">What changed in the Action between these runs</a>`}</p>`
  verdictsTable(base, head)
  metricsTable(base, head)
  tasksTable(base, head)
  const tasks = [...new Set([...base.suite.tasks, ...head.suite.tasks].map(entry => entry.id))].sort()
  const task = tasks.includes(state.task) ? state.task : tasks[0] ?? ''
  state.task = task
  select('task-select', tasks.map(id => [id, id]), task, value => { state.task = value; void showTask(state.subject, value, state.suite) })
  await showTask(state.subject, task, state.suite)
}

async function showTask(subject, task, suite = state.suite) {
  if (subject === '' || task === '') return
  const version = ++taskVersion
  const selection = selectionVersion
  const summaries = state.index.records.filter(record => record.suite.repository === suite && record.subject.id === subject)
  const history = summaries.slice(0, TASK_HISTORY_LIMIT)
  const records = await Promise.all(history.map(record => loadRecord(record.id)))
  if (version !== taskVersion || selection !== selectionVersion) return
  state.subject = subject
  state.task = task
  setParams({ subject, task })
  $('task-note').textContent = `${subject} · ${task}${summaries.length > TASK_HISTORY_LIMIT ? ` · latest ${String(TASK_HISTORY_LIMIT)} of ${String(summaries.length)}` : ''}`
  const points = records.flatMap(record => record.attempts.filter(attempt => attempt.task === task).map(attempt => ({
    at: record.createdAt,
    commit: short(record.producer.commit),
    attempt: attempt.attempt,
    reward: attempt.outcome === 'scored' ? attempt.reward : null,
    outcome: attempt.outcome,
    agentSec: attempt.durations.agentSec ?? null,
  })))
  globalThis.vegaEmbed('#task-chart', {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container', height: 220, data: { values: points },
    mark: { type: 'point', filled: true, size: 70 },
    encoding: {
      x: { field: 'at', type: 'temporal', title: 'UTC', scale: { type: 'utc' }, axis: { labelAngle: -30, labelOverlap: 'greedy', tickCount: 6 } },
      y: { field: 'reward', type: 'quantitative', scale: { domain: [0, 1] } },
      color: { field: 'outcome', type: 'nominal', legend: { orient: 'bottom' } },
      tooltip: [{ field: 'commit' }, { field: 'attempt' }, { field: 'outcome' }, { field: 'reward' }, { field: 'agentSec', title: 'agent seconds' }],
    },
  }, { actions: false })
  $('attempts').innerHTML = `<thead><tr><th>Date (UTC)</th><th>Commit</th><th>Attempts</th><th class="num">Agent seconds</th><th class="num">Cost</th></tr></thead><tbody>${records.map((record, index) => {
    const attempts = record.attempts.filter(attempt => attempt.task === task)
    const entry = record.suite.tasks.find(candidate => candidate.id === task)
    const previous = records[index + 1]
    const status = entry === undefined ? 'not in suite' : !entry.applicable ? 'not applicable' : !entry.feasible ? 'infeasible' : ''
    const usd = attempts.reduce((sum, attempt) => sum + (attempt.usage?.usd ?? 0), 0)
    return `<tr><td>${day(record.createdAt)}</td><td class="mono">${short(record.producer.commit)}</td><td>${status === '' ? attempts.map(attempt => chip(attempt, diffHref({ subject, task, from: previous?.id ?? record.id, fromAttempt: 1, to: record.id, toAttempt: attempt.attempt }))).join('') : `<span class="muted">${status}${entry?.note ? `: ${escape(entry.note)}` : ''}</span>`}</td><td class="num">${attempts.map(attempt => fmt(attempt.durations.agentSec, 0)).join(' / ')}</td><td class="num">${usd === 0 ? '—' : `$${fmt(usd, 2)}`}</td></tr>`
  }).join('')}</tbody>`
}

function defaultPair(records) {
  return choosePair(records, state.base, state.head)
}

async function setPair(baseId, headId) {
  selectionVersion += 1
  state.base = baseId
  state.head = headId
  await showCompare(baseId, headId)
}

async function showSuite(suite) {
  selectionVersion += 1
  state.suite = suite
  const allRecords = state.index.records
  const onSuite = allRecords.filter(record => record.suite.repository === suite)
  const requested = allRecords.filter(record => record.id === state.base || record.id === state.head)
  const subjects = [...new Set(onSuite.map(record => record.subject.id))]
  const inferred = requested[0]?.subject.id
  const subject = inferred !== undefined && subjects.includes(inferred) ? inferred : subjects.includes(params.get('subject')) ? params.get('subject') : subjects.find(id => !['oracle', 'nop'].includes(id)) ?? subjects[0]
  state.subject = subject
  setParams({ suite, subject })
  select('subject', subjects.map(id => [id, id]), subject, value => { void showSubject(value) })
  const records = onSuite.filter(record => record.subject.id === subject)
  $('trend-note').textContent = `${records.length} record(s) · ${subject}`
  chart([...onSuite].reverse(), subject)
  recordsTable(records)
  const requestedBoth = requested.length === 2
  const remote = requested.find(record => record.suite.repository !== suite)
  const candidates = requestedBoth ? requested : remote === undefined ? records : allRecords.filter(record => record.suite.repository === remote.suite.repository && record.subject.id === remote.subject.id)
  const [base, head] = defaultPair(candidates)
  const options = remote === undefined ? onSuite : [...onSuite, ...candidates, ...requested]
  const uniqueOptions = [...new Map(options.map(record => [record.id, record])).values()]
  select('base', uniqueOptions.map(record => [record.id, pairLabel(record)]), base, value => { void setPair(value, state.head) })
  select('head', uniqueOptions.map(record => [record.id, pairLabel(record)]), head, value => { void setPair(state.base, value) })
  if (records.length > 0) await setPair(base, head)
}

async function showSubject(subject) {
  selectionVersion += 1
  state.subject = subject
  setParams({ subject })
  const records = state.index.records.filter(record => record.suite.repository === state.suite && record.subject.id === subject)
  const [base, head] = defaultPair(records)
  select('base', records.map(record => [record.id, label(record)]), base, value => { void setPair(value, state.head) })
  select('head', records.map(record => [record.id, label(record)]), head, value => { void setPair(state.base, value) })
  chart(state.index.records.filter(record => record.suite.repository === state.suite).reverse(), subject)
  $('trend-note').textContent = `${records.length} record(s) · ${subject}`
  recordsTable(records)
  await setPair(base, head)
}

function fieldTables(field) {
  $('field-note').textContent = `Built ${day(field.generatedAt)} UTC from ${field.consumers.length} consumer(s).`
  const pct = value => value === null ? '—' : `${fmt(value * 100, 0)}%`
  const rows = [['All consumers', field.metrics], ...field.consumers.map(consumer => [consumer.repository, consumer.metrics])]
  $('field-metrics').innerHTML = `<thead><tr><th>Consumer</th><th class="num">Proposals</th><th class="num">Merged</th><th class="num">Closed unmerged</th><th class="num">Open</th><th class="num">Merge rate</th><th class="num">Merged untouched</th><th class="num">Hours to merge (p50)</th></tr></thead><tbody>${rows.map(([name, metrics]) => metrics === undefined
    ? `<tr><td>${escape(name)}</td><td colspan="7" class="muted">unavailable</td></tr>`
    : `<tr><td>${escape(name)}</td><td class="num">${metrics.proposals}</td><td class="num">${metrics.merged}</td><td class="num">${metrics.closedUnmerged}</td><td class="num">${metrics.open}</td><td class="num">${pct(metrics.mergeRate)}</td><td class="num">${pct(metrics.mergedUntouched)}</td><td class="num">${fmt(metrics.hoursToMergeP50, 1)}</td></tr>`).join('')}</tbody>`
  const migrations = field.consumers.flatMap(consumer => consumer.error === undefined ? consumer.migrations : [])
  $('field-migrations').innerHTML = `<thead><tr><th>Consumer</th><th>Release</th><th>Started (UTC)</th><th>State</th><th>Proposal</th><th>Fate</th><th class="num">Maintainer commits</th></tr></thead><tbody>${migrations.map(migration => `<tr><td>${escape(migration.consumer)}</td><td class="mono">${escape(migration.release)}</td><td>${day(migration.startedAt)}</td><td>${escape(migration.state)}</td><td>${migration.proposal === undefined ? '—' : `<a href="${escape(migration.proposal.url)}">${escape(migration.proposal.url.split('/').pop())}</a>`}</td><td>${migration.proposal?.closed === undefined ? (migration.proposal === undefined ? '—' : 'open') : migration.proposal.closed.merged ? `merged ${day(migration.proposal.closed.at)}` : `closed ${day(migration.proposal.closed.at)}`}</td><td class="num">${fmt(migration.proposal?.maintainerCommits)}</td></tr>`).join('')}${field.consumers.filter(consumer => consumer.error !== undefined).map(consumer => `<tr><td>${escape(consumer.repository)}</td><td colspan="6" class="muted">${escape(consumer.error)}</td></tr>`).join('')}</tbody>`
}

void loadField().then(fieldTables).catch(() => { $('field-note').textContent = 'Field data is absent; build the site with --field.' })

try {
  state.index = await loadIndex()
  if (state.index.records.length === 0) throw new Error('No record has been published yet.')
  const suites = [...new Set(state.index.records.map(record => record.suite.repository))]
  const requested = state.index.records.filter(record => record.id === state.base || record.id === state.head)
  const suite = suites.includes(params.get('suite')) ? params.get('suite') : requested[0]?.suite.repository ?? suites[0]
  select('suite', suites.map(id => [id, id]), suite, value => {
    state.base = ''
    state.head = ''
    void showSuite(value)
  })
  await showSuite(suite)
} catch (error) {
  fail(error)
}
