import { chip, day, diffHref, escape, fail, fmt, loadIndex, loadRecord, nav, params, select, setParams, short } from './common.js'

nav('Task')

async function show(subject, task, summaries) {
  setParams({ subject, task })
  const records = await Promise.all(summaries.filter(record => record.subject.id === subject).map(record => loadRecord(record.id)))
  const points = records.flatMap(record => record.attempts.filter(attempt => attempt.task === task).map(attempt => ({
    at: record.createdAt,
    commit: short(record.producer.commit),
    attempt: attempt.attempt,
    reward: attempt.outcome === 'scored' ? attempt.reward : null,
    outcome: attempt.outcome,
    agentSec: attempt.durations.agentSec ?? null,
  })))
  globalThis.vegaEmbed('#chart', {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container',
    height: 220,
    data: { values: points },
    mark: { type: 'point', filled: true, size: 70 },
    encoding: {
      x: { field: 'at', type: 'temporal', title: 'UTC', scale: { type: 'utc' } },
      y: { field: 'reward', type: 'quantitative', scale: { domain: [0, 1] } },
      color: { field: 'outcome', type: 'nominal' },
      tooltip: [{ field: 'commit' }, { field: 'attempt' }, { field: 'outcome' }, { field: 'reward' }, { field: 'agentSec', title: 'agent seconds' }],
    },
  }, { actions: false })
  const rows = records.map((record, index) => {
    const attempts = record.attempts.filter(attempt => attempt.task === task)
    const entry = record.suite.tasks.find(candidate => candidate.id === task)
    const previous = records[index + 1]
    const status = entry === undefined ? 'not in suite' : !entry.applicable ? 'not applicable' : !entry.feasible ? 'infeasible' : ''
    const usd = attempts.reduce((sum, attempt) => sum + (attempt.usage?.usd ?? 0), 0)
    return `<tr><td>${day(record.createdAt)}</td><td class="mono">${short(record.producer.commit)}</td>
      <td>${status === '' ? attempts.map(attempt => chip(attempt, diffHref({ subject, task, from: previous?.id ?? record.id, fromAttempt: 1, to: record.id, toAttempt: attempt.attempt }))).join('') : `<span class="muted">${status}${entry?.note ? `: ${escape(entry.note)}` : ''}</span>`}</td>
      <td class="num">${attempts.map(attempt => fmt(attempt.durations.agentSec, 0)).join(' / ')}</td>
      <td class="num">${usd === 0 ? '—' : `$${fmt(usd, 2)}`}</td></tr>`
  })
  document.getElementById('attempts').innerHTML = `<tr><th>Date (UTC)</th><th>Commit</th><th>Attempts (click for the diff against the previous record)</th><th class="num">Agent seconds</th><th class="num">Cost</th></tr>${rows.join('')}`
}

try {
  const index = await loadIndex()
  if (index.records.length === 0) throw new Error('No record has been published yet.')
  const subjects = [...new Set(index.records.map(record => record.subject.id))]
  let subject = subjects.includes(params.get('subject')) ? params.get('subject') : subjects[0]
  const tasks = [...new Set(index.records.flatMap(record => record.suite.tasks.map(task => task.id)))].sort()
  let task = tasks.includes(params.get('task')) ? params.get('task') : tasks[0]
  select('subject', subjects.map(id => [id, id]), subject, (value) => { subject = value; show(subject, task, index.records).catch(fail) })
  select('task', tasks.map(id => [id, id]), task, (value) => { task = value; show(subject, task, index.records).catch(fail) })
  await show(subject, task, index.records)
} catch (error) {
  fail(error)
}
