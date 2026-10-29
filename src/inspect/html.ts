import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InspectData } from '../observability/evidence.ts'

/**
 * A page over the live-run evidence on the state branch:
 * choose two runs and a session, read full prompts side by side, select a workflow node or edge, and see the run totals
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
  #full { border: 1px solid var(--line); border-radius: 8px; overflow: auto; max-height: 70vh; }
  #full table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  #full th { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); padding: 6px; text-align: left; font-size: 12px; }
  #full td { vertical-align: top; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; padding: 1px 6px; }
  #full td.n { width: 3.5em; text-align: right; color: var(--muted); user-select: none; }
  #full td.add { background: var(--add); } #full td.del { background: var(--del); }
  #full td.blank { background: transparent; }
  #full th.left, #full td.left { border-right: 1px solid var(--line); }
  #graph { display: grid; gap: 12px; }
  #graph.two { grid-template-columns: 1fr 1fr; }
  #graph .graph-panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; max-height: 30vh; }
  #graph .node.active rect, #graph .node.active polygon { stroke: #0969da; stroke-width: 3px; }
  #full { margin-top: 16px; }
  #graph .graph-panel h3 { margin: 0 0 6px; font-size: 13px; }
  #graphdiff > div { border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; }
  #evidence { display: block; }
  @media (max-width: 900px) { #graph.two { grid-template-columns: 1fr; } }
  #graphdiff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 900px) { #graphdiff { grid-template-columns: 1fr; } }
  #workflow-note { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
  .selection { margin: 8px 0; padding: 8px 10px; border-left: 3px solid #0969da; background: color-mix(in srgb, #0969da 7%, transparent); font-size: 13px; }
  #jump-prompt { border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); padding: 2px 8px; cursor: pointer; font: inherit; }
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
    <label>View <select id="view"><option value="workflow">workflow + prompt</option><option value="full">prompt side-by-side (full)</option><option value="graph">statechart</option><option value="graph-diff">statechart diff</option></select></label>
  </div>
  <div id="summary"></div>
  <div id="selection"></div>
  <button id="jump-prompt" type="button">↓ prompt</button>
  <div id="cards" class="cards"></div>
  <h2 id="title">Full prompt</h2>
  <div id="evidence">
    <div id="workflow-pane" hidden>
      <div id="graph" hidden></div>
      <p id="workflow-note" hidden>Click a state or a transition. A transition shows the target state's prompt, then the source state's prompt.</p>
    </div>
    <div id="full" hidden></div>
  </div>
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
function stageOf(name) {
  if (name === 'overlap') return 'review · overlap'
  if (name === 'extension-points') return 'review · extension points'
  const repair = /^repair-(\\d+)$/.exec(name)
  if (repair !== null) return 'repair · attempt ' + repair[1]
  if (name === 'e2e-characterize') return 'end-to-end · characterize'
  if (name === 'e2e-publish') return 'end-to-end · publish'
  if (name.startsWith('report-')) return 'merge report · ' + name.slice('report-'.length)
  return name
}
function refreshSessions() {
  const from = runOf($('from').value), to = runOf($('to').value)
  const names = sessionsOf([from, to])
  $('session').replaceChildren()
  for (const name of names) option($('session'), name, name + ' — ' + stageOf(name))
}
function metrics(run) {
  const totals = run.manifest.totals
  const cost = totals.usd === undefined ? '—' : '$' + totals.usd.toFixed(6)
  return [['sessions', totals.sessions], ['turns', totals.turns], ['steps', totals.steps], ['tool calls', totals.toolCalls], ['elapsed', totals.elapsedSeconds + 's'], ['cost', cost], ['input tokens', totals.inputTokens], ['output tokens', totals.outputTokens]]
}
function statesOf(graph) {
  const states = new Set()
  for (const raw of (graph ?? '').split('\\n')) {
    const line = raw.trim()
    const edge = /^(\\[\\*\\]|[A-Za-z_][\\w.-]*)\\s*-->\\s*(\\[\\*\\]|[A-Za-z_][\\w.-]*)/.exec(line)
    if (edge !== null) {
      if (edge[1] !== '[*]') states.add(edge[1])
      if (edge[2] !== '[*]') states.add(edge[2])
      continue
    }
    const declared = /^(?:state\\s+)?([A-Za-z_][\\w.-]*)\\s*:/.exec(line)
    if (declared !== null) {
      states.add(declared[1])
      continue
    }
    const bare = /^[A-Za-z_][\\w.-]*$/.exec(line)
    if (bare !== null && !['stateDiagram-v2', 'direction', 'classDef', 'class', 'note', 'end'].includes(line)) states.add(line)
  }
  return states
}
function nodesOf(run, graph) {
  return new Set(run.manifest.workflow.nodes ?? [...statesOf(graph)])
}
function runEdgesOf(run, graph) {
  return new Set(run.manifest.workflow.edges ?? [...edgesOf(graph)])
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
function edgeList(graph) {
  return (graph ?? '').split('\\n').map(line => line.trim()).filter(line => line.includes('-->'))
}
let activeNode
let activeEdge
function markActive(graph, node, edge) {
  let out = graph
  if (node !== undefined && node !== '') out += '\\n  classDef active fill:#ddf4ff,stroke:#0969da,stroke-width:3px\\n  class ' + node + ' active'
  return out
}
function promptNamesForNode(node) {
  const names = sessionsOf([runOf($('from').value), runOf($('to').value)])
  if (node === 'reviewing') return names.filter(name => name === 'overlap' || name === 'extension-points')
  if (node === 'repairing') return names.filter(name => /^repair-/.test(name))
  if (node === 'characterizing') return names.filter(name => name === 'e2e-characterize')
  if (node === 'publishingE2E') return names.filter(name => name === 'e2e-publish')
  if (node === 'reporting') return names.filter(name => /^report-/.test(name))
  return []
}
function showNoPrompt(message) {
  const box = $('full')
  box.replaceChildren()
  const note = document.createElement('p')
  note.className = 'muted'
  note.textContent = message
  box.append(note)
}
function updatePrompt() {
  const from = runOf($('from').value), to = runOf($('to').value), name = $('session').value
  const beforeStored = Object.prototype.hasOwnProperty.call(from.prompts, name)
  const afterStored = Object.prototype.hasOwnProperty.call(to.prompts, name)
  const before = beforeStored ? from.prompts[name] : '(no prompt stored)'
  const after = afterStored ? to.prompts[name] : '(no prompt stored)'
  const scrollY = window.scrollY
  const fullScroll = $('full').scrollTop
  renderFull(from, to, name, before, after, beforeStored, afterStored)
  $('title').textContent = $('view').value === 'workflow'
    ? 'Workflow + prompt: ' + name + ' · ' + stageOf(name)
    : 'Full prompt: ' + name + ' · ' + stageOf(name)
  $('full').scrollTop = fullScroll
  window.scrollTo(0, scrollY)
  $('selection').textContent = 'Selected prompt: ' + name + ' · ' + stageOf(name) + (activeNode === undefined ? '' : ' · workflow state ' + activeNode)
}
function highlightWorkflow() {
  for (const group of document.querySelectorAll('#graph g.node')) {
    const node = group.id.replace(/^state-/, '').replace(/-[0-9]+$/, '')
    group.classList.toggle('active', node === activeNode)
  }
  for (const path of document.querySelectorAll('#graph path.transition')) {
    const edge = path.dataset.edge
    const selected = edge !== undefined && edge === activeEdge
    path.style.stroke = selected ? '#0969da' : ''
    path.style.strokeWidth = selected ? '3px' : ''
  }
}
function nodeGroup(panel, node) {
  return [...panel.querySelectorAll('g.node')].find(group => group.id.replace(/^state-/, '').replace(/-[0-9]+$/, '') === node)
}
function revealNode(node) {
  for (const panel of document.querySelectorAll('#graph .graph-panel')) {
    const group = nodeGroup(panel, node)
    if (group === undefined) continue
    const panelRect = panel.getBoundingClientRect()
    const groupRect = group.getBoundingClientRect()
    if (groupRect.top < panelRect.top + 8 || groupRect.bottom > panelRect.bottom - 8) {
      panel.scrollTop += groupRect.top - panelRect.top - panel.clientHeight / 2 + groupRect.height / 2
    }
    if (groupRect.left < panelRect.left + 8 || groupRect.right > panelRect.right - 8) {
      panel.scrollLeft += groupRect.left - panelRect.left - panel.clientWidth / 2 + groupRect.width / 2
    }
  }
}
function selectNode(node) {
  const names = promptNamesForNode(node)
  activeNode = node
  activeEdge = undefined
  if (names.length === 0) {
    showNoPrompt('State ' + node + ' runs no agent prompt. Choose a review, repair, end-to-end, or report state.')
    highlightWorkflow()
    revealNode(node)
    $('workflow-note').textContent = 'State ' + node + ' has no agent prompt; click a review, repair, or end-to-end state.'
    $('selection').textContent = 'Workflow state ' + node + ' has no agent prompt'
    return
  }
  let index = names.indexOf($('session').value)
  if (index >= 0 && names.length > 1) index = (index + 1) % names.length
  else if (index < 0) index = 0
  $('session').value = names[index]
  updatePrompt()
  highlightWorkflow()
  revealNode(node)
  $('workflow-note').textContent = 'Selected state ' + node + ' · prompt ' + names[index] + ' (' + stageOf(names[index]) + ') · click again to switch'
}
function selectEdge(edge, source, target) {
  const targetNames = promptNamesForNode(target)
  const sourceNames = promptNamesForNode(source)
  const names = targetNames.length > 0 ? targetNames : sourceNames
  activeEdge = edge
  activeNode = targetNames.length > 0 ? target : sourceNames.length > 0 ? source : undefined
  if (names.length > 0) $('session').value = names[0]
  if (names.length > 0) updatePrompt()
  else showNoPrompt('Transition ' + edge + ' has no prompt on either side. Choose a state.')
  highlightWorkflow()
  if (activeNode !== undefined) revealNode(activeNode)
  $('workflow-note').textContent = names.length > 0
    ? 'Selected transition → state ' + activeNode + ' · prompt ' + names[0] + ' (' + stageOf(names[0]) + ')'
    : 'Transition ' + edge + ' has no prompt on either side; click a state to choose one.'
  if (names.length === 0) $('selection').textContent = 'Transition ' + edge + ' has no agent prompt'
}
function wireWorkflow(svg, graph) {
  for (const group of svg.querySelectorAll('g.node')) {
    const node = group.id.replace(/^state-/, '').replace(/-[0-9]+$/, '')
    if (node === '' || node === 'root_start' || node === 'root_end') continue
    group.style.cursor = 'pointer'
    group.dataset.node = node
  }
  const edges = edgeList(graph)
  for (const path of svg.querySelectorAll('path.transition')) {
    const match = /edge([0-9]+)/.exec(path.id)
    const index = match === null ? -1 : Number(match[1])
    const edge = edges[index]
    if (edge === undefined) continue
    const [source, target] = edge.split('-->').map(part => part.trim())
    path.style.cursor = 'pointer'
    path.dataset.edge = edge
    path.dataset.source = source
    path.dataset.target = target
  }
}
const mermaidPromise = import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
  return mermaid
})
let renderSeq = 0
let graphGeneration = 0
function renderGraph(box, graph, state, interactive = false, generation = graphGeneration) {
  if (generation !== graphGeneration) return
  const safe = safeGraph(graph)
  if (safe === undefined) { box.textContent = 'No safe generated statechart in this run.'; return }
  const marked = markActive(markCurrent(safe, state), activeNode, activeEdge)
  const key = String(renderSeq++)
  box.dataset.token = key
  mermaidPromise.then(mermaid => mermaid.render('graph-' + key, marked)).then(({ svg }) => {
    if (generation !== graphGeneration || box.dataset.token !== key) return
    box.innerHTML = svg
    if (interactive) { wireWorkflow(box.querySelector('svg'), safe); highlightWorkflow() }
  }).catch(error => { if (generation === graphGeneration && box.dataset.token === key) box.textContent = String(error) })
}
function renderWorkflowGraphs(from, to, generation = graphGeneration) {
  const box = $('graph')
  box.replaceChildren()
  box.classList.add('two')
  const fromGraph = safeGraph(from.manifest.workflow.graph)
  const toGraph = safeGraph(to.manifest.workflow.graph)
  if (fromGraph === undefined || toGraph === undefined) {
    box.textContent = 'One of these runs has no recorded statechart, so there is no workflow diff.'
    return
  }
  const fromGraphStates = statesOf(fromGraph), toGraphStates = statesOf(toGraph)
  const fromStates = nodesOf(from, fromGraph), toStates = nodesOf(to, toGraph)
  const fromEdges = runEdgesOf(from, fromGraph), toEdges = runEdgesOf(to, toGraph)
  const onlyFromStates = [...fromStates].filter(state => !toStates.has(state))
  const onlyToStates = [...toStates].filter(state => !fromStates.has(state))
  const onlyFromEdges = [...fromEdges].filter(edge => !toEdges.has(edge))
  const onlyToEdges = [...toEdges].filter(edge => !fromEdges.has(edge))
  const panels = [
    ['From ' + from.runId, mark(fromGraph, onlyFromStates.filter(state => fromGraphStates.has(state)), 'removed', '#ffebe9'), from.manifest.workflow.state, onlyFromStates.length, onlyFromEdges],
    ['To ' + to.runId, mark(toGraph, onlyToStates.filter(state => toGraphStates.has(state)), 'added', '#dafbe1'), to.manifest.workflow.state, onlyToStates.length, onlyToEdges],
  ]
  for (const [title, graph, state, stateCount, onlyEdges] of panels) {
    const panel = document.createElement('div')
    panel.className = 'graph-panel'
    const heading = document.createElement('h3')
    heading.textContent = title
    const summary = document.createElement('p')
    summary.className = 'muted'
    const edgeList = onlyEdges.slice(0, 4).join(', ') + (onlyEdges.length > 4 ? ' …' : '')
    summary.textContent = stateCount === 0 && onlyEdges.length === 0
      ? 'no structural difference from the other run'
      : String(stateCount) + ' state(s) only here' + (stateCount === 0 ? '' : ' (colored)')
        + ' · ' + String(onlyEdges.length) + ' transition(s) only here' + (onlyEdges.length === 0 ? '' : ': ' + edgeList)
    const target = document.createElement('div')
    panel.append(heading, summary, target)
    box.append(panel)
    renderGraph(target, graph, state, true, generation)
  }
}
function renderGraphDiff(from, to, generation = graphGeneration) {
  if (generation !== graphGeneration) return
  const before = safeGraph(from.manifest.workflow.graph)
  const after = safeGraph(to.manifest.workflow.graph)
  if (before === undefined || after === undefined) { $('graphdiff').textContent = 'One of these runs has no recorded statechart, so there is nothing to compare.'; return }
  const beforeGraphStates = statesOf(before), afterGraphStates = statesOf(after)
  const fromStates = nodesOf(from, before), toStates = nodesOf(to, after)
  const fromEdges = runEdgesOf(from, before), toEdges = runEdgesOf(to, after)
  const onlyFrom = [...fromEdges].filter(edge => !toEdges.has(edge))
  const onlyTo = [...toEdges].filter(edge => !fromEdges.has(edge))
  const beforeMarked = mark(before, [...fromStates].filter(state => !toStates.has(state) && beforeGraphStates.has(state)), 'removed', '#ffebe9')
  const afterMarked = mark(after, [...toStates].filter(state => !fromStates.has(state) && afterGraphStates.has(state)), 'added', '#dafbe1')
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
  }).catch(error => { box.dataset.key = ''; if (generation === graphGeneration && box.dataset.token === key) box.textContent = String(error) })
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
  const cols = document.createElement('colgroup')
  for (const width of ['3.5em', '', '3.5em', '']) {
    const col = document.createElement('col')
    if (width !== '') col.style.width = width
    cols.append(col)
  }
  table.append(cols)
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const [text, span, cls] of [['From ' + from.runId + ' · ' + stageOf(name), 2, 'left'], ['To ' + to.runId + ' · ' + stageOf(name), 2, '']]) {
    const th = document.createElement('th')
    if (cls !== '') th.className = cls
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
    tr.append(cell((row.leftClass + ' left').trim(), row.left ?? ''))
    tr.append(cell('n', row.right === null ? '' : String(++rightLine)))
    tr.append(cell(row.rightClass, row.right ?? ''))
    body.append(tr)
  }
  table.append(body)
  box.append(table)
}

$('graph').addEventListener('click', (event) => {
  const path = event.target.closest?.('path.transition')
  if (path !== null && path !== undefined && path.dataset.edge !== undefined) {
    selectEdge(path.dataset.edge, path.dataset.source ?? '', path.dataset.target ?? '')
    return
  }
  const group = event.target.closest?.('g.node')
  if (group === null || group === undefined) return
  const node = group.dataset.node ?? group.id.replace(/^state-/, '').replace(/-[0-9]+$/, '')
  if (node !== '') selectNode(node)
})

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
    evaluation.record === undefined ? '' : evaluation.record.startsWith('http://') || evaluation.record.startsWith('https://') ? '<a href="' + esc(evaluation.record) + '">record</a>' : 'record <span class="mono">' + esc(evaluation.record) + '</span>',
  ].filter(Boolean)
  const evalLinks = evaluationParts.length === 0 ? '' : '<p>Evaluation: ' + evaluationParts.join(' · ') + '</p>'
  const warningText = data.warnings.length === 0 ? '' : '<p class="muted">Evidence warnings: ' + data.warnings.map(esc).join('; ') + '</p>'
  $('summary').innerHTML = warningText + '<p><span class="mono">' + esc(from.runId) + '</span> → <span class="mono">' + esc(to.runId) + '</span> · run state <span class="state">' + esc(to.manifest.workflow.state ?? to.manifest.outcome) + '</span></p>' + evalLinks
  $('cards').innerHTML = metrics(to).map(([label, value]) => '<div class="card"><b>' + value + '</b><span>' + label + '</span></div>').join('')
  const view = $('view').value
  graphGeneration += 1
  const generation = graphGeneration
  document.body.dataset.view = view
  $('workflow-pane').hidden = !(view === 'graph' || view === 'workflow')
  $('full').hidden = !(view === 'full' || view === 'workflow')
  $('graph').hidden = !(view === 'graph' || view === 'workflow')
  $('graphdiff').hidden = view !== 'graph-diff'
  $('workflow-note').hidden = view !== 'workflow'
  if (view === 'full' || view === 'workflow') renderFull(from, to, name, before, after, beforeStored, afterStored)
  if (view === 'workflow') {
    $('workflow-note').textContent = activeNode === undefined
      ? 'Click a state or a transition. A transition shows the target state\\'s prompt, then the source state\\'s prompt.'
      : 'Selected ' + (activeEdge === undefined ? 'state ' : 'transition → state ') + activeNode + ' · prompt ' + name + ' (' + stageOf(name) + ') · click again to switch'
    renderWorkflowGraphs(from, to, generation)
  }
  if (view === 'graph') renderGraph($('graph'), to.manifest.workflow.graph, to.manifest.workflow.state, false)
  if (view === 'graph-diff') renderGraphDiff(from, to)
  $('title').textContent = view === 'workflow' ? 'Workflow + prompt: ' + name + ' · ' + stageOf(name)
    : view === 'full' ? 'Full prompt: ' + name + ' · ' + stageOf(name)
      : view === 'graph' ? 'Statechart' : 'Statechart diff (from → to)'
  $('selection').textContent = 'Selected prompt: ' + name + ' · ' + stageOf(name) + (activeNode === undefined ? '' : ' · workflow state ' + activeNode)
}
for (const id of ['from', 'to']) $(id).addEventListener('change', () => { activeNode = undefined; activeEdge = undefined; refreshSessions(); render() })
$('jump-prompt').addEventListener('click', () => $('full').scrollIntoView({ behavior: 'smooth', block: 'start' }))
$('session').addEventListener('change', updatePrompt)
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
