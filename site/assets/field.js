import { day, escape, fail, fmt, loadField, nav } from './common.js'

nav('Field')

const pct = value => value === null ? '—' : `${fmt(value * 100, 0)}%`

try {
  const field = await loadField()
  document.getElementById('generated').textContent = `Built ${day(field.generatedAt)} UTC from ${field.consumers.length} consumer(s).`
  const rows = [['All consumers', field.metrics], ...field.consumers.map(consumer => [consumer.repository, consumer.metrics])]
  document.getElementById('metrics').innerHTML = `<tr><th>Consumer</th><th class="num">Proposals</th><th class="num">Merged</th><th class="num">Closed unmerged</th><th class="num">Open</th><th class="num">Merge rate</th><th class="num">Merged untouched</th><th class="num">Hours to merge (p50)</th></tr>${rows.map(([name, metrics]) => metrics === undefined
    ? `<tr><td>${escape(name)}</td><td colspan="7" class="muted">unavailable</td></tr>`
    : `<tr><td>${escape(name)}</td><td class="num">${metrics.proposals}</td><td class="num">${metrics.merged}</td><td class="num">${metrics.closedUnmerged}</td><td class="num">${metrics.open}</td><td class="num">${pct(metrics.mergeRate)}</td><td class="num">${pct(metrics.mergedUntouched)}</td><td class="num">${fmt(metrics.hoursToMergeP50, 1)}</td></tr>`).join('')}`
  const migrations = field.consumers.flatMap(consumer => consumer.error === undefined ? consumer.migrations : [])
  document.getElementById('migrations').innerHTML = `<tr><th>Consumer</th><th>Release</th><th>Started (UTC)</th><th>State</th><th>Proposal</th><th>Fate</th><th class="num">Maintainer commits</th></tr>${migrations.map(migration => `<tr>
    <td>${escape(migration.consumer)}</td><td class="mono">${escape(migration.release)}</td><td>${day(migration.startedAt)}</td><td>${escape(migration.state)}</td>
    <td>${migration.proposal === undefined ? '—' : `<a href="${escape(migration.proposal.url)}">${escape(migration.proposal.url.split('/').pop())}</a>`}</td>
    <td>${migration.proposal?.closed === undefined ? (migration.proposal === undefined ? '—' : 'open') : migration.proposal.closed.merged ? `merged ${day(migration.proposal.closed.at)}` : `closed ${day(migration.proposal.closed.at)}`}</td>
    <td class="num">${fmt(migration.proposal?.maintainerCommits)}</td></tr>`).join('')}${field.consumers.filter(consumer => consumer.error !== undefined).map(consumer => `<tr><td>${escape(consumer.repository)}</td><td colspan="6" class="muted">${escape(consumer.error)}</td></tr>`).join('')}`
} catch (error) {
  fail(error)
}
