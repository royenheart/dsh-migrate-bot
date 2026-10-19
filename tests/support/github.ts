/**
 * An in-memory GitHub REST and GraphQL API for one repository, served through a
 * `fetch` function. It implements only the endpoints this Action calls, with the
 * fields it reads, and records every request.
 */

export interface FakeIssue {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  comments: Array<{ body: string; user: string; created_at: string }>
}

export interface FakePull {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  merged: boolean
  head: { ref: string; sha: string }
  base: string
  commits: Array<{ login: string; email: string }>
  reviews: Array<{ body: string; user: string; submitted_at: string }>
}

export class FakeGitHub {
  readonly requests: Array<{ method: string; path: string; body?: unknown }> = []
  readonly issues = new Map<number, FakeIssue>()
  readonly pulls = new Map<number, FakePull>()
  /** Issues created in other repositories (report channels), by `owner/name`. */
  readonly external: Array<{ repo: string; title: string; body: string; labels: string[] }> = []
  readonly discussions: Array<{ title: string; body: string }> = []
  /** Files changed between two commits, by `base...head`. */
  readonly comparisons = new Map<string, Array<{ filename: string; status: string; additions: number; deletions: number }>>()
  searchResults: Array<{ html_url: string; title: string }> = []
  private next = 1

  constructor(readonly repo = 'acme/plugin') {}

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = input instanceof Request ? input.method : init?.method ?? 'GET'
    const text = input instanceof Request ? await input.text() : typeof init?.body === 'string' ? init.body : ''
    const body: unknown = text === '' ? undefined : JSON.parse(text)
    this.requests.push({ method, path: `${url.pathname}${url.search}`, ...(body === undefined ? {} : { body }) })
    return this.route(method, url, body as Record<string, unknown> | undefined)
  }

  private json(status: number, value: unknown): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  }

  private issueJson(issue: FakeIssue): unknown {
    return { number: issue.number, html_url: `https://github.com/${this.repo}/issues/${String(issue.number)}`, title: issue.title, body: issue.body, state: issue.state, user: { type: 'Bot' } }
  }

  private pullJson(pull: FakePull): unknown {
    return {
      number: pull.number,
      html_url: `https://github.com/${this.repo}/pull/${String(pull.number)}`,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.merged ? '2026-10-10T01:00:00Z' : null,
      merged_by: pull.merged ? { login: 'maintainer' } : null,
      head: { ref: pull.head.ref, sha: pull.head.sha, repo: { full_name: this.repo } },
    }
  }

  addPull(pull: Partial<FakePull> & { head: FakePull['head'] }): FakePull {
    const number = pull.number ?? this.next++
    const full: FakePull = { number, title: '', body: '', state: 'open', merged: false, base: 'main', commits: [], reviews: [], ...pull }
    this.pulls.set(number, full)
    this.next = Math.max(this.next, number + 1)
    return full
  }

  addIssue(issue: Partial<FakeIssue>): FakeIssue {
    const number = issue.number ?? this.next++
    const full: FakeIssue = { number, title: '', body: '', state: 'open', labels: [], comments: [], ...issue }
    this.issues.set(number, full)
    this.next = Math.max(this.next, number + 1)
    return full
  }

  private route(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    const own = `/repos/${this.repo}`
    const path = url.pathname
    const parts = path.split('/')
    if (path === '/graphql') return this.graphql(body)
    if (path === '/search/issues') return this.json(200, { items: this.searchResults })
    if (!path.startsWith(own)) {
      if (method === 'POST' && parts[4] === 'issues' && parts.length === 5) {
        this.external.push({ repo: `${parts[2] ?? ''}/${parts[3] ?? ''}`, title: String(body?.title), body: String(body?.body), labels: (body?.labels as string[] | undefined) ?? [] })
        return this.json(201, { html_url: `https://github.com/${parts[2] ?? ''}/${parts[3] ?? ''}/issues/${String(this.external.length)}` })
      }
      return this.json(404, { message: 'Not Found' })
    }
    const rest = path.slice(own.length)
    const segments = rest.split('/').filter(Boolean)
    const [collection, id, sub] = segments
    const number = id === undefined ? undefined : Number(id)

    if (collection === 'issues' && number === undefined) {
      if (method === 'GET') {
        const open = [...this.issues.values()].filter(issue => url.searchParams.get('state') !== 'open' || issue.state === 'open')
        return this.json(200, open.map(issue => this.issueJson(issue)))
      }
      const created = this.addIssue({ title: String(body?.title), body: String(body?.body), labels: (body?.labels as string[] | undefined) ?? [] })
      return this.json(201, this.issueJson(created))
    }
    if (collection === 'issues' && number !== undefined) {
      const issue = this.issues.get(number)
      if (sub === 'comments') {
        const comments = issue?.comments ?? this.pulls.get(number)?.reviews.map(review => ({ body: review.body, user: review.user, created_at: review.submitted_at })) ?? []
        if (method === 'GET') return this.json(200, comments.map(comment => ({ body: comment.body, user: { login: comment.user }, created_at: comment.created_at })))
        const target = issue ?? this.addIssue({ number })
        target.comments.push({ body: String(body?.body), user: 'github-actions[bot]', created_at: '2026-10-10T00:00:00Z' })
        return this.json(201, {})
      }
      if (issue === undefined) return this.json(404, { message: 'Not Found' })
      if (method === 'PATCH') Object.assign(issue, { title: body?.title ?? issue.title, body: body?.body ?? issue.body, state: body?.state ?? issue.state })
      return this.json(200, this.issueJson(issue))
    }
    if (collection === 'pulls' && number === undefined) {
      if (method === 'GET') {
        const head = url.searchParams.get('head')
        const pulls = [...this.pulls.values()].filter(pull => pull.state === 'open' && (head === null || head === `${this.repo.split('/')[0] ?? ''}:${pull.head.ref}`))
        return this.json(200, pulls.map(pull => this.pullJson(pull)))
      }
      const created = this.addPull({ title: String(body?.title), body: String(body?.body), head: { ref: String(body?.head), sha: 'f'.repeat(40) }, base: String(body?.base) })
      return this.json(201, this.pullJson(created))
    }
    if (collection === 'pulls' && number !== undefined) {
      const pull = this.pulls.get(number)
      if (pull === undefined) return this.json(404, { message: 'Not Found' })
      if (sub === 'commits') return this.json(200, pull.commits.map(commit => ({ author: { login: commit.login }, commit: { author: { email: commit.email } } })))
      if (sub === 'reviews') return this.json(200, pull.reviews.map(review => ({ body: review.body, user: { login: review.user }, submitted_at: review.submitted_at })))
      if (sub === 'comments') return this.json(200, [])
      if (method === 'PATCH') Object.assign(pull, { title: body?.title ?? pull.title, body: body?.body ?? pull.body, state: body?.state ?? pull.state })
      return this.json(200, this.pullJson(pull))
    }
    if (collection === 'compare' && id !== undefined) {
      return this.json(200, { files: this.comparisons.get(segments.slice(1).join('/')) ?? [] })
    }
    return this.json(404, { message: `no route for ${method} ${path}` })
  }

  private graphql(body: Record<string, unknown> | undefined): Response {
    const query = String(body?.query ?? '')
    const variables = (body?.variables ?? {}) as Record<string, unknown>
    if (query.includes('search(')) return this.json(200, { data: { search: { nodes: [] } } })
    if (query.includes('discussionCategories')) {
      return this.json(200, { data: { repository: { id: 'R_1', discussionCategories: { nodes: [{ id: 'C_ideas', slug: 'ideas' }] } } } })
    }
    if (query.includes('createDiscussion')) {
      this.discussions.push({ title: String(variables.title), body: String(variables.body) })
      return this.json(200, { data: { createDiscussion: { discussion: { url: `https://github.com/deepseek-ai/deepseek-harness/discussions/${String(this.discussions.length)}` } } } })
    }
    return this.json(200, { errors: [{ message: 'unknown query' }] })
  }
}
