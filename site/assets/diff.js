import { day, escape, fail, loadArtifact, loadIndex, loadRecord, nav, params, select, setParams, short } from './common.js'

nav('Diff')

const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs'
const monaco = new Promise((resolve) => {
  globalThis.require.config({ paths: { vs: MONACO } })
  globalThis.require(['vs/editor/editor.main'], () => resolve(globalThis.monaco))
})

const languageOf = path => path.endsWith('.json') || path.endsWith('.jsonl') ? 'json' : path.endsWith('.md') ? 'markdown' : 'plaintext'

/** The files a unified diff touches, with their added and deleted lines. */
function filesOf(diff) {
  const files = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) files.push({ name: line.slice(line.lastIndexOf(' b/') + 3), add: 0, del: 0 })
    else if (files.length > 0 && line.startsWith('+') && !line.startsWith('+++')) files[files.length - 1].add += 1
    else if (files.length > 0 && line.startsWith('-') && !line.startsWith('---')) files[files.length - 1].del += 1
  }
  return files
}

function diffstat(add, del) {
  const total = add + del
  const green = total === 0 ? 0 : Math.round((add / total) * 5)
  const red = total === 0 ? 0 : Math.min(5 - green, Math.round((del / total) * 5))
  return `<span class="diffstat">${'<i class="add"></i>'.repeat(green)}${'<i class="del"></i>'.repeat(red)}${'<i></i>'.repeat(5 - green - red)}</span>`
}

function stats(label, text) {
  const files = filesOf(text)
  if (files.length === 0) return `<p><strong>${label}</strong>: <span class="muted">${text === '' ? 'empty' : 'not a unified diff'}</span></p>`
  const add = files.reduce((sum, file) => sum + file.add, 0)
  const del = files.reduce((sum, file) => sum + file.del, 0)
  return `<p><strong>${label}</strong>: ${files.length} file(s), <span class="improvement">+${add}</span> <span class="regression">−${del}</span>${diffstat(add, del)}</p>
    <div class="files">${files.map(file => `<div class="mono">${escape(file.name)} <span class="improvement">+${file.add}</span> <span class="regression">−${file.del}</span></div>`).join('')}</div>`
}

let editor
async function render(state) {
  setParams(state)
  const [from, to] = await Promise.all([loadRecord(state.from), loadRecord(state.to)])
  const pick = (record, attempt) => record.attempts.find(candidate => candidate.task === state.task && candidate.attempt === Number(attempt))
  const [left, right] = [pick(from, state.fromAttempt), pick(to, state.toAttempt)]
  const path = attempt => attempt?.artifacts[state.artifact]?.path
  const [original, modified] = await Promise.all([
    path(left) === undefined ? '' : loadArtifact(from.id, path(left)),
    path(right) === undefined ? '' : loadArtifact(to.id, path(right)),
  ])
  document.getElementById('stats').innerHTML = state.artifact.endsWith('.diff')
    ? stats(`From ${short(from.producer.commit)} attempt ${state.fromAttempt}`, original) + stats(`To ${short(to.producer.commit)} attempt ${state.toAttempt}`, modified)
    : ''
  const api = await monaco
  if (editor === undefined) {
    editor = api.editor.createDiffEditor(document.getElementById('editor'), { readOnly: true, automaticLayout: true, originalEditable: false })
    editor.onDidUpdateDiff(() => {
      document.getElementById('changes').textContent = `${(editor.getLineChanges() ?? []).length} changed region(s)`
    })
  }
  editor.updateOptions({ renderSideBySide: state.view !== 'inline' })
  const previous = editor.getModel()
  editor.setModel({ original: api.editor.createModel(original, languageOf(state.artifact)), modified: api.editor.createModel(modified, languageOf(state.artifact)) })
  previous?.original.dispose()
  previous?.modified.dispose()
}

try {
  const index = await loadIndex()
  if (index.records.length === 0) throw new Error('No record has been published yet.')
  const subjects = [...new Set(index.records.map(record => record.subject.id))]
  const state = {
    subject: subjects.includes(params.get('subject')) ? params.get('subject') : subjects[0],
    task: params.get('task'),
    from: params.get('from'),
    fromAttempt: params.get('fromAttempt') ?? '1',
    to: params.get('to'),
    toAttempt: params.get('toAttempt') ?? '1',
    artifact: params.get('artifact') ?? 'agent/proposed.diff',
    view: params.get('view') === 'inline' ? 'inline' : 'side-by-side',
  }
  const update = async (change) => {
    Object.assign(state, change)
    const records = index.records.filter(record => record.subject.id === state.subject)
    const tasks = [...new Set(records.flatMap(record => record.suite.tasks.map(task => task.id)))].sort()
    if (!tasks.includes(state.task)) state.task = tasks[0]
    const holding = records.filter(record => record.suite.tasks.some(task => task.id === state.task))
    // `range=latest`, or a missing side, selects the two newest records of the subject.
    if (params.get('range') === 'latest' || !holding.some(record => record.id === state.to)) state.to = holding[0]?.id
    if (params.get('range') === 'latest' || !holding.some(record => record.id === state.from)) state.from = holding[1]?.id ?? holding[0]?.id
    params.delete('range')
    const [from, to] = await Promise.all([loadRecord(state.from), loadRecord(state.to)])
    const attemptsOf = record => record.attempts.filter(attempt => attempt.task === state.task).map(attempt => [String(attempt.attempt), String(attempt.attempt)])
    const artifacts = [...new Set([from, to].flatMap(record => record.attempts.filter(attempt => attempt.task === state.task).flatMap(attempt => Object.keys(attempt.artifacts))))].sort()
    if (!artifacts.includes(state.artifact)) state.artifact = artifacts[0] ?? state.artifact
    const options = holding.map(record => [record.id, `${short(record.producer.commit)} · ${day(record.createdAt)}`])
    select('subject', subjects.map(id => [id, id]), state.subject, value => update({ subject: value }).catch(fail))
    select('task', tasks.map(id => [id, id]), state.task, value => update({ task: value }).catch(fail))
    select('artifact', artifacts.map(name => [name, name]), state.artifact, value => update({ artifact: value }).catch(fail))
    select('view', [['side-by-side', 'side by side'], ['inline', 'inline']], state.view, value => update({ view: value }).catch(fail))
    select('from', options, state.from, value => update({ from: value }).catch(fail))
    select('to', options, state.to, value => update({ to: value }).catch(fail))
    select('fromAttempt', attemptsOf(from), state.fromAttempt, value => update({ fromAttempt: value }).catch(fail))
    select('toAttempt', attemptsOf(to), state.toAttempt, value => update({ toAttempt: value }).catch(fail))
    await render(state)
  }
  await update({})
} catch (error) {
  fail(error)
}
