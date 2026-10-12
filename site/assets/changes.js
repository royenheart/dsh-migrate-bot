import { day, escape, fail, fmt, loadIndex, nav, params, select, setParams, short } from './common.js'

nav('Changes')

const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'
const monaco = new Promise((resolve) => {
  globalThis.require.config({ paths: { vs: MONACO } })
  globalThis.require(['vs/editor/editor.main'], () => resolve(globalThis.monaco))
})
const mermaid = import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs').then(({ default: api }) => {
  api.initialize({ startOnLoad: false, securityLevel: 'strict' })
  return api
})

const snapshots = new Map()
async function snapshot(hash) {
  if (!snapshots.has(hash)) {
    snapshots.set(hash, (async () => {
      const manifest = await (await fetch(`data/snapshots/${hash}/manifest.json`)).json()
      const entries = await Promise.all(Object.keys(manifest.files).map(async path => [path, await (await fetch(`data/snapshots/${hash}/files/${path}`)).text()]))
      return new Map(entries)
    })())
  }
  return snapshots.get(hash)
}

/** The sections of a snapshot, by path prefix, in the order the page lists them. */
const GROUPS = [['workflow.md', 'Statechart'], ['configuration.md', 'Configuration'], ['prompts/', 'Prompts'], ['runtime/', 'Agent runtime'], ['skills.json', 'Upgrade skills'], ['source/', 'Source']]
const groupOf = path => GROUPS.find(([prefix]) => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix)))?.[0]

const languageOf = path => path.endsWith('.json') ? 'json' : path.endsWith('.md') ? 'markdown' : path.endsWith('.js') ? 'javascript' : path.endsWith('.yml') ? 'yaml' : 'plaintext'
const mermaidOf = text => /```mermaid\n([\s\S]*?)```/.exec(text)?.[1]
/** The states a stateDiagram names in its transitions. */
const statesOf = text => new Set((text ?? '').split('\n').flatMap(line => /^\s*(\w+) --> (\w+)/.exec(line)?.slice(1) ?? []))

function stat(before, after) {
  let add = 0
  let del = 0
  for (const part of globalThis.Diff.diffLines(before ?? '', after ?? '')) {
    if (part.added) add += part.count
    if (part.removed) del += part.count
  }
  return { add, del }
}

function bar(add, del) {
  const total = add + del
  const green = total === 0 ? 0 : Math.round((add / total) * 5)
  const red = total === 0 ? 0 : Math.min(5 - green, Math.round((del / total) * 5))
  return `<span class="diffstat">${'<i class="add"></i>'.repeat(green)}${'<i class="del"></i>'.repeat(red)}${'<i></i>'.repeat(5 - green - red)}</span>`
}

let editor
async function showFile(path, before, after, view) {
  const graphs = document.getElementById('graphs')
  const box = document.getElementById('editor')
  if (view === 'graph') {
    box.style.display = 'none'
    const api = await mermaid
    const [from, to] = [mermaidOf(before ?? ''), mermaidOf(after ?? '')]
    const [fromStates, toStates] = [statesOf(from), statesOf(to)]
    // A state only one side has is coloured: removed on the left, added on the right.
    const mark = (text, others, name, fill) => {
      const only = [...statesOf(text)].filter(state => !others.has(state))
      return only.length === 0 ? text : `${text}\n  classDef ${name} fill:${fill},stroke:#57606a\n${only.map(state => `  class ${state} ${name}`).join('\n')}\n`
    }
    const render = async (id, text) => text === undefined ? '<p class="muted">no diagram</p>' : (await api.render(id, text)).svg
    graphs.innerHTML = `<div><h2>From</h2>${await render('from-graph', from === undefined ? undefined : mark(from, toStates, 'removed', '#ffebe9'))}</div><div><h2>To</h2>${await render('to-graph', to === undefined ? undefined : mark(to, fromStates, 'added', '#dafbe1'))}</div>`
    return
  }
  graphs.innerHTML = ''
  box.style.display = ''
  const api = await monaco
  if (editor === undefined) editor = api.editor.createDiffEditor(box, { readOnly: true, automaticLayout: true, originalEditable: false })
  editor.updateOptions({ renderSideBySide: view !== 'inline' })
  const previous = editor.getModel()
  editor.setModel({ original: api.editor.createModel(before ?? '', languageOf(path)), modified: api.editor.createModel(after ?? '', languageOf(path)) })
  previous?.original.dispose()
  previous?.modified.dispose()
}

async function render(state, records) {
  setParams(state)
  const [from, to] = [records.find(record => record.id === state.from), records.find(record => record.id === state.to)]
  const [before, after] = await Promise.all([snapshot(from.producer.snapshot), snapshot(to.producer.snapshot)])
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  const rows = paths.map((path) => {
    const status = !before.has(path) ? 'added' : !after.has(path) ? 'removed' : before.get(path) === after.get(path) ? 'unchanged' : 'modified'
    return { path, status, ...stat(before.get(path), after.get(path)) }
  })
  const changed = rows.filter(row => row.status !== 'unchanged')
  const score = record => `${record.subject.id} meanReward ${fmt(record.metrics.values.meanReward)}`
  document.getElementById('summary').innerHTML = `<p><span class="mono">${short(from.producer.commit)}</span> ${escape(from.producer.message)} <span class="muted">(${day(from.createdAt)}, ${score(from)})</span><br>→ <span class="mono">${short(to.producer.commit)}</span> ${escape(to.producer.message)} <span class="muted">(${day(to.createdAt)}, ${score(to)})</span></p>
    <p>${from.producer.snapshot === to.producer.snapshot ? 'The Action was the same in both runs.' : `${changed.length} of ${rows.length} file(s) changed.`} <a href="compare.html?base=${encodeURIComponent(from.id)}&head=${encodeURIComponent(to.id)}">Compare the scores</a></p>`
  if (state.file === undefined || !paths.includes(state.file)) state.file = changed[0]?.path ?? paths[0]
  const entry = row => `<a href="#" data-path="${escape(row.path)}" class="mono${row.path === state.file ? ' selected' : ''}">${escape(row.path.slice(row.path.indexOf('/') + 1) || row.path)}</a>${row.status === 'unchanged' ? '' : ` <span class="${row.status === 'modified' ? '' : 'muted'}">${row.status === 'modified' ? '' : row.status}</span> <span class="improvement">+${row.add}</span> <span class="regression">−${row.del}</span>${bar(row.add, row.del)}`}`
  const groups = GROUPS.map(([prefix, title]) => [title, rows.filter(row => groupOf(row.path) === prefix)]).filter(([, members]) => members.length > 0)
  document.getElementById('files').innerHTML = groups.map(([title, members]) => {
    const moved = members.filter(row => row.status !== 'unchanged')
    const still = members.filter(row => row.status === 'unchanged')
    return `<h2>${title}</h2>${moved.map(row => `<div>${entry(row)}</div>`).join('')}${still.length === 0 ? '' : `<details${moved.length === 0 ? '' : ''}><summary class="muted">${still.length} unchanged</summary>${still.map(row => `<div>${entry(row)}</div>`).join('')}</details>`}`
  }).join('')
  for (const link of document.querySelectorAll('#files a[data-path]')) {
    link.onclick = (event) => {
      event.preventDefault()
      render({ ...state, file: link.dataset.path, view: link.dataset.path === 'workflow.md' ? state.view : state.view === 'graph' ? 'side-by-side' : state.view }, records).catch(fail)
    }
  }
  document.getElementById('file').textContent = state.file
  const views = [['side-by-side', 'side by side'], ['inline', 'inline'], ...(state.file === 'workflow.md' ? [['graph', 'statechart graphs']] : [])]
  if (!views.some(([key]) => key === state.view)) state.view = 'side-by-side'
  select('view', views, state.view, value => render({ ...state, view: value }, records).catch(fail))
  setParams(state)
  await showFile(state.file, before.get(state.file), after.get(state.file), state.view)
}

try {
  const index = await loadIndex()
  const records = index.records
  if (records.length === 0) throw new Error('No record has been published yet.')
  const label = record => `${short(record.producer.commit)} · ${record.subject.id} · ${day(record.createdAt)} · ${record.producer.message.slice(0, 60)}`
  const state = { from: params.get('from'), to: params.get('to'), file: params.get('file') ?? undefined, view: params.get('view') ?? 'side-by-side' }
  // `range=latest`, or a missing side: the newest record, and the newest earlier one whose Action differs.
  if (params.get('range') === 'latest' || !records.some(record => record.id === state.to)) state.to = records[0].id
  if (params.get('range') === 'latest' || !records.some(record => record.id === state.from)) {
    const to = records.find(record => record.id === state.to)
    state.from = records.find(record => record.createdAt < to.createdAt && record.producer.snapshot !== to.producer.snapshot)?.id ?? records.at(-1).id
  }
  params.delete('range')
  const options = records.map(record => [record.id, label(record)])
  select('from', options, state.from, value => render({ ...state, from: value }, records).catch(fail))
  select('to', options, state.to, value => render({ ...state, to: value }, records).catch(fail))
  await render(state, records)
} catch (error) {
  fail(error)
}
