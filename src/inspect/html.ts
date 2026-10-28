import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InspectData } from '../observability/evidence.ts'

/**
 * A self-contained page over the live-run evidence on the state branch:
 * choose two runs and a session, read the prompt diff, and see the run totals
 * and the statechart. It deliberately reads only the data it is given, so a
 * future framework can feed the same page from its own run store.
 */
export function renderInspectHtml(data: InspectData): string {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inspect · ${escapeHtml(data.migrationId)}</title>
<style>
  :root { color-scheme: light dark; --line: #d0d7de; --muted: #57606a; --bg: #ffffff; --fg: #1f2328; --add: #dafbe1; --del: #ffebe9; }
  @media (prefers-color-scheme: dark) { :root { --line: #30363d; --muted: #8b949e; --bg: #0d1117; --fg: #e6edf3; --add: #12261e; --del: #3c1618; } }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 8px; }
  .muted { color: var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin: 12px 0; }
  label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
  select { min-width: 220px; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .card b { display: block; font-size: 18px; } .card span { color: var(--muted); font-size: 12px; }
  #diff { border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: 60vh; padding: 8px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
  #diff .add { background: var(--add); } #diff .del { background: var(--del); }
  #graph { border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; }
  .toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
</style>
</head>
<body>
<main>
  <h1>Migration <span class="mono">${escapeHtml(data.migrationId)}</span></h1>
  <p class="muted">Live run evidence from the state branch. Prompt text is stored by hash; the manifest is the index.</p>
  <div class="controls">
    <label>From run <select id="from"></select></label>
    <label>To run <select id="to"></select></label>
    <label>Session <select id="session"></select></label>
    <label>View <select id="view"><option value="diff">prompt diff</option><option value="graph">statechart</option></select></label>
  </div>
  <div id="summary"></div>
  <div id="cards" class="cards"></div>
  <h2 id="title">Prompt diff</h2>
  <div id="diff"></div>
  <div id="graph" hidden></div>
</main>
<script src="https://cdn.jsdelivr.net/npm/diff@7.0.0/dist/diff.min.js"></script>
<script type="module">
const data = ${payload}
const runs = data.runs
const $ = id => document.getElementById(id)
const short = run => run.runId + ' · ' + run.manifest.startedAt
const option = (select, value, text) => { const el = document.createElement('option'); el.value = value; el.textContent = text; select.append(el) }
for (const run of runs) { option($('from'), run.runId, short(run)); option($('to'), run.runId, short(run)) }
$('from').value = runs.length > 1 ? runs[runs.length - 2].runId : runs[0].runId
$('to').value = runs[runs.length - 1].runId
const runOf = id => runs.find(run => run.runId === id)
const sessionsOf = pair => [...new Set(pair.flatMap(run => run.manifest.sessions.map(session => session.name)))]
function refreshSessions() {
  const from = runOf($('from').value), to = runOf($('to').value)
  const names = sessionsOf([from, to])
  $('session').replaceChildren()
  for (const name of names) option($('session'), name, name)
}
function metrics(run) {
  const totals = run.manifest.totals
  const cost = totals.usd === undefined ? '—' : '$' + totals.usd.toFixed(6)
  return [['sessions', totals.sessions], ['turns', totals.turns], ['steps', totals.steps], ['tool calls', totals.toolCalls], ['elapsed', totals.elapsedSeconds + 's'], ['cost', cost], ['input tokens', totals.inputTokens], ['output tokens', totals.outputTokens]]
}
function render() {
  const from = runOf($('from').value), to = runOf($('to').value), name = $('session').value
  const before = from.prompts[name] ?? '(no prompt stored)'
  const after = to.prompts[name] ?? '(no prompt stored)'
  $('summary').innerHTML = '<p><span class="mono">' + from.runId + '</span> → <span class="mono">' + to.runId + '</span></p>'
  $('cards').innerHTML = metrics(to).map(([label, value]) => '<div class="card"><b>' + value + '</b><span>' + label + '</span></div>').join('')
  const patch = globalThis.Diff === undefined
    ? '--- ' + from.runId + '\\n+++ ' + to.runId + '\\n' + after
    : globalThis.Diff.createTwoFilesPatch(from.runId, to.runId, before, after, '', '', { context: 3 })
  const box = $('diff'); box.replaceChildren()
  for (const line of patch.split('\\n')) {
    const span = document.createElement('span')
    span.className = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : ''
    span.textContent = line + '\\n'
    box.append(span)
  }
  $('diff').hidden = $('view').value !== 'diff'
  $('title').textContent = $('view').value === 'diff' ? 'Prompt diff: ' + name : 'Statechart'
  $('graph').hidden = $('view').value !== 'graph'
  if ($('view').value === 'graph' && !$('graph').dataset.done) {
    $('graph').dataset.done = '1'
    const graph = to.manifest.workflow.graph ?? data.graph
    if (graph === undefined) $('graph').textContent = 'No generated statechart in this checkout.'
    else import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
      return mermaid.render('migration-graph', graph)
    }).then(({ svg }) => { $('graph').innerHTML = svg }).catch(error => { $('graph').textContent = String(error) })
  }
}
for (const id of ['from', 'to']) $(id).addEventListener('change', () => { refreshSessions(); render() })
$('session').addEventListener('change', render)
$('view').addEventListener('change', render)
refreshSessions()
render()
</script>
</body>
</html>
`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

export function writeInspectHtml(data: InspectData, outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, 'index.html')
  writeFileSync(path, renderInspectHtml(data))
  return path
}
