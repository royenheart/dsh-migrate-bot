import { githubGet, githubRequest } from '../github/api.ts'
import type { FeedbackMethod } from '../config/schema.ts'

/**
 * Where a channel's report goes.
 *
 * Four methods, all of them plain REST except `discussion`, which has no public
 * create endpoint and needs GraphQL. None of them can use the workflow's
 * `GITHUB_TOKEN`: that token is minted for the plugin repository, and every
 * built-in channel writes somewhere else. The caller supplies the token, and a
 * missing one is a skip, never a failure.
 */

const GITHUB_GRAPHQL = 'https://api.github.com/graphql'

export interface DeliveryTarget {
  /** `owner/name`. */
  repo: string
  method: FeedbackMethod
  /** Issue labels, applied when the method creates an issue. */
  labels: readonly string[]
  /** Discussion category slug, used when the method creates a discussion. */
  category: string
  /** Channel id, used to build a branch name for pull delivery. */
  channel: string
}

export interface DeliveryPayload {
  title: string
  body: string
  files: ReadonlyArray<{ path: string; content: string }>
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
 * Open a pull request carrying files, on a fresh branch.
 *
 * Used only by a channel whose payload is files; the built-ins all deliver
 * issues or a discussion, because generating cards or registry entries for
 * another project is exactly what its rules forbid as a side effect of somebody
 * else's migration.
 * @param input.token - a token that may write to `input.target.repo`.
 * @param input.target - where and how to deliver.
 * @param input.payload - title, body, and the files to commit.
 * @param input.branch - branch to create; must not already exist.
 * @param input.fetchImpl - injectable fetch.
 */
export async function deliverPullRequest(
  input: {
    token: string
    target: DeliveryTarget
    payload: DeliveryPayload
    branch: string
    fetchImpl?: typeof fetch
  },
): Promise<DeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const { owner, name } = splitRepo(input.target.repo)
  if (input.payload.files.length === 0) {
    throw new Error('pull delivery needs at least one file')
  }
  const repoInfo = await githubGet(input.token, `/repos/${owner}/${name}`, fetchImpl)
  if (!repoInfo.ok) throw new Error(`cannot read ${input.target.repo}: ${String(repoInfo.status)}`)
  const defaultBranch = (repoInfo.body as { default_branch?: unknown }).default_branch
  const base = typeof defaultBranch === 'string' && defaultBranch !== '' ? defaultBranch : 'main'

  const headRef = await githubGet(input.token, `/repos/${owner}/${name}/git/ref/heads/${base}`, fetchImpl)
  if (!headRef.ok) throw new Error(`cannot read ${base} in ${input.target.repo}: ${String(headRef.status)}`)
  const sha = (headRef.body as { object?: { sha?: unknown } }).object?.sha
  if (typeof sha !== 'string') throw new Error(`no head sha for ${base} in ${input.target.repo}`)

  await githubRequest(
    input.token,
    'POST',
    `/repos/${owner}/${name}/git/refs`,
    { ref: `refs/heads/${input.branch}`, sha },
    fetchImpl,
  )

  for (const file of input.payload.files) {
    await githubRequest(input.token, 'PUT', `/repos/${owner}/${name}/contents/${file.path}`, {
      message: input.payload.title,
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      branch: input.branch,
    }, fetchImpl)
  }

  const pr = await githubRequest(input.token, 'POST', `/repos/${owner}/${name}/pulls`, {
    title: input.payload.title,
    body: input.payload.body,
    head: input.branch,
    base,
  }, fetchImpl) as { html_url?: unknown; number?: unknown }
  const url = typeof pr.html_url === 'string' ? pr.html_url : undefined
  const number = typeof pr.number === 'number' ? pr.number : undefined
  return {
    ...(url === undefined ? {} : { url }),
    detail: `pull request ${number === undefined ? '' : `#${String(number)} `}created in ${input.target.repo}`.trim(),
  }
}

/**
 * Deliver one payload through the channel's method.
 * @param input.token - the channel's token.
 * @param input.target - where and how to deliver.
 * @param input.payload - the report.
 * @param input.branch - branch name used by pull delivery.
 * @param input.fetchImpl - injectable fetch.
 */
export async function deliver(input: {
  token: string
  target: DeliveryTarget
  payload: DeliveryPayload
  branch: string
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
    case 'pull':
      return await deliverPullRequest({ ...common, branch: input.branch })
    case 'issue+pull': {
      const issue = await deliverIssue(common)
      const pr = await deliverPullRequest({
        ...common,
        payload: { ...input.payload, body: `${input.payload.body}\n\nRefs ${issue.url ?? ''}`.trim() },
        branch: input.branch,
      })
      return { ...pr, detail: `${issue.detail}; ${pr.detail}` }
    }
    default: {
      const exhaustive: never = input.target.method
      throw new Error(`unsupported feedback method: ${String(exhaustive)}`)
    }
  }
}
