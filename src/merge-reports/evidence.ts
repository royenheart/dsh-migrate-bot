import { z } from 'zod'
import { parsePatchReport, type PatchReport } from '../github/patch-reports.ts'
import { runManifestSchema } from '../observability/manifest.ts'
import { slugOf, type GitHubClient, type Repository } from '../github/client.ts'
import type { MigrationContext } from '../workflow/machine.ts'

/** The migration a report is about. */
export interface ReportedMigration {
  id: string
  context: MigrationContext
}

/**
 * What a report session reasons over, collected when the report is due.
 *
 * Every piece comes from the state branch or the GitHub API, never from the
 * job's disk: the job that ran the migration is gone by the time its proposal
 * is merged.
 */

export interface AuthoredComment {
  source: 'issue' | 'pull request' | 'review'
  author: string
  createdAt: string
  path?: string | undefined
  body: string
}

export interface ChangedFile {
  filename: string
  status: string
  additions: number
  deletions: number
}

export interface Evidence {
  plugin: string
  from?: string | undefined
  to: string
  pullRequest: {
    number: number
    url: string
    title: string
    body: string
    merged: boolean
    mergedAt?: string | undefined
    mergedBy?: string | undefined
  }
  /** The Action release that produced the migration, when its package manifest was readable. */
  actionVersion?: string | undefined
  /** The model route the migration's sessions used. */
  model: { provider: string; model: string; thinking: string; reasoningEffort: string }
  issueUrl: string
  comments: AuthoredComment[]
  /** What changed on the proposal branch after this Action last pushed it. */
  maintainerChanges: { known: true; files: ChangedFile[] } | { known: false; note: string }
  /** The check lines the proposal body reported. */
  checks: string[]
  warnings: string[]
  reports: { overlap?: string | undefined; extensionPoints?: string | undefined; repairs: string[] }
  patchReports: PatchReport[]
  /** Existing upstream threads found for each discussion draft. */
  candidates: Array<{ url: string; title: string }>
  /** What the runs' manifests recorded about agent work, when they exist. */
  metrics?: RunMetrics | undefined
}

export interface RunMetrics {
  runs: number
  sessions: number
  turns: number
  steps: number
  toolCalls: number
  elapsedSeconds: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  usd?: number | undefined
}

/** What the state branch holds for one migration. */
export interface MigrationFiles {
  list(directory: string): string[]
  readFile(path: string): string | undefined
}

const login = z.object({ login: z.string() }).nullable().optional()
const pullSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merged_by: login,
  head: z.object({ sha: z.string() }),
})
const commentSchema = z.object({
  body: z.string().nullable().optional(),
  user: login,
  created_at: z.string().optional(),
  submitted_at: z.string().nullable().optional(),
  path: z.string().optional(),
})
const changedFileSchema = z.object({ filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number() })
const compareSchema = z.object({ files: z.array(changedFileSchema).optional() })
const searchSchema = z.object({ items: z.array(z.object({ html_url: z.string(), title: z.string() })) })
const discussionSearchSchema = z.object({
  search: z.object({ nodes: z.array(z.object({ url: z.string().optional(), title: z.string().optional() }).nullable()) }),
})

const HARNESS_REPOSITORY = 'deepseek-ai/deepseek-harness'

export async function collectEvidence(input: {
  github: GitHubClient
  repository: Repository
  migration: ReportedMigration
  files: MigrationFiles
  /** The Action release that produced the migration. */
  actionVersion?: string | undefined
  /** The model route the migration's sessions used. */
  model: { provider: string; model: string; thinking: string; reasoningEffort: string }
  /** Search upstream for threads that may already cover a discussion draft. */
  searchCandidates: boolean
}): Promise<Evidence> {
  const { github, repository, migration } = input
  const proposal = migration.context.proposal
  if (proposal === undefined) throw new Error(`migration ${migration.id} has no proposal`)
  const repo = slugOf(repository)
  const pull = await github.rest('GET', `/repos/${repo}/pulls/${String(proposal.pullRequest.number)}`, pullSchema)

  const comments: AuthoredComment[] = []
  const collect = async (path: string, source: AuthoredComment['source']): Promise<void> => {
    for (const comment of await github.paginate(path, commentSchema)) {
      const author = comment.user?.login ?? 'unknown'
      if (author.endsWith('[bot]') || comment.body === undefined || comment.body === null || comment.body.trim() === '') continue
      comments.push({
        source,
        author,
        createdAt: comment.created_at ?? comment.submitted_at ?? '',
        ...(comment.path === undefined ? {} : { path: comment.path }),
        body: comment.body,
      })
    }
  }
  await collect(`/repos/${repo}/issues/${String(proposal.issue.number)}/comments`, 'issue')
  await collect(`/repos/${repo}/issues/${String(proposal.pullRequest.number)}/comments`, 'pull request')
  await collect(`/repos/${repo}/pulls/${String(proposal.pullRequest.number)}/reviews`, 'review')
  await collect(`/repos/${repo}/pulls/${String(proposal.pullRequest.number)}/comments`, 'review')
  comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  let maintainerChanges: Evidence['maintainerChanges']
  if (pull.head.sha === proposal.headSha) {
    maintainerChanges = { known: true, files: [] }
  } else {
    try {
      const compared = await github.rest('GET', `/repos/${repo}/compare/${proposal.headSha}...${pull.head.sha}`, compareSchema)
      maintainerChanges = { known: true, files: (compared.files ?? []).sort((a, b) => a.filename.localeCompare(b.filename)) }
    } catch (compareError) {
      // A squash or rebase merge can rewrite the proposal head; a branch that
      // is deleted before this runs can then make the compare unreachable. The
      // pull request's stored file list survives both, so the report keeps its
      // changed-file table.
      try {
        const files = await github.paginate(`/repos/${repo}/pulls/${String(proposal.pullRequest.number)}/files`, changedFileSchema)
        maintainerChanges = { known: true, files: [...files].sort((a, b) => a.filename.localeCompare(b.filename)) }
      } catch (filesError) {
        maintainerChanges = {
          known: false,
          note: `${compareError instanceof Error ? compareError.message : String(compareError)}; ${filesError instanceof Error ? filesError.message : String(filesError)}`,
        }
      }
    }
  }

  const read = (name: string): string | undefined => input.files.readFile(`migrations/${migration.id}/${name}`)
  const repairs: string[] = []
  for (let attempt = 1; attempt <= migration.context.attempts; attempt += 1) {
    const report = read(`reports/repair-${String(attempt)}.md`)
    if (report !== undefined) repairs.push(report)
  }
  const patchReports = input.files.list(`migrations/${migration.id}/patch-reports`)
    .flatMap((path) => {
      const slug = path.split('/').at(-1)?.replace(/\.md$/, '') ?? ''
      const report = parsePatchReport(slug, input.files.readFile(path) ?? '')
      return report === undefined ? [] : [report]
    })

  const metrics: RunMetrics = {
    runs: 0,
    sessions: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    elapsedSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
  }
  const usd: number[] = []
  for (const path of input.files.list(`migrations/${migration.id}/runs`)) {
    if (!path.endsWith('/manifest.json')) continue
    const text = input.files.readFile(path)
    if (text === undefined) continue
    let parsed
    try {
      parsed = runManifestSchema.safeParse(JSON.parse(text))
    } catch {
      continue
    }
    if (!parsed.success) continue
    const totals = parsed.data.totals
    metrics.runs += 1
    metrics.sessions += totals.sessions
    metrics.turns += totals.turns
    metrics.steps += totals.steps
    metrics.toolCalls += totals.toolCalls
    metrics.elapsedSeconds += totals.elapsedSeconds
    metrics.inputTokens += totals.inputTokens
    metrics.outputTokens += totals.outputTokens
    metrics.cacheHitTokens += totals.cacheHitTokens
    if (totals.usd !== undefined) usd.push(totals.usd)
  }
  if (usd.length > 0) metrics.usd = usd.reduce((sum, value) => sum + value, 0)

  const candidates: Evidence['candidates'] = []
  if (input.searchCandidates) {
    for (const draft of patchReports.filter(report => report.kind === 'draft')) {
      candidates.push(...await searchUpstream(github, draft.title))
    }
  }

  return {
    plugin: repo,
    ...(migration.context.input.source === undefined ? {} : { from: migration.context.input.source.release.tag }),
    to: migration.context.input.target.tag,
    pullRequest: {
      number: pull.number,
      url: pull.html_url,
      title: pull.title,
      body: pull.body ?? '',
      merged: pull.merged === true,
      ...(pull.merged_at === null || pull.merged_at === undefined ? {} : { mergedAt: pull.merged_at }),
      ...(pull.merged_by?.login === undefined ? {} : { mergedBy: pull.merged_by.login }),
    },
    issueUrl: proposal.issue.url,
    ...(input.actionVersion === undefined ? {} : { actionVersion: input.actionVersion }),
    model: input.model,
    comments,
    maintainerChanges,
    checks: proposalChecks(pull.body ?? ''),
    warnings: migration.context.warnings,
    reports: {
      overlap: read('reports/overlap.md'),
      extensionPoints: read('reports/extension-points.md'),
      repairs,
    },
    patchReports,
    candidates,
    ...(metrics.runs === 0 ? {} : { metrics }),
  }
}

/** The check lines under the proposal body's `## Checks` heading. */
function proposalChecks(body: string): string[] {
  const checks: string[] = []
  let inside = false
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '## Checks') {
      inside = true
      continue
    }
    if (inside && line.startsWith('## ')) break
    if (inside && line.startsWith('- ')) {
      const check = line.slice(2).trim()
      if (check !== '') checks.push(check)
    }
  }
  return checks.slice(0, 20)
}

/** Issues, pull requests and discussions upstream whose text matches a draft title. */
async function searchUpstream(github: GitHubClient, title: string): Promise<Array<{ url: string; title: string }>> {
  const terms = title.replace(/^\[Feature request\]\s*/i, '').replaceAll('"', '')
  const query = `repo:${HARNESS_REPOSITORY} ${terms}`
  const found: Array<{ url: string; title: string }> = []
  const issues = await github.rest('GET', `/search/issues?per_page=10&q=${encodeURIComponent(query)}`, searchSchema)
  found.push(...issues.items.map(item => ({ url: item.html_url, title: item.title })))
  const discussions = await github.graphql(
    'query ($query: String!) { search(query: $query, type: DISCUSSION, first: 10) { nodes { ... on Discussion { url title } } } }',
    { query },
    discussionSearchSchema,
  )
  for (const node of discussions.search.nodes) {
    if (node?.url !== undefined && node.title !== undefined) found.push({ url: node.url, title: node.title })
  }
  return found
}
