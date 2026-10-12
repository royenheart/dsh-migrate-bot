// Shared by every page: the data the site build wrote, URL state, and formatting.

export const params = new URLSearchParams(location.search)

/** Replace the query string without reloading, so the page state is a link. */
export function setParams(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') params.delete(key)
    else params.set(key, String(value))
  }
  history.replaceState(null, '', `${location.pathname}?${params}`)
}

async function json(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

/** One line per record, newest first. */
export const loadIndex = () => json('data/index.json')
const records = new Map()
export function loadRecord(id) {
  if (!records.has(id)) records.set(id, json(`data/records/${encodeURIComponent(id)}/record.json`))
  return records.get(id)
}
export async function loadArtifact(id, path) {
  const response = await fetch(`data/records/${encodeURIComponent(id)}/${path}`)
  return response.ok ? response.text() : ''
}
export const loadField = () => json('data/field.json')

export function nav(current) {
  const pages = [['index.html', 'Trend'], ['compare.html', 'Compare'], ['changes.html', 'Changes'], ['task.html', 'Task'], ['diff.html', 'Diff'], ['field.html', 'Field']]
  const header = document.createElement('header')
  header.innerHTML = `<strong>dsh-migrate benchmark</strong>${pages.map(([href, label]) => `<a href="${href}"${label === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}`
  document.body.prepend(header)
}

export const fmt = (value, digits = 3) => value === null || value === undefined ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(digits)
export const interval = pair => pair === undefined ? '' : ` <span class="muted">[${fmt(pair[0])}, ${fmt(pair[1])}]</span>`
export const short = sha => sha.slice(0, 12)
export const day = iso => iso.slice(0, 16).replace('T', ' ')
export const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** A coloured chip for one attempt, linking to its diff. */
export function chip(attempt, href) {
  const kind = attempt.outcome === 'infrastructure' ? 'infra' : attempt.reward === 1 ? 'pass' : (attempt.reward ?? 0) > 0 ? 'part' : 'fail'
  const label = attempt.outcome === 'scored' ? fmt(attempt.reward, 2) : attempt.outcome.slice(0, 4)
  const title = `attempt ${attempt.attempt}: ${attempt.outcome}${attempt.exception ? ` (${attempt.exception})` : ''}`
  return `<a class="chip ${kind}" href="${href}" title="${escape(title)}">${label}</a>`
}

export function diffHref({ subject, task, from, fromAttempt, to, toAttempt, artifact = 'agent/proposed.diff' }) {
  const query = new URLSearchParams({ subject, task, from, fromAttempt, to, toAttempt, artifact })
  return `diff.html?${query}`
}

export function select(id, options, value, onChange) {
  const element = document.getElementById(id)
  element.innerHTML = options.map(([key, label]) => `<option value="${escape(key)}"${key === value ? ' selected' : ''}>${escape(label)}</option>`).join('')
  element.onchange = () => onChange(element.value)
  return element
}

export function fail(error) {
  document.querySelector('main').insertAdjacentHTML('beforeend', `<p class="warning">${escape(error.message)}</p>`)
}
