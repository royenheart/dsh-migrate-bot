import { githubRequest } from './api.ts'
import { resolveRepo } from './pr.ts'

/**
 * Answer a command on the thread it came from.
 *
 * The reply is the audit trail: a command that ran, a command that was refused,
 * and a command that failed all leave the same kind of record, which is why
 * every path produces one rather than staying silent.
 */
export async function postIssueComment(input: {
  token: string
  workdir: string
  issueNumber: number
  body: string
  fetchImpl?: typeof fetch
}): Promise<{ ok: true; url?: string } | { ok: false; reason: string }> {
  const { owner, repo } = resolveRepo(input.workdir)
  const created = await githubRequest(
    input.token,
    'POST',
    `/repos/${owner}/${repo}/issues/${String(input.issueNumber)}/comments`,
    { body: input.body },
    input.fetchImpl ?? fetch,
  ) as { html_url?: unknown }
  const url = typeof created.html_url === 'string' ? created.html_url : undefined
  return { ok: true, ...(url === undefined ? {} : { url }) }
}
