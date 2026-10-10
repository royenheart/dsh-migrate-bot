import { chip, day, diffHref, escape, fail, fmt, interval, loadIndex, loadRecord, nav, params, select, setParams, short } from './common.js'
import { compare, METRICS } from './metrics.js'

nav('Compare')

const input = record => ({ tasks: record.suite.tasks, attempts: record.attempts, k: record.subject.attempts })
const label = record => `${record.subject.id} · ${short(record.producer.commit)} · ${day(record.createdAt)}`

async function show(baseId, headId) {
  setParams({ base: baseId, head: headId })
  const [base, head] = await Promise.all([loadRecord(baseId), loadRecord(headId)])
  const notes = []
  if (base.subject.id !== head.subject.id) notes.push(`The subjects differ (${base.subject.id} → ${head.subject.id}): the comparison measures the subjects, not a change to one.`)
  if (base.suite.commit !== head.suite.commit) notes.push(`The suite commits differ (${short(base.suite.commit)} → ${short(head.suite.commit)}): only the tasks both scored are paired.`)
  if (base.producer.dirty || head.producer.dirty) notes.push('A record was produced from a tree with uncommitted changes.')
  document.getElementById('notes').innerHTML = notes.map(note => `<p class="warning">${escape(note)}</p>`).join('')
    + `<p>${base.producer.snapshot === head.producer.snapshot ? 'The Action was the same in both runs.' : `<a href="changes.html?from=${encodeURIComponent(base.id)}&to=${encodeURIComponent(head.id)}">What changed in the Action between these runs</a>`}</p>`

  document.getElementById('verdicts').innerHTML = `<tr><th>Metric</th><th class="num">Paired tasks</th><th class="num">Change</th><th>Verdict</th></tr>${compare(input(base), input(head)).map(row => `<tr><td><code>${row.metric}</code></td><td class="num">${row.tasks}</td><td class="num">${fmt(row.delta)}${interval(row.interval)}</td><td class="${row.verdict}">${row.verdict}</td></tr>`).join('')}`

  document.getElementById('metrics').innerHTML = `<tr><th>Metric</th><th>Quality</th><th class="num">Base</th><th class="num">Head</th><th class="num">Change</th></tr>${METRICS.map((metric) => {
    const [a, b] = [base.metrics.values[metric.id], head.metrics.values[metric.id]]
    const delta = a === null || b === null || a === undefined || b === undefined ? null : b - a
    return `<tr><td><code>${metric.id}</code></td><td>${metric.quality}</td><td class="num">${fmt(a)}${interval(base.metrics.intervals[metric.id])}</td><td class="num">${fmt(b)}${interval(head.metrics.intervals[metric.id])}</td><td class="num">${fmt(delta)}</td></tr>`
  }).join('')}`

  const ids = [...new Set([...base.suite.tasks, ...head.suite.tasks].map(task => task.id))].sort()
  const cell = (record, task) => {
    const entry = record.suite.tasks.find(candidate => candidate.id === task)
    if (entry === undefined) return '<td class="muted">not in suite</td>'
    if (!entry.applicable) return '<td class="muted">not applicable</td>'
    if (!entry.feasible) return '<td class="muted">infeasible</td>'
    const other = record === base ? head : base
    return `<td>${record.attempts.filter(attempt => attempt.task === task).map(attempt => chip(attempt, diffHref({
      subject: record.subject.id,
      task,
      from: record === base ? base.id : other.id,
      fromAttempt: record === base ? attempt.attempt : 1,
      to: record === base ? other.id : head.id,
      toAttempt: record === base ? 1 : attempt.attempt,
    }))).join('')}</td>`
  }
  document.getElementById('tasks').innerHTML = `<tr><th>Task</th><th>Base attempts</th><th>Head attempts</th></tr>${ids.map(task => `<tr><td><a href="task.html?subject=${encodeURIComponent(head.subject.id)}&task=${encodeURIComponent(task)}">${escape(task)}</a></td>${cell(base, task)}${cell(head, task)}</tr>`).join('')}`
}

try {
  const index = await loadIndex()
  if (index.records.length === 0) throw new Error('No record has been published yet.')
  const options = index.records.map(record => [record.id, label(record)])
  let baseId = params.get('base') ?? index.records[1]?.id ?? index.records[0].id
  let headId = params.get('head') ?? index.records[0].id
  select('base', options, baseId, (value) => { baseId = value; show(baseId, headId).catch(fail) })
  select('head', options, headId, (value) => { headId = value; show(baseId, headId).catch(fail) })
  await show(baseId, headId)
} catch (error) {
  fail(error)
}
