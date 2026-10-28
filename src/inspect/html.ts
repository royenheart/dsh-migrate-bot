import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InspectData } from '../observability/evidence.ts'

/**
 * A page over the live-run evidence on the state branch:
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net; img-src data:; font-src data:">
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
  #full { border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: 70vh; }
  #full table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  #full th { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); padding: 6px; text-align: left; font-size: 12px; }
  #full td { vertical-align: top; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; padding: 1px 6px; }
  #full td.n { width: 3.5em; text-align: right; color: var(--muted); user-select: none; }
  #full td.add { background: var(--add); } #full td.del { background: var(--del); }
  #full td.blank { background: transparent; }
  #full td.sep { width: 1px; padding: 0; background: var(--line); }
  #graph, #graphdiff > div { border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; }
  #graphdiff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 900px) { #graphdiff { grid-template-columns: 1fr; } }
  .state { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #fff8c5; color: #6b4e00; font-weight: 600; }
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
    <label>View <select id="view"><option value="full">prompt side-by-side (full)</option><option value="diff">prompt diff</option><option value="graph">statechart</option><option value="graph-diff">statechart diff</option></select></label>
  </div>
  <div id="summary"></div>
  <div id="cards" class="cards"></div>
  <h2 id="title">Prompt diff</h2>
  <div id="diff"></div>
  <div id="full"></div>
  <div id="graph" hidden></div>
  <div id="graphdiff" hidden></div>
</main>
<script src="https://cdn.jsdelivr.net/npm/diff@7.0.0/dist/diff.min.js"></script>
<script type="module">
const data = ${payload}
const runs = data.runs
const $ = id => document.getElementById(id)
const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
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
function statesOf(graph) {
  return new Set((graph ?? '').split('\\n').flatMap(line => {
    const match = /^\s*([A-Za-z_][\w.-]*)\s*-->\s*([A-Za-z_][\w.-]*)/.exec(line)
    return match === null ? [] : [match[1], match[2]]
  }).filter(state => state !== '[*]'))
}
function mark(graph, only, cls, fill) {
  if (only.length === 0) return graph
  return graph + '\\n  classDef ' + cls + ' fill:' + fill + ',stroke:#57606a\\n' + only.map(state => '  class ' + state + ' ' + cls).join('\\n')
}
function safeGraph(graph) {
  return graph === undefined || graph.trim() === '' || /%%\{|<script|javascript:/i.test(graph) ? undefined : graph
}
function markCurrent(graph, state) {
  if (graph === undefined || state === undefined) return graph
  return graph + '\\n  classDef current fill:#fff8c5,stroke:#9a6700,stroke-width:2px\\n  class ' + state + ' current'
}
function edgesOf(graph) {
  return new Set((graph ?? '').split('\\n').map(line => line.trim()).filter(line => line.includes('-->')))
}
const mermaidPromise = import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
  return mermaid
})
let renderSeq = 0
function renderGraph(box, graph, state) {
  const safe = safeGraph(graph)
  if (safe === undefined) { box.textContent = 'No safe generated statechart in this run.'; return }
  const marked = markCurrent(safe, state)
  const key = String(renderSeq++)
  box.dataset.token = key
  mermaidPromise.then(mermaid => mermaid.render('graph-' + key, marked)).then(({ svg }) => {
    if (box.dataset.token === key) box.innerHTML = svg
  }).catch(error => { if (box.dataset.token === key) box.textContent = String(error) })
}
function renderGraphDiff(from, to) {
  const before = safeGraph(from.manifest.workflow.graph)
  const after = safeGraph(to.manifest.workflow.graph)
  if (before === undefined || after === undefined) { $('graphdiff').textContent = 'One of these runs has no recorded statechart, so there is nothing to compare.'; return }
  const fromStates = statesOf(before), toStates = statesOf(after)
  const fromEdges = edgesOf(before), toEdges = edgesOf(after)
  const onlyFrom = [...fromEdges].filter(edge => !toEdges.has(edge))
  const onlyTo = [...toEdges].filter(edge => !fromEdges.has(edge))
  const beforeMarked = mark(before, [...fromStates].filter(state => !toStates.has(state)), 'removed', '#ffebe9')
  const afterMarked = mark(after, [...toStates].filter(state => !fromStates.has(state)), 'added', '#dafbe1')
  const box = $('graphdiff')
  const key = (from.runId + '-' + to.runId).replace(/[^A-Za-z0-9_-]/g, '_')
  if (box.dataset.key !== key) {
    box.dataset.key = key
    box.dataset.token = key
    box.innerHTML = '<div><h3>From ' + esc(from.runId) + '</h3><p class="muted">' + String(fromEdges.size) + ' edge(s)' + (onlyFrom.length === 0 ? '' : '; only here: ' + esc(onlyFrom.join(', '))) + '</p><div id="from-graph"></div></div><div><h3>To ' + esc(to.runId) + '</h3><p class="muted">' + String(toEdges.size) + ' edge(s)' + (onlyTo.length === 0 ? '' : '; only here: ' + esc(onlyTo.join(', '))) + '</p><div id="to-graph"></div></div>'
  }
  mermaidPromise.then(mermaid => Promise.all([
    mermaid.render('from-graph-' + key, beforeMarked),
    mermaid.render('to-graph-' + key, afterMarked),
  ])).then(([left, right]) => {
    if (box.dataset.token !== key) return
    $('from-graph').innerHTML = left.svg; $('to-graph').innerHTML = right.svg
  }).catch(error => { box.dataset.key = ''; if (box.dataset.token === key) box.textContent = String(error) })
}

const NL = String.fromCharCode(10)
function splitLines(value) {
  if (value === '') return ['']
  const lines = value.split(NL)
  if (value.endsWith(NL)) lines.pop()
  return lines
}
function cell(className, text) {
  const td = document.createElement('td')
  if (className !== '') td.className = className
  td.textContent = text
  return td
}
function fullRows(before, after) {
  if (globalThis.Diff === undefined) {
    const left = splitLines(before), right = splitLines(after)
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => ({
      left: left[index] ?? null,
      right: right[index] ?? null,
      leftClass: '',
      rightClass: '',
    }))
  }
  const rows = []
  let removed = []
  let added = []
  const flush = () => {
    const count = Math.max(removed.length, added.length)
    for (let index = 0; index < count; index += 1) {
      rows.push({
        left: removed[index] ?? null,
        right: added[index] ?? null,
        leftClass: removed[index] === undefined ? 'blank' : 'del',
        rightClass: added[index] === undefined ? 'blank' : 'add',
      })
    }
    removed = []
    added = []
  }
  for (const part of globalThis.Diff.diffLines(before, after)) {
    const lines = splitLines(part.value)
    if (part.removed) {
      removed.push(...lines)
      continue
    }
    if (part.added) {
      added.push(...lines)
      continue
    }
    flush()
    for (const line of lines) rows.push({ left: line, right: line, leftClass: '', rightClass: '' })
  }
  flush()
  return rows
}
function renderFull(from, to, name, before, after, beforeStored, afterStored) {
  const box = $('full')
  box.replaceChildren()
  if (!beforeStored || !afterStored) {
    const missing = [!beforeStored ? 'from' : '', !afterStored ? 'to' : ''].filter(Boolean).join(' and ')
    box.textContent = 'No prompt stored in the ' + missing + ' run.' + NL + NL
      + (beforeStored ? 'From:' + NL + before : '') + (beforeStored && afterStored ? NL + NL : '')
      + (afterStored ? 'To:' + NL + after : '')
    return
  }
  const table = document.createElement('table')
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const [text, span] of [['From ' + from.runId, 2], ['', 1], ['To ' + to.runId, 2]]) {
    const th = document.createElement('th')
    th.textContent = text
    th.colSpan = span
    headRow.append(th)
  }
  head.append(headRow)
  table.append(head)
  const body = document.createElement('tbody')
  let leftLine = 0
  let rightLine = 0
  for (const row of fullRows(before, after)) {
    const tr = document.createElement('tr')
    tr.append(cell('n', row.left === null ? '' : String(++leftLine)))
    tr.append(cell(row.leftClass, row.left ?? ''))
    tr.append(cell('sep', ''))
    tr.append(cell('n', row.right === null ? '' : String(++rightLine)))
    tr.append(cell(row.rightClass, row.right ?? ''))
    body.append(tr)
  }
  table.append(body)
  box.append(table)
}

function render() {
  const from = runOf($('from').value), to = runOf($('to').value), name = $('session').value
  const beforeStored = Object.prototype.hasOwnProperty.call(from.prompts, name)
  const afterStored = Object.prototype.hasOwnProperty.call(to.prompts, name)
  const before = beforeStored ? from.prompts[name] : '(no prompt stored)'
  const after = afterStored ? to.prompts[name] : '(no prompt stored)'
  const evaluation = to.manifest.evaluation
  const evaluationParts = evaluation === undefined ? [] : [
    evaluation.harborJob === undefined ? '' : 'Harbor job <span class="mono">' + esc(evaluation.harborJob) + '</span>',
    evaluation.trialId === undefined ? '' : 'trial <span class="mono">' + esc(evaluation.trialId) + '</span>',
    evaluation.record === undefined ? '' : /^https?:\/\//.test(evaluation.record) ? '<a href="' + esc(evaluation.record) + '">record</a>' : 'record <span class="mono">' + esc(evaluation.record) + '</span>',
  ].filter(Boolean)
  const evalLinks = evaluationParts.length === 0 ? '' : '<p>Evaluation: ' + evaluationParts.join(' · ') + '</p>'
  const warningText = data.warnings.length === 0 ? '' : '<p class="muted">Evidence warnings: ' + data.warnings.map(esc).join('; ') + '</p>'
  $('summary').innerHTML = warningText + '<p><span class="mono">' + esc(from.runId) + '</span> → <span class="mono">' + esc(to.runId) + '</span> · run state <span class="state">' + esc(to.manifest.workflow.state ?? to.manifest.outcome) + '</span></p>' + evalLinks
  $('cards').innerHTML = metrics(to).map(([label, value]) => '<div class="card"><b>' + value + '</b><span>' + label + '</span></div>').join('')
  const box = $('diff'); box.replaceChildren()
  if (!beforeStored || !afterStored) {
    const missing = [!beforeStored ? 'from' : '', !afterStored ? 'to' : ''].filter(Boolean).join(' and ')
    box.textContent = 'No prompt stored in the ' + missing + ' run.\\n\\n' + (beforeStored ? 'From:\\n' + before + '\\n\\n' : '') + (afterStored ? 'To:\\n' + after : '')
  } else {
    const patch = globalThis.Diff === undefined
      ? 'diff unavailable; showing both prompts\\n--- ' + from.runId + '\\n' + before + '\\n+++ ' + to.runId + '\\n' + after
      : globalThis.Diff.createTwoFilesPatch(from.runId, to.runId, before, after, '', '', { context: 3 })
    for (const line of patch.split('\\n')) {
      const span = document.createElement('span')
      span.className = line.startsWith('+') && !line.startsWith('+++ ') ? 'add' : line.startsWith('-') && !line.startsWith('--- ') ? 'del' : ''
      span.textContent = line + '\\n'
      box.append(span)
    }
  }
  $('diff').hidden = $('view').value !== 'diff'
  $('full').hidden = $('view').value !== 'full'
  if ($('view').value === 'full') renderFull(from, to, name, before, after, beforeStored, afterStored)
  $('title').textContent = $('view').value === 'full' ? 'Full prompt: ' + name
    : $('view').value === 'diff' ? 'Prompt diff: ' + name
      : $('view').value === 'graph' ? 'Statechart' : 'Statechart diff (from → to)'
  $('graph').hidden = $('view').value !== 'graph'
  $('graphdiff').hidden = $('view').value !== 'graph-diff'
  if ($('view').value === 'graph') renderGraph($('graph'), to.manifest.workflow.graph, to.manifest.workflow.state)
  if ($('view').value === 'graph-diff') renderGraphDiff(from, to)
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
