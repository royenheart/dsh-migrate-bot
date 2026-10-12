import { z } from 'zod'
import { inline } from '../render/text.ts'

/**
 * The GitHub API, as this Action uses it.
 *
 * Three primitives: one REST call, one paginated REST list, and one GraphQL
 * query. Each validates the part of the answer its caller reads against a zod
 * schema, so a response that changed shape fails where it is read rather than
 * further down as an `undefined`.
 */

export class GitHubError extends Error {
  override readonly name = 'GitHubError'
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** The most pages one paginated read follows. */
const MAX_PAGES = 10

export interface Repository {
  owner: string
  name: string
}

export function repositoryOf(slug: string): Repository {
  const [owner, name, extra] = slug.split('/')
  if (owner === undefined || name === undefined || extra !== undefined || owner === '' || name === '') {
    throw new Error(`expected "owner/name", got: ${slug}`)
  }
  return { owner, name }
}

export function slugOf(repository: Repository): string {
  return `${repository.owner}/${repository.name}`
}

export class GitHubClient {
  private readonly base: string
  private readonly graphqlUrl: string

  constructor(
    private readonly token: string,
    env: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const configured = env.GITHUB_API_URL
    this.base = configured === undefined || configured === '' ? 'https://api.github.com' : configured.replace(/\/+$/, '')
    const graphql = env.GITHUB_GRAPHQL_URL
    this.graphqlUrl = graphql === undefined || graphql === '' ? `${this.base}/graphql` : graphql
  }

  private async send(method: string, url: string, body?: unknown): Promise<{ status: number; text: string; link: string | null }> {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'dsh-migrate',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, text: await response.text(), link: response.headers.get('link') }
  }

  /**
   * One REST call.
   * @param method - HTTP method.
   * @param path - path below the API root, starting with `/`.
   * @param schema - the shape of the answer the caller reads.
   * @param body - JSON body, for a write.
   */
  async rest<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const answer = await this.send(method, `${this.base}${path}`, body)
    if (answer.status < 200 || answer.status >= 300) {
      throw new GitHubError(`GitHub ${method} ${path} failed: ${String(answer.status)} ${inline(answer.text, 300)}`, answer.status)
    }
    return parse(schema, answer.text === '' ? {} : JSON.parse(answer.text), `${method} ${path}`)
  }

  /**
   * A REST list, following `Link: rel="next"` up to {@link MAX_PAGES} pages.
   * @param path - path below the API root; `per_page=100` is added.
   * @param item - the shape of one element.
   */
  async paginate<T>(path: string, item: z.ZodType<T>): Promise<T[]> {
    const items: T[] = []
    let url: string | undefined = `${this.base}${path}${path.includes('?') ? '&' : '?'}per_page=100`
    for (let page = 0; url !== undefined && page < MAX_PAGES; page += 1) {
      const answer = await this.send('GET', url)
      if (answer.status !== 200) {
        throw new GitHubError(`GitHub GET ${path} failed: ${String(answer.status)} ${inline(answer.text, 300)}`, answer.status)
      }
      items.push(...parse(z.array(item), JSON.parse(answer.text), `GET ${path}`))
      url = nextLink(answer.link)
    }
    return items
  }

  /**
   * One GraphQL query or mutation.
   * @param query - the document.
   * @param variables - its variables.
   * @param schema - the shape of `data` the caller reads.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const answer = await this.send('POST', this.graphqlUrl, { query, variables })
    if (answer.status !== 200) {
      throw new GitHubError(`GitHub GraphQL failed: ${String(answer.status)} ${inline(answer.text, 300)}`, answer.status)
    }
    const parsed = parse(z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }), JSON.parse(answer.text), 'GraphQL')
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
      throw new GitHubError(`GitHub GraphQL returned errors: ${inline(JSON.stringify(parsed.errors), 300)}`, 200)
    }
    return parse(schema, parsed.data, 'GraphQL data')
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new GitHubError(`GitHub ${what} answered an unexpected shape: ${inline(z.prettifyError(parsed.error), 300)}`, 200)
  return parsed.data
}

/** The `rel="next"` URL of a `Link` header. */
function nextLink(header: string | null): string | undefined {
  for (const part of header?.split(',') ?? []) {
    const [target, ...params] = part.split(';').map(piece => piece.trim())
    if (params.includes('rel="next"') && target?.startsWith('<') && target.endsWith('>')) return target.slice(1, -1)
  }
  return undefined
}
