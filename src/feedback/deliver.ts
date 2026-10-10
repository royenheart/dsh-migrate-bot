import { githubRequest } from '../github/api.ts'
import type { ReportMethod } from '../config/schema.ts'

/**
 * Where a channel's report goes.
 *
 * Two methods: `issue` over REST, and `discussion`, which has no public create
 * endpoint and needs GraphQL. None of them can use the workflow's
 * `GITHUB_TOKEN`: that token is minted for the plugin repository, and every
 * built-in channel writes somewhere else. The caller supplies the token, and a
 * missing one is a skip, never a failure.
 */

const GITHUB_GRAPHQL = 'https://api.github.com/graphql'

export interface DeliveryTarget {
  /** `owner/name`. */
  repo: string
  method: ReportMethod
  /** Issue labels, applied when the method creates an issue. */
  labels: readonly string[]
  /** Discussion category slug, used when the method creates a discussion. */
  category: string
}

export interface DeliveryPayload {
  title: string
  body: string
}

export interface DeliveryResult {
  url?: string | undefined
  detail: string
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/')
  if (owner === undefined || name === undefined || owner === '' || name === '') {
    throw new Error(`feedback target must be "owner/name", got: ${repo}`)
  }
  return { owner, name }
}

/** GraphQL call against api.github.com. */
async function githubGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'dsh-migrate-action',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub GraphQL failed: ${String(response.status)} ${text}`)
  }
  const parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  const errors = parsed.errors
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`GitHub GraphQL returned errors: ${JSON.stringify(errors)}`)
  }
  const data = parsed.data
  if (typeof data !== 'object' || data === null) throw new Error('GitHub GraphQL returned no data')
  return data as Record<string, unknown>
}

/**
 * Create an issue in the target repository.
 * @param input.token - a token that may write to `input.target.repo`.
 * @param input.target - where and how to deliver.
 * @param input.payload - the report.
 * @param input.fetchImpl - injectable fetch.
 */
export async function deliverIssue(
  input: {
    token: string
    target: DeliveryTarget
    payload: DeliveryPayload
    fetchImpl?: typeof fetch
  },
): Promise<DeliveryResult> {
  const { owner, name } = splitRepo(input.target.repo)
  const body: Record<string, unknown> = { title: input.payload.title, body: input.payload.body }
  if (input.target.labels.length > 0) body.labels = [...input.target.labels]
  const created = await githubRequest(
    input.token,
    'POST',
    `/repos/${owner}/${name}/issues`,
    body,
    input.fetchImpl ?? fetch,
  ) as { html_url?: unknown; number?: unknown }
  const url = typeof created.html_url === 'string' ? created.html_url : undefined
  const number = typeof created.number === 'number' ? created.number : undefined
  return {
    ...(url === undefined ? {} : { url }),
    detail: `issue ${number === undefined ? '(number unknown)' : `#${String(number)}`} created in ${input.target.repo}`,
  }
}

/**
 * Create a discussion in the target repository.
 *
 * The category is resolved by slug at delivery time because the id is opaque and
 * per repository; without a matching category this fails loudly rather than
 * posting into whatever category happens to be first.
 * @param input.token - a token that may write Discussions in `input.target.repo`.
 * @param input.target - where and how to deliver.
 * @param input.payload - the report.
 * @param input.fetchImpl - injectable fetch.
 */
export async function deliverDiscussion(
  input: {
    token: string
    target: DeliveryTarget
    payload: DeliveryPayload
    fetchImpl?: typeof fetch
  },
): Promise<DeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const { owner, name } = splitRepo(input.target.repo)
  const lookup = await githubGraphql(input.token, `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    discussionCategories(first: 25) { nodes { id name slug } }
  }
}`, { owner, name }, fetchImpl)
  const repository = lookup.repository
  if (typeof repository !== 'object' || repository === null) {
    throw new Error(`no repository ${input.target.repo} visible to this token`)
  }
  const repositoryId = (repository as { id?: unknown }).id
  if (typeof repositoryId !== 'string') throw new Error(`no repository id for ${input.target.repo}`)
  const categories = (repository as { discussionCategories?: { nodes?: unknown } }).discussionCategories?.nodes
  const nodes = Array.isArray(categories) ? categories : []
  const match = nodes.find((node) => {
    if (typeof node !== 'object' || node === null) return false
    return (node as { slug?: unknown }).slug === input.target.category
  }) as { id?: unknown } | undefined
  const categoryId = match?.id
  if (typeof categoryId !== 'string') {
    const slugs = nodes
      .map(node => (typeof node === 'object' && node !== null ? (node as { slug?: unknown }).slug : undefined))
      .filter((slug): slug is string => typeof slug === 'string')
    throw new Error(
      `no discussion category \`${input.target.category}\` in ${input.target.repo}`
      + (slugs.length === 0 ? '' : ` (available: ${slugs.join(', ')})`),
    )
  }
  const created = await githubGraphql(input.token, `mutation ($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
    discussion { url }
  }
}`, {
    repositoryId,
    categoryId,
    title: input.payload.title,
    body: input.payload.body,
  }, fetchImpl)
  const discussion = (created.createDiscussion as { discussion?: { url?: unknown } } | undefined)?.discussion
  const url = typeof discussion?.url === 'string' ? discussion.url : undefined
  return {
    ...(url === undefined ? {} : { url }),
    detail: `discussion created in ${input.target.repo} (${input.target.category})`,
  }
}

/**
 * Deliver one payload through the channel's method.
 * @param input.token - the channel's token.
 * @param input.target - where and how to deliver.
 * @param input.payload - the report.
 * @param input.fetchImpl - injectable fetch.
 */
export async function deliver(input: {
  token: string
  target: DeliveryTarget
  payload: DeliveryPayload
  fetchImpl?: typeof fetch
}): Promise<DeliveryResult> {
  const common = {
    token: input.token,
    target: input.target,
    payload: input.payload,
    fetchImpl: input.fetchImpl ?? fetch,
  }
  switch (input.target.method) {
    case 'issue':
      return await deliverIssue(common)
    case 'discussion':
      return await deliverDiscussion(common)
    default: {
      const exhaustive: never = input.target.method
      throw new Error(`unsupported feedback method: ${String(exhaustive)}`)
    }
  }
}
