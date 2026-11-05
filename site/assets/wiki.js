import { escape, nav } from './common.js'

nav('Wiki')

const $ = id => document.getElementById(id)
const REPOSITORY = 'https://github.com/royenheart/dsh-migrate-bot/blob/main'
let pages = []
let routes = new Map()
const cache = new Map()
let currentPage

function pageRoute(source) {
  const filter = new URLSearchParams(location.search).get('filter')
  return `?page=${encodeURIComponent(source)}${filter === null || filter === '' ? '' : `&filter=${encodeURIComponent(filter)}`}`
}

function slug(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')
}

function addHeadingIds(content) {
  const seen = new Map()
  for (const heading of content.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = slug(heading.textContent ?? '')
    let bump = seen.get(base) ?? 0
    let candidate = base
    while (content.querySelector(`#${CSS.escape(candidate)}`) !== null && heading.id !== candidate) {
      bump += 1
      candidate = `${base}-${bump}`
    }
    seen.set(base, bump)
    heading.id = candidate
  }
}

function wrapTables(content) {
  for (const table of content.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    table.replaceWith(wrap)
    wrap.append(table)
  }
}

function renderDiagrams(content) {
  const blocks = [...content.querySelectorAll('pre > code.language-mermaid')]
  if (blocks.length === 0 || globalThis.mermaid === undefined) return
  globalThis.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
  const nodes = blocks.map((code) => {
    const graph = document.createElement('div')
    graph.className = 'mermaid'
    graph.textContent = code.textContent ?? ''
    code.parentElement?.replaceWith(graph)
    return graph
  })
  void globalThis.mermaid.run({ nodes }).catch(() => {})
}

function rewriteLinks(page) {
  for (const link of $('wiki-content').querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('?')) {
      const route = new URL(href, location.href)
      const filter = new URLSearchParams(location.search).get('filter')
      if (filter === null || filter === '') route.searchParams.delete('filter')
      else route.searchParams.set('filter', filter)
      link.setAttribute('href', `${route.search}${route.hash}`)
      continue
    }
    if (href === '' || href.startsWith('#') || /^[a-z]+:/i.test(href) || href.startsWith('//')) continue
    const base = new URL(`https://wiki.invalid/${page.source}`)
    const target = new URL(href, base)
    const path = decodeURIComponent(target.pathname.replace(/^\/+/, ''))
    const route = routes.get(path)
    link.href = route === undefined ? `${REPOSITORY}/${path}${target.hash}` : `${pageRoute(route)}${target.hash}`
  }
}

async function showPage(source) {
  const metadata = pages.find(candidate => candidate.source === source) ?? pages[0]
  if (metadata === undefined) return
  let page = cache.get(metadata.source)
  if (page === undefined) {
    const file = `data/wiki-pages/${metadata.source.replaceAll('/', '__')}.json`
    const response = await fetch(file, { cache: 'no-store' })
    if (!response.ok) throw new Error(`${file}: HTTP ${String(response.status)}`)
    page = await response.json()
    cache.set(page.source, page)
  }
  currentPage = page
  const selected = page.source
  $('wiki-content').innerHTML = globalThis.marked.parse(page.markdown, { gfm: true, breaks: false })
  addHeadingIds($('wiki-content'))
  wrapTables($('wiki-content'))
  renderDiagrams($('wiki-content'))
  rewriteLinks(page)
  for (const link of document.querySelectorAll('#wiki-nav a[data-source]')) {
    const active = link.dataset.source === selected
    link.classList.toggle('active', active)
    link.setAttribute('aria-current', active ? 'page' : 'false')
  }
  document.title = `${page.title} · dsh-migrate wiki`
  const hash = decodeURIComponent(location.hash.slice(1))
  if (hash !== '') requestAnimationFrame(() => contentById(hash)?.scrollIntoView())
}

function contentById(id) {
  return document.getElementById(id)
}

function renderNav() {
  const filter = $('wiki-filter').value.trim().toLowerCase()
  const groups = new Map()
  for (const page of pages) {
    if (filter !== '' && !`${page.title} ${page.source}`.toLowerCase().includes(filter)) continue
    const list = groups.get(page.group) ?? []
    list.push(page)
    groups.set(page.group, list)
  }
  $('wiki-nav').innerHTML = [...groups].map(([group, entries]) => `<section><h2>${escape(group)}</h2>${entries.map(page => `<a href="${pageRoute(page.source)}" data-source="${escape(page.source)}">${escape(page.title)}</a>`).join('')}</section>`).join('') || '<p class="muted">No document matches.</p>'
  for (const link of document.querySelectorAll('#wiki-nav a[data-source]')) {
    const active = link.dataset.source === (pages.find(page => page.source === (new URLSearchParams(location.search).get('page') ?? 'README.md'))?.source)
    link.classList.toggle('active', active)
    link.setAttribute('aria-current', active ? 'page' : 'false')
  }
}

try {
  const response = await fetch('data/wiki.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`data/wiki.json: HTTP ${String(response.status)}`)
  const data = await response.json()
  if (!Array.isArray(data.pages) || data.pages.length === 0) throw new Error('the wiki projection is empty')
  pages = data.pages
  routes = new Map(pages.map(page => [page.source, page.source]))
  $('wiki-filter').value = new URLSearchParams(location.search).get('filter') ?? ''
  renderNav()
  const requested = new URLSearchParams(location.search).get('page')
  await showPage(requested !== null && routes.has(requested) ? requested : 'README.md')
  $('wiki-filter').addEventListener('input', () => {
    const url = new URL(location.href)
    const value = $('wiki-filter').value.trim()
    if (value === '') url.searchParams.delete('filter')
    else url.searchParams.set('filter', value)
    history.replaceState(null, '', url)
    renderNav()
    const selected = new URLSearchParams(location.search).get('page')
    if (currentPage !== undefined) rewriteLinks(currentPage)
  })
} catch (error) {
  $('wiki-content').innerHTML = `<p class="warning">${escape(error instanceof Error ? error.message : String(error))}</p>`
}
