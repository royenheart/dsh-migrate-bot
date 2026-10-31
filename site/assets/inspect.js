import { escape, nav } from './common.js'

nav('Run evidence')

const $ = id => document.getElementById(id)
const state = { data: undefined, generation: 0, activeNode: undefined, activeEdge: undefined, mermaid: undefined }

function stageOf(name) {
  if (name === 'overlap') return 'review · overlap'
  if (name === 'extension-points') return 'review · extension points'
  const repair = /^repair-(\d+)$/.exec(name)
  if (repair !== null) return `repair · attempt ${repair[1]}`
  if (name === 'e2e-characterize') return 'end-to-end · characterize'
  if (name === 'e2e-publish') return 'end-to-end · publish'
  if (name.startsWith('report-')) return `merge report · ${name.slice(7)}`
  return name
}

function nodeForPrompt(name) {
  if (name === 'overlap' || name === 'extension-points') return 'reviewing'
  if (name.startsWith('repair-')) return 'repairing'
  if (name === 'e2e-characterize') return 'characterizing'
  if (name === 'e2e-publish') return 'publishingE2E'
  if (name.startsWith('report-')) return 'reporting'
  return undefined
}

function runs() { return state.data?.runs ?? [] }
function runOf(id) { return runs().find(run => run.runId === id) }
function fromRun() { return runOf($('from').value) }
function toRun() { return runOf($('to').value) }
function sessionNames() {
  return [...new Set(runs().flatMap(run => run.manifest.sessions.map(session => session.name)))]
}

function status(text, error = false) {
  const box = $('loader-error')
  box.hidden = text === ''
  box.textContent = text
  box.classList.toggle('warning', error)
}

async function readJsonUrl(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`)
  return await response.json()
}

function accept(data) {
  if (typeof data !== 'object' || data === null || !Array.isArray(data.runs) || data.runs.length === 0) {
    throw new Error('not an inspect bundle: runs[] is missing or empty')
  }
  for (const run of data.runs) {
    if (typeof run?.runId !== 'string' || typeof run?.manifest?.startedAt !== 'string' || typeof run?.prompts !== 'object' || run.prompts === null) {
      throw new Error('not an inspect bundle: a run has no runId, manifest or prompts')
    }
  }
  state.data = data
  state.activeNode = undefined
  state.activeEdge = undefined
  $('loader').hidden = true
  $('view').hidden = false
  const all = runs()
  $('from').replaceChildren()
  $('to').replaceChildren()
  for (const run of all) {
    for (const select of [$('from'), $('to')]) {
      const option = document.createElement('option')
      option.value = run.runId
      option.textContent = `${run.runId} · ${run.manifest.startedAt}`
      select.append(option)
    }
  }
  $('from').value = all.length > 1 ? all[all.length - 2].runId : all[0].runId
  $('to').value = all[all.length - 1].runId
  refreshSessions()
  render()
}

async function loadFile(file) {
  try {
    accept(JSON.parse(await file.text()))
  } catch (error) {
    $('loader').hidden = false
    $('view').hidden = true
    status(error instanceof Error ? error.message : String(error), true)
  }
}

$('file').addEventListener('change', () => {
  const file = $('file').files?.[0]
  if (file !== undefined) void loadFile(file)
})
$('load-url').addEventListener('click', async () => {
  const url = $('url').value.trim()
  if (url === '') { status('enter a URL first', true); return }
  try { accept(await readJsonUrl(url)) } catch (error) { status(error instanceof Error ? error.message : String(error), true) }
})
$('jump').addEventListener('click', () => $('prompts').scrollIntoView({ behavior: 'smooth', block: 'start' }))
$('from').addEventListener('change', () => { state.activeNode = undefined; state.activeEdge = undefined; refreshSessions(); render() })
$('to').addEventListener('change', () => { state.activeNode = undefined; state.activeEdge = undefined; refreshSessions(); render() })
$('session').addEventListener('change', () => {
  const name = $('session').value
  state.activeNode = nodeForPrompt(name)
  state.activeEdge = undefined
  updatePrompt()
  highlight()
  if (state.activeNode !== undefined) reveal(state.activeNode)
})

function refreshSessions() {
  const names = sessionNames()
  const previous = $('session').value
  $('session').replaceChildren()
  for (const name of names) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = stageOf(name)
    $('session').append(option)
  }
  $('session').value = names.includes(previous) ? previous : names[0] ?? ''
}

function numeric(value, digits = 0) {
  return value === undefined ? '—' : Number(value).toFixed(digits)
}

function renderMetrics() {
  const totals = toRun()?.manifest.totals
  const cards = totals === undefined ? [] : [
    ['sessions', totals.sessions], ['turns', totals.turns], ['steps', totals.steps], ['tool calls', totals.toolCalls],
    ['elapsed', `${totals.elapsedSeconds}s`], ['cost', totals.usd === undefined ? '—' : `$${totals.usd.toFixed(3)}`],
    ['input tokens', Number(totals.inputTokens).toLocaleString('en-US')], ['output tokens', Number(totals.outputTokens).toLocaleString('en-US')],
  ]
  $('metrics').innerHTML = cards.map(([label, value]) => `<div class="stat"><b>${escape(value)}</b><span>${escape(label)}</span></div>`).join('')
}

function renderWarnings() {
  const warnings = state.data?.warnings ?? []
  const run = toRun()
  const evaluation = run?.manifest.evaluation
  const pieces = []
  if (evaluation !== undefined) {
    const parts = []
    if (evaluation.harborJob !== undefined) parts.push(`Harbor job <code>${escape(evaluation.harborJob)}</code>`)
    if (evaluation.trialId !== undefined) parts.push(`trial <code>${escape(evaluation.trialId)}</code>`)
    if (evaluation.record !== undefined) {
      parts.push(/^https?:\/\//.test(evaluation.record)
        ? `<a href="${escape(evaluation.record)}">record</a>`
        : `record <code>${escape(evaluation.record)}</code>`)
    }
    if (parts.length > 0) pieces.push(`<p class="muted">Evaluation: ${parts.join(' · ')}</p>`)
  }
  if (warnings.length > 0) pieces.push(`<p class="warning">${warnings.map(escape).join('; ')}</p>`)
  $('warnings').innerHTML = pieces.join('')
}

function statesOf(graph) {
  const set = new Set()
  for (const raw of (graph ?? '').split('\n')) {
    const line = raw.trim()
    const edge = /^(\[\*\]|[A-Za-z_][\w.-]*)\s*-->\s*(\[\*\]|[A-Za-z_][\w.-]*)/.exec(line)
    if (edge !== null) {
      if (edge[1] !== '[*]') set.add(edge[1])
      if (edge[2] !== '[*]') set.add(edge[2])
      continue
    }
    const declared = /^(?:state\s+)?([A-Za-z_][\w.-]*)\s*:/.exec(line)
    if (declared !== null) set.add(declared[1])
  }
  return set
}

function edgesOf(graph) {
  return new Set((graph ?? '').split('\n').map(line => line.trim()).filter(line => line.includes('-->')))
}

function nodesOf(run, graph) {
  return new Set(run.manifest.workflow.nodes ?? [...statesOf(graph)])
}

function runEdges(run, graph) {
  return new Set(run.manifest.workflow.edges ?? [...edgesOf(graph)])
}

function mark(graph, only, cls, fill) {
  if (only.length === 0) return graph
  return `${graph}\n  classDef ${cls} fill:${fill},stroke:#57606a\n${only.map(name => `  class ${name} ${cls}`).join('\n')}`
}

function markCurrent(graph, current) {
  if (graph === undefined || current === undefined) return graph
  return `${graph}\n  classDef current fill:#fff8c5,stroke:#9a6700,stroke-width:2px\n  class ${current} current`
}

function mermaid() {
  if (state.mermaid === undefined) {
    state.mermaid = import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs').then(({ default: api }) => {
      api.initialize({ startOnLoad: false, securityLevel: 'strict' })
      return api
    })
  }
  return state.mermaid
}

function highlight() {
  for (const node of document.querySelectorAll('#workflows .node')) {
    const name = node.id.replace(/^state-/, '').replace(/-[0-9]+$/, '')
    node.classList.toggle('active', name === state.activeNode)
  }
  for (const path of document.querySelectorAll('#workflows path.transition')) {
    const edge = path.dataset.edge
    path.style.stroke = edge === state.activeEdge ? 'var(--accent)' : ''
    path.style.strokeWidth = edge === state.activeEdge ? '3px' : ''
  }
}

function reveal(node) {
  for (const panel of document.querySelectorAll('#workflows .graph-panel')) {
    const group = [...panel.querySelectorAll('.node')].find(candidate => candidate.id.replace(/^state-/, '').replace(/-[0-9]+$/, '') === node)
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

function workflowGraphs() {
  const from = fromRun()
  const to = toRun()
  if (from === undefined || to === undefined) return
  const fromGraph = from.manifest.workflow.graph
  const toGraph = to.manifest.workflow.graph
  const fromGraphStates = statesOf(fromGraph)
  const toGraphStates = statesOf(toGraph)
  const fromStates = nodesOf(from, fromGraph)
  const toStates = nodesOf(to, toGraph)
  const onlyFrom = [...fromStates].filter(name => !toStates.has(name))
  const onlyTo = [...toStates].filter(name => !fromStates.has(name))
  const fromEdges = runEdges(from, fromGraph)
  const toEdges = runEdges(to, toGraph)
  const onlyFromEdges = [...fromEdges].filter(edge => !toEdges.has(edge))
  const onlyToEdges = [...toEdges].filter(edge => !fromEdges.has(edge))
  const box = $('workflows')
  box.replaceChildren()
  const panels = [
    { run: from, graph: fromGraph, state: from.manifest.workflow.state, label: 'From', states: onlyFrom, graphStates: fromGraphStates, edges: onlyFromEdges },
    { run: to, graph: toGraph, state: to.manifest.workflow.state, label: 'To', states: onlyTo, graphStates: toGraphStates, edges: onlyToEdges },
  ]
  for (const panel of panels) {
    const section = document.createElement('section')
    section.className = 'graph-panel'
    const title = document.createElement('h3')
    title.textContent = `${panel.label} ${panel.run.runId}`
    const note = document.createElement('p')
    note.className = 'diff-note'
    const stateCount = panel.states.length
    const edgeCount = panel.edges.length
    note.textContent = stateCount === 0 && edgeCount === 0
      ? 'No structural difference from the other run.'
      : `${stateCount} state${stateCount === 1 ? '' : 's'} · ${edgeCount} transition${edgeCount === 1 ? '' : 's'} only here`
    note.title = panel.edges.join('\n')
    const graphBox = document.createElement('div')
    graphBox.className = 'graph'
    section.append(title, note, graphBox)
    box.append(section)
    if (panel.graph === undefined) { graphBox.textContent = 'No recorded statechart for this run.'; continue }
    const visible = panel.states.filter(name => panel.graphStates.has(name))
    const source = markCurrent(mark(panel.graph, visible, panel.label === 'From' ? 'removed' : 'added', panel.label === 'From' ? '#ffebe9' : '#dafbe1'), panel.state)
    const generation = state.generation
    mermaid().then(api => api.render(`site-graph-${panel.label}-${String(generation)}`, source)).then(({ svg }) => {
      if (generation !== state.generation) return
      graphBox.innerHTML = svg
      for (const node of graphBox.querySelectorAll('.node')) {
        const name = node.id.replace(/^state-/, '').replace(/-[0-9]+$/, '')
        node.dataset.node = name
        node.style.cursor = 'pointer'
      }
      const edges = [...edgesOf(panel.graph)]
      for (const path of graphBox.querySelectorAll('path.transition')) {
        const index = Number((/edge([0-9]+)/.exec(path.id) ?? [])[1])
        const edge = edges[index]
        if (edge === undefined) continue
        path.dataset.edge = edge
        const clean = part => part.replace(/\s*:.*$/, '').trim()
        const [fromNode, toNode] = edge.split('-->').map(clean)
        path.dataset.source = fromNode
        path.dataset.target = toNode
        path.style.cursor = 'pointer'
      }
      highlight()
    }).catch(error => { if (generation === state.generation) graphBox.textContent = String(error) })
  }
}

$('workflows').addEventListener('click', event => {
  const path = event.target.closest?.('path.transition')
  if (path?.dataset.edge !== undefined) {
    selectEdge(path.dataset.edge, path.dataset.source ?? '', path.dataset.target ?? '')
    return
  }
  const node = event.target.closest?.('.node')
  if (node?.dataset.node !== undefined) selectNode(node.dataset.node)
})

function promptNamesForNode(node) {
  const names = sessionNames()
  if (node === 'reviewing') return names.filter(name => name === 'overlap' || name === 'extension-points')
  if (node === 'repairing') return names.filter(name => /^repair-/.test(name))
  if (node === 'characterizing') return names.filter(name => name === 'e2e-characterize')
  if (node === 'publishingE2E') return names.filter(name => name === 'e2e-publish')
  if (node === 'reporting') return names.filter(name => /^report-/.test(name))
  return []
}

function showNoPrompt(message) {
  const box = $('prompts')
  box.replaceChildren()
  const note = document.createElement('p')
  note.className = 'empty'
  note.textContent = message
  box.append(note)
}

function selectNode(node) {
  state.activeNode = node
  state.activeEdge = undefined
  const names = promptNamesForNode(node)
  if (names.length === 0) {
    showNoPrompt(`State ${node} runs no agent prompt. Choose a review, repair, end-to-end, or report state.`)
    $('prompt-title').textContent = `No prompt · ${node}`
    $('prompt-stage').textContent = ''
    $('selection').textContent = `Workflow state ${node} has no agent prompt`
    highlight()
    reveal(node)
    return
  }
  let index = names.indexOf($('session').value)
  if (index >= 0 && names.length > 1) index = (index + 1) % names.length
  else if (index < 0) index = 0
  $('session').value = names[index]
  updatePrompt()
  highlight()
  reveal(node)
  $('selection').textContent = `Selected: ${stageOf(names[index])} · workflow state ${node}`
}

function selectEdge(edge, source, target) {
  const targetNames = promptNamesForNode(target)
  const sourceNames = promptNamesForNode(source)
  const names = targetNames.length > 0 ? targetNames : sourceNames
  state.activeEdge = edge
  state.activeNode = targetNames.length > 0 ? target : sourceNames.length > 0 ? source : undefined
  if (names.length > 0) {
    $('session').value = names[0]
    updatePrompt()
  } else {
    showNoPrompt(`Transition ${edge} has no prompt on either side. Choose a state.`)
    $('prompt-title').textContent = `No prompt · ${edge}`
    $('prompt-stage').textContent = ''
    $('selection').textContent = `Transition ${edge} has no agent prompt`
  }
  highlight()
  if (state.activeNode !== undefined) reveal(state.activeNode)
}

function splitLines(value) {
  const lines = value.split('\n')
  if (value.endsWith('\n')) lines.pop()
  return lines
}

function fullRows(before, after) {
  if (globalThis.Diff === undefined) {
    const left = splitLines(before)
    const right = splitLines(after)
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => ({
      left: left[index] ?? null, right: right[index] ?? null, leftClass: '', rightClass: '',
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
    if (part.removed) { removed.push(...lines); continue }
    if (part.added) { added.push(...lines); continue }
    flush()
    for (const line of lines) rows.push({ left: line, right: line, leftClass: '', rightClass: '' })
  }
  flush()
  return rows
}

function cell(className, text) {
  const td = document.createElement('td')
  if (className !== '') td.className = className
  td.textContent = text
  return td
}

function renderPromptTable(from, to, name) {
  const beforeStored = Object.prototype.hasOwnProperty.call(from.prompts, name)
  const afterStored = Object.prototype.hasOwnProperty.call(to.prompts, name)
  if (!beforeStored || !afterStored) {
    const missing = [!beforeStored ? 'from' : '', !afterStored ? 'to' : ''].filter(Boolean).join(' and ')
    showNoPrompt(`No prompt stored in the ${missing} run.`)
    $('prompt-title').textContent = `No prompt · ${name}`
    $('prompt-stage').textContent = 'missing'
    return
  }
  const before = from.prompts[name]
  const after = to.prompts[name]
  const table = document.createElement('table')
  table.className = 'inspect-table'
  const cols = document.createElement('colgroup')
  for (const width of ['3.2em', '', '3.2em', '']) {
    const col = document.createElement('col')
    if (width !== '') col.style.width = width
    cols.append(col)
  }
  const head = document.createElement('thead')
  const row = document.createElement('tr')
  for (const [text, span, cls] of [[`From ${from.runId} · ${stageOf(name)}`, 2, 'left'], [`To ${to.runId} · ${stageOf(name)}`, 2, '']]) {
    const th = document.createElement('th')
    th.colSpan = span
    if (cls !== '') th.className = cls
    th.textContent = text
    row.append(th)
  }
  head.append(row)
  table.append(cols, head)
  const body = document.createElement('tbody')
  let leftLine = 0
  let rightLine = 0
  for (const line of fullRows(before, after)) {
    const tr = document.createElement('tr')
    tr.append(cell('n', line.left === null ? '' : String(++leftLine)))
    tr.append(cell(`${line.leftClass} left`.trim(), line.left ?? ''))
    tr.append(cell('n', line.right === null ? '' : String(++rightLine)))
    tr.append(cell(line.rightClass, line.right ?? ''))
    body.append(tr)
  }
  table.append(body)
  $('prompts').replaceChildren(table)
  $('prompt-title').textContent = `Prompt comparison · ${name}`
  $('prompt-stage').textContent = stageOf(name)
}

function renderChips() {
  const box = $('chips')
  box.replaceChildren()
  for (const name of sessionNames()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'stage-chip'
    button.setAttribute('aria-pressed', name === $('session').value ? 'true' : 'false')
    button.textContent = stageOf(name)
    button.addEventListener('click', () => {
      $('session').value = name
      state.activeNode = nodeForPrompt(name)
      state.activeEdge = undefined
      updatePrompt()
      highlight()
      if (state.activeNode !== undefined) reveal(state.activeNode)
    })
    box.append(button)
  }
}

function updatePrompt() {
  const from = fromRun()
  const to = toRun()
  if (from === undefined || to === undefined) return
  const name = $('session').value
  renderPromptTable(from, to, name)
  $('selection').textContent = `Selected: ${stageOf(name)}${state.activeNode === undefined ? '' : ` · workflow state ${state.activeNode}`}`
  renderChips()
}

function render() {
  if (state.data === undefined) return
  state.generation += 1
  renderMetrics()
  renderWarnings()
  refreshSessionsIfNeeded()
  updatePrompt()
  workflowGraphs()
}

let lastPair = ''
function refreshSessionsIfNeeded() {
  const pair = `${$('from').value}|${$('to').value}`
  if (pair === lastPair) return
  lastPair = pair
  refreshSessions()
}

const query = new URLSearchParams(location.search)
if (query.get('data') !== null) {
  void readJsonUrl(query.get('data')).then(accept).catch(error => {
    $('loader').hidden = false
    $('view').hidden = true
    status(error instanceof Error ? error.message : String(error), true)
  })
}
