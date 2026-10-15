import { z } from 'zod'
import { BOT_EMAIL, botEnv, gitOut } from '../git/run.ts'
import { stageChanges } from '../git/worktree.ts'
import { slugOf, type GitHubClient, type Repository } from '../github/client.ts'
import { formatOfficialDiscussionInvite } from '../github/discussions.ts'
import { collectPatchReports, formatPatchReportComment } from '../github/patch-reports.ts'
import { PROPOSAL_MARKER, type ProposalDocuments } from '../github/templates.ts'
import type { MigrationContext } from '../workflow/machine.ts'
import type { MigrationEvent, Proposal } from '../workflow/model.ts'

/**
 * Publish the proposal: one branch, one issue, one pull request per consumer.
 *
 * Every step finds what a previous attempt already created before creating
 * anything: the branch is force-pushed, the issue and the pull request are the
 * inherited ones or the open ones carrying the proposal marker, and the
 * patch-report comments carry a marker per migration. A job that is cancelled
 * after an effect and retried therefore repeats none.
 */

export const PROPOSAL_BRANCH = 'dsh-migrate/proposal'

const issueSchema = z.object({ number: z.number(), html_url: z.string(), body: z.string().nullable().optional(), pull_request: z.unknown().optional() })
const pullSchema = z.object({ number: z.number(), html_url: z.string() })
const commentSchema = z.object({ body: z.string().nullable().optional() })

export interface ProposalDeps {
  workdir: string
  github: GitHubClient
  repository: Repository
  defaultBranch: string
}

export async function publishProposal(
  deps: ProposalDeps,
  context: MigrationContext,
  documents: ProposalDocuments,
): Promise<{ event: MigrationEvent; files: Map<string, string> }> {
  const repo = slugOf(deps.repository)
  const { workdir } = deps

  gitOut(['checkout', '-B', PROPOSAL_BRANCH], { cwd: workdir })
  stageChanges(workdir)
  gitOut(['commit', '--quiet', '-m', documents.title], { cwd: workdir, env: botEnv() })
  const headSha = gitOut(['rev-parse', 'HEAD'], { cwd: workdir })
  gitOut(['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${PROPOSAL_BRANCH}`], { cwd: workdir })

  const inherited = context.input.proposal
  const issue = inherited?.issue.number ?? (await deps.github.paginate(`/repos/${repo}/issues?state=open`, issueSchema))
    .find(candidate => candidate.pull_request === undefined && candidate.body?.includes(PROPOSAL_MARKER) === true)?.number
  const issueLink = issue === undefined
    ? await deps.github.rest('POST', `/repos/${repo}/issues`, issueSchema, { title: documents.title, body: documents.issue })
    : await deps.github.rest('PATCH', `/repos/${repo}/issues/${String(issue)}`, issueSchema, { title: documents.title, body: documents.issue, state: 'open' })

  const pullBody = `${documents.pullRequest}\nCloses #${String(issueLink.number)}\n`
  const pull = inherited?.pullRequest.number ?? (await deps.github.paginate(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${deps.repository.owner}:${PROPOSAL_BRANCH}`)}`,
    pullSchema,
  ))[0]?.number
  const pullLink = pull === undefined
    ? await deps.github.rest('POST', `/repos/${repo}/pulls`, pullSchema, { title: documents.title, body: pullBody, head: PROPOSAL_BRANCH, base: deps.defaultBranch })
    : await deps.github.rest('PATCH', `/repos/${repo}/pulls/${String(pull)}`, pullSchema, { title: documents.title, body: pullBody, state: 'open' })

  const reports = collectPatchReports(workdir)
  const marker = `<!-- dsh-migrate:patch-reports:${context.input.target.version} -->`
  const existing = await deps.github.paginate(`/repos/${repo}/issues/${String(issueLink.number)}/comments`, commentSchema)
  if (!existing.some(comment => comment.body?.includes(marker) === true)) {
    const bodies = [
      ...formatPatchReportComment({ reports, pullRequestUrl: pullLink.html_url }),
      ...reports.filter(report => report.kind === 'draft').map(report => formatOfficialDiscussionInvite({ report })),
    ]
    for (const body of bodies) {
      await deps.github.rest('POST', `/repos/${repo}/issues/${String(issueLink.number)}/comments`, commentSchema, { body: `${marker}\n${body}` })
    }
  }

  const proposal: Proposal = {
    branch: PROPOSAL_BRANCH,
    headSha,
    issue: { number: issueLink.number, url: issueLink.html_url },
    pullRequest: { number: pullLink.number, url: pullLink.html_url },
  }
  const files = new Map(reports.map(report => [`patch-reports/${report.slug}.md`, report.body]))
  return { event: { type: 'proposal.published', proposal }, files }
}

const pullStateSchema = z.object({ state: z.string(), merged: z.boolean().optional() })

/** Whether a proposal's pull request is still open, or how it was closed. */
export async function pullRequestState(github: GitHubClient, repository: Repository, pullRequest: number): Promise<{ open: true } | { open: false; merged: boolean }> {
  const pull = await github.rest('GET', `/repos/${slugOf(repository)}/pulls/${String(pullRequest)}`, pullStateSchema)
  return pull.state === 'open' ? { open: true } : { open: false, merged: pull.merged === true }
}

const commitSchema = z.object({
  author: z.object({ login: z.string() }).nullable(),
  commit: z.object({ author: z.object({ email: z.string() }).nullable() }),
})

/**
 * Commits on a proposal's pull request that this Action did not author: a
 * newer migration must not force-push over them, and the report counts them as
 * the maintainer's rework.
 * @param github - a client that can read the consumer repository.
 * @param repository - the consumer repository.
 * @param pullRequest - the proposal's pull request number.
 */
export async function maintainerCommits(github: GitHubClient, repository: Repository, pullRequest: number): Promise<number> {
  const commits = await github.paginate(`/repos/${slugOf(repository)}/pulls/${String(pullRequest)}/commits`, commitSchema)
  return commits.filter(commit => commit.commit.author?.email !== BOT_EMAIL && commit.author?.login.endsWith('[bot]') !== true).length
}
