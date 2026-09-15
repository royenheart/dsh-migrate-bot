import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { githubGet } from '../github/api.ts'
import { collectPatchReports, type PatchReport } from '../github/patch-reports.ts'
import { parsePullRequestNumber, resolveRepo, type PullRequestDetail } from '../github/pr.ts'
import type { SeenState } from '../watch/seen.ts'
import type { AuthoredComment, ChangedFile, FeedbackEvidence } from './types.ts'

const BOT_LOGINS = new Set(['github-actions[bot]', 'dsh-migrate[bot]', 'github-actions'])
const CLOSES_ISSUE = /\b(?:closes|fixes|resolves)\s+#(\d+)/i

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function listOf(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const result = await githubGet(token, path, fetchImpl)
  if (!result.ok) throw new Error(`GitHub GET ${path} failed: ${String(result.status)} ${result.detail}`)
  return Array.isArray(result.body) ? result.body : []
}

/** Comments a human left on the migrate issue, the pull request, or its diff. */
export async function collectComments(input: {
  token: string
  owner: string
  repo: string
  pullRequest: number
  issue?: number | undefined
  fetchImpl: typeof fetch
}): Promise<AuthoredComment[]> {
  const comments: AuthoredComment[] = []
  const push = (item: unknown, source: AuthoredComment['source']): void => {
    const entry = record(item)
    if (entry === undefined) return
    const body = str(entry.body)
    if (body === undefined) return
    const user = record(entry.user)
    comments.push({
      source,
      author: str(user?.login) ?? 'unknown',
      createdAt: str(entry.created_at) ?? str(entry.submitted_at) ?? 'unknown',
      ...(str(entry.path) === undefined ? {} : { path: str(entry.path) as string }),
      body,
    })
  }

  if (input.issue !== undefined) {
    for (const item of await listOf(input.token, `/repos/${input.owner}/${input.repo}/issues/${String(input.issue)}/comments`, input.fetchImpl)) {
      push(item, 'issue')
    }
  }
  for (const item of await listOf(input.token, `/repos/${input.owner}/${input.repo}/issues/${String(input.pullRequest)}/comments`, input.fetchImpl)) {
    push(item, 'pull')
  }
  for (const item of await listOf(input.token, `/repos/${input.owner}/${input.repo}/pulls/${String(input.pullRequest)}/reviews`, input.fetchImpl)) {
    push(item, 'review')
  }
  for (const item of await listOf(input.token, `/repos/${input.owner}/${input.repo}/pulls/${String(input.pullRequest)}/comments`, input.fetchImpl)) {
    push(item, 'review')
  }
  return comments
    .filter(comment => comment.author !== 'github-actions[bot]')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * What the maintainer changed on the branch before merging.
 *
 * Commits the Action did not author are the maintainer's edits, and each one's
 * file list is the most specific defect signal a migration can produce: it is
 * the part of the run a human had to redo. When the branch carries no such
 * commit the merge took the tree as it was pushed, which is a result worth
 * reporting rather than an absence of one.
 * @param input.token - a token that can read the pull request.
 * @param input.pullRequest - the merged pull request.
 * @param input.fetchImpl - injectable fetch.
 */
export async function collectMaintainerChanges(input: {
  token: string
  owner: string
  repo: string
  pullRequest: number
  fetchImpl: typeof fetch
}): Promise<{ known: boolean; files: ChangedFile[]; note?: string }> {
  let commits: unknown[]
  try {
    commits = await listOf(
      input.token,
      `/repos/${input.owner}/${input.repo}/pulls/${String(input.pullRequest)}/commits?per_page=100`,
      input.fetchImpl,
    )
  } catch (error) {
    return {
      known: false,
      files: [],
      note: error instanceof Error ? error.message : String(error),
    }
  }
  const byFile = new Map<string, ChangedFile>()
  let sawMaintainerCommit = false
  for (const item of commits) {
    const commit = record(item)
    if (commit === undefined) continue
    const author = record(commit.author)
    const login = str(author?.login)
    if (login !== undefined && BOT_LOGINS.has(login)) continue
    sawMaintainerCommit = true
    const sha = str(commit.sha)
    if (sha === undefined) continue
    let detail: unknown
    try {
      const result = await githubGet(input.token, `/repos/${input.owner}/${input.repo}/commits/${sha}`, input.fetchImpl)
      if (!result.ok) continue
      detail = result.body
    } catch {
      continue
    }
    const files = record(detail)?.files
    if (!Array.isArray(files)) continue
    for (const file of files) {
      const entry = record(file)
      const filename = entry === undefined ? undefined : str(entry.filename)
      if (entry === undefined || filename === undefined) continue
      const previous = byFile.get(filename)
      byFile.set(filename, {
        filename,
        status: str(entry.status) ?? previous?.status ?? 'modified',
        additions: (typeof entry.additions === 'number' ? entry.additions : 0) + (previous?.additions ?? 0),
        deletions: (typeof entry.deletions === 'number' ? entry.deletions : 0) + (previous?.deletions ?? 0),
      })
    }
  }
  if (!sawMaintainerCommit) return { known: true, files: [] }
  return { known: true, files: [...byFile.values()].sort((a, b) => a.filename.localeCompare(b.filename)) }
}

/** The `Closes #N` reference the publisher writes into every migrate pull request. */
export function companionIssueNumber(body: string): number | undefined {
  const match = CLOSES_ISSUE.exec(body)
  const number = match?.[1]
  if (number === undefined) return undefined
  const parsed = Number(number)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Read the run's own artifacts back off disk.
 *
 * The reports are the Action's record of what it did, and a feedback session
 * cannot re-derive them: the container that wrote them is gone by the time the
 * pull request is merged.
 * @param workdir - the plugin repository root.
 * @param seen - recorded state, for the run directory of the pending migration.
 */
export function collectReports(workdir: string, seen: SeenState | undefined): FeedbackEvidence['reports'] {
  const patchReports: PatchReport[] = collectPatchReports(workdir)
  const runDir = latestRunDir(workdir)
  const reports: FeedbackEvidence['reports'] = { fixes: [], patchReports }
  if (runDir !== undefined) reports.runDir = runDir
  const read = (name: string): string | undefined => {
    if (runDir === undefined) return undefined
    const file = join(runDir, name)
    if (!existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8').trim()
    return text === '' ? undefined : text
  }
  const absorption = read('A.md')
  if (absorption !== undefined) reports.absorption = absorption
  const alignment = read('B.md')
  if (alignment !== undefined) reports.alignment = alignment
  const mechanical = read('mechanical.md')
  if (mechanical !== undefined) reports.mechanical = mechanical
  for (let index = 1; index < 100; index += 1) {
    const fix = read(`C${String(index)}.md`)
    if (fix === undefined) break
    reports.fixes.push(fix)
  }
  const target = seen?.pending ?? seen?.verified
  if (target !== undefined && reports.runDir === undefined) {
    const fallback = join(workdir, '.dsh-migrate', 'runs')
    if (existsSync(fallback)) reports.runDir = fallback
  }
  return reports
}

/**
 * The newest `.dsh-migrate/runs/<id>` directory, whose id starts with the tag.
 * @param workdir - the plugin repository root.
 */
function latestRunDir(workdir: string): string | undefined {
  const root = join(workdir, '.dsh-migrate', 'runs')
  if (!existsSync(root)) return undefined
  const entries = readdirSync(root).sort()
  const last = entries[entries.length - 1]
  return last === undefined ? undefined : join(root, last)
}

/**
 * The `from → to` corridor a migrated pull request crossed.
 * @param seen - recorded state as it was before the merge was reconciled.
 */
export function corridorOf(seen: SeenState | undefined): { from?: string; to?: string } {
  const to = (seen?.pending ?? seen?.verified)?.tag
  const from = seen?.verified?.tag
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  }
}

/**
 * Assemble everything a feedback session reasons over.
 * @param input - the resolved target, the merged pull request, and the reading token.
 */
export async function collectEvidence(input: {
  workdir: string
  seen: SeenState | undefined
  token: string
  pullRequest: PullRequestDetail
  fetchImpl: typeof fetch
}): Promise<FeedbackEvidence> {
  const { owner, repo } = resolveRepo(input.workdir)
  const issueNumber = companionIssueNumber(input.pullRequest.body)
  const comments = await collectComments({
    token: input.token,
    owner,
    repo,
    pullRequest: input.pullRequest.number,
    ...(issueNumber === undefined ? {} : { issue: issueNumber }),
    fetchImpl: input.fetchImpl,
  })
  const maintainerChanges = await collectMaintainerChanges({
    token: input.token,
    owner,
    repo,
    pullRequest: input.pullRequest.number,
    fetchImpl: input.fetchImpl,
  })
  const corridor = corridorOf(input.seen)
  const reports = collectReports(input.workdir, input.seen)
  const candidates = reports.patchReports
    .flatMap(report => report.links)
    .map(url => ({ url, title: url }))

  let issue: FeedbackEvidence['issue']
  if (issueNumber !== undefined) {
    const result = await githubGet(input.token, `/repos/${owner}/${repo}/issues/${String(issueNumber)}`, input.fetchImpl)
    if (result.ok) {
      const body = record(result.body)
      issue = {
        number: issueNumber,
        url: str(body?.html_url) ?? `https://github.com/${owner}/${repo}/issues/${String(issueNumber)}`,
        title: str(body?.title) ?? '',
        body: typeof body?.body === 'string' ? body.body : '',
      }
    }
  }

  return {
    plugin: { owner, repo, url: `https://github.com/${owner}/${repo}` },
    ...corridor,
    pullRequest: {
      number: input.pullRequest.number,
      url: input.pullRequest.url,
      title: input.pullRequest.title,
      body: input.pullRequest.body,
      state: input.pullRequest.state,
      ...(input.pullRequest.mergedAt === undefined ? {} : { mergedAt: input.pullRequest.mergedAt }),
      ...(input.pullRequest.mergedBy === undefined ? {} : { mergedBy: input.pullRequest.mergedBy }),
      ...(input.pullRequest.mergeCommitSha === undefined ? {} : { mergeCommitSha: input.pullRequest.mergeCommitSha }),
      ...(input.pullRequest.author === undefined ? {} : { author: input.pullRequest.author }),
    },
    ...(issue === undefined ? {} : { issue }),
    comments,
    maintainerChanges,
    reports,
    candidates,
  }
}

export { parsePullRequestNumber }
