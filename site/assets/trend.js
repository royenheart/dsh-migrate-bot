import { day, escape, fail, fmt, interval, loadIndex, nav, params, select, setParams, short } from './common.js'

nav('Trend')

/**
 * `meanReward` of every subject on one suite over time, so subjects can be
 * compared at each commit; the selected subject also gets its interval band and
 * `passRate@1.0`. The keyless subjects only say which tasks are feasible.
 */
function chart(all, subject) {
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
  const values = all.filter(record => !['oracle', 'nop'].includes(record.subject.id)).map(point)
  const x = { field: 'at', type: 'temporal', title: 'UTC', scale: { type: 'utc' } }
  const selected = { filter: `datum.subject === '${subject}'` }
  const tooltip = [{ field: 'subject' }, { field: 'commit' }, { field: 'message' }, { field: 'meanReward', format: '.3f' }, { field: 'low', format: '.3f' }, { field: 'high', format: '.3f' }]
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 'container',
    height: 300,
    data: { values },
    layer: [
      { transform: [selected], mark: { type: 'errorband', opacity: 0.15 }, encoding: { x, y: { field: 'low', type: 'quantitative', title: 'score', scale: { domain: [0, 1] } }, y2: { field: 'high' } } },
      { mark: { type: 'line', point: true }, encoding: { x, y: { field: 'meanReward', type: 'quantitative' }, color: { field: 'subject', type: 'nominal', title: 'meanReward of' }, tooltip } },
      { transform: [selected], mark: { type: 'line', strokeDash: [4, 3], point: true, color: '#1a7f37' }, encoding: { x, y: { field: 'passRate', type: 'quantitative' }, tooltip: [{ field: 'subject' }, { field: 'commit' }, { field: 'passRate', title: 'passRate@1.0', format: '.3f' }] } },
    ],
  }
  globalThis.vegaEmbed('#chart', spec, { actions: false }).then(({ view }) => {
    view.addEventListener('click', (_event, item) => {
      const same = values.filter(value => value.subject === item?.datum?.subject)
      const index = same.findIndex(value => value.id === item?.datum?.id)
      if (index > 0) location.href = `compare.html?base=${encodeURIComponent(same[index - 1].id)}&head=${encodeURIComponent(same[index].id)}`
    })
  })
}

function table(records) {
  const rows = records.map((record, index) => {
    const values = record.metrics.values
    const previous = records[index + 1]
    return `<tr>
      <td>${day(record.createdAt)}</td>
      <td><span class="mono">${short(record.producer.commit)}</span>${record.producer.dirty ? ' <span class="muted">(dirty)</span>' : ''}<br><span class="muted">${escape(record.producer.message)}</span></td>
      <td class="mono">${short(record.suite.commit)}</td>
      <td class="num">${fmt(values.eligibleTasks)} × ${record.subject.attempts}</td>
      <td class="num">${fmt(values.meanReward)}${interval(record.metrics.intervals.meanReward)}</td>
      <td class="num">${fmt(values['passRate@1.0'])}${interval(record.metrics.intervals['passRate@1.0'])}</td>
      <td class="num">${fmt(values.passHatK)}</td>
      <td class="num">${values.costPerSuccess === null ? '—' : `$${fmt(values.costPerSuccess, 2)}`}</td>
      <td class="num">${fmt(values.infrastructureRate)}</td>
      <td>${previous === undefined ? '' : `<a href="compare.html?base=${encodeURIComponent(previous.id)}&head=${encodeURIComponent(record.id)}">compare with previous</a> · ${previous.producer.snapshot === record.producer.snapshot ? '<span class="muted">Action unchanged</span>' : `<a href="changes.html?from=${encodeURIComponent(previous.id)}&to=${encodeURIComponent(record.id)}">what changed</a>`} · `}<a href="data/records/${encodeURIComponent(record.id)}/record.json">record</a></td>
    </tr>`
  })
  document.getElementById('records').innerHTML = `<tr><th>Date (UTC)</th><th>Commit</th><th>Suite</th><th class="num">Tasks × attempts</th><th class="num">meanReward</th><th class="num">passRate@1.0</th><th class="num">passHatK</th><th class="num">costPerSuccess</th><th class="num">infrastructureRate</th><th></th></tr>${rows.join('')}`
}

try {
  const index = await loadIndex()
  const suites = [...new Set(index.records.map(record => record.suite.repository))]
  if (suites.length === 0) throw new Error('No record has been published yet.')
  const show = (suite, subject) => {
    setParams({ suite, subject })
    const onSuite = index.records.filter(record => record.suite.repository === suite)
    const records = onSuite.filter(record => record.subject.id === subject)
    document.getElementById('summary').textContent = `${records.length} record(s)`
    chart([...onSuite].reverse(), subject)
    table(records)
  }
  const showSuite = (suite) => {
    const subjects = [...new Set(index.records.filter(record => record.suite.repository === suite).map(record => record.subject.id))]
    const subject = subjects.includes(params.get('subject')) ? params.get('subject') : subjects[0]
    select('subject', subjects.map(id => [id, id]), subject, id => show(suite, id))
    show(suite, subject)
  }
  const suite = suites.includes(params.get('suite')) ? params.get('suite') : suites[0]
  select('suite', suites.map(id => [id, id]), suite, showSuite)
  showSuite(suite)
} catch (error) {
  fail(error)
}
