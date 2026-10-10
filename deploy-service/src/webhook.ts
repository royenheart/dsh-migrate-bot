import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { repositorySchema, shaSchema, type Announcement, type PreviewKey } from './previews.ts'

/**
 * What a GitHub `pull_request` event asks of the preview manager.
 *
 * A preview runs the pull request's code, so it is built only when that code
 * comes from a branch of the repository itself, which only someone with write
 * access can push. A pull request from a fork, or from a fork that was deleted,
 * gets no preview.
 */

const pullRequestEventSchema = z.object({
  action: z.string(),
  number: z.number().int().min(1),
  pull_request: z.object({
    head: z.object({ sha: shaSchema, repo: z.object({ full_name: z.string() }).nullable() }),
  }),
  repository: z.object({ full_name: repositorySchema, clone_url: z.string() }),
})

export type WebhookIntent =
  | { kind: 'build'; announcement: Announcement; reopened: boolean }
  | { kind: 'close'; key: PreviewKey }
  | { kind: 'refuse'; key: PreviewKey; reason: string }
  | { kind: 'ignore'; reason: string }
  | { kind: 'invalid'; reason: string }

/** The `pull_request` actions that build or rebuild a preview. */
const BUILD_ACTIONS = new Set(['opened', 'synchronize', 'reopened'])

/**
 * Whether the service may fetch from a clone URL.
 *
 * `https:` always; a local path or `http:` only with the `process` provider,
 * which exists for CI and tests, where the repository is a directory.
 * @param url - the clone URL from the event.
 * @param provider - the configured provider.
 */
export function allowedCloneUrl(url: string, provider: 'docker' | 'process'): boolean {
  if (provider === 'process' && isAbsolute(url)) return true
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || (provider === 'process' && protocol === 'http:')
  } catch {
    return false
  }
}

/**
 * Read one webhook delivery.
 * @param event - the `X-GitHub-Event` header.
 * @param body - the parsed JSON body.
 * @param provider - the configured provider, which decides the clone URLs accepted.
 */
export function webhookIntent(event: string | undefined, body: unknown, provider: 'docker' | 'process'): WebhookIntent {
  if (event !== 'pull_request') return { kind: 'ignore', reason: `${event ?? 'an unnamed'} event is not one the deploy service acts on` }
  const parsed = pullRequestEventSchema.safeParse(body)
  if (!parsed.success) {
    return { kind: 'invalid', reason: parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ') }
  }
  const payload = parsed.data
  const key = { repository: payload.repository.full_name, pullRequest: payload.number }
  if (payload.action === 'closed') return { kind: 'close', key }
  if (!BUILD_ACTIONS.has(payload.action)) return { kind: 'ignore', reason: `pull_request ${payload.action} changes nothing a preview is built from` }
  const head = payload.pull_request.head.repo?.full_name
  if (head !== payload.repository.full_name) {
    return { kind: 'refuse', key, reason: `the pull request's branch is in ${head ?? 'a deleted repository'}, not in ${payload.repository.full_name}; previews are built only for branches of the repository itself` }
  }
  if (!allowedCloneUrl(payload.repository.clone_url, provider)) return { kind: 'invalid', reason: `repository.clone_url is not a URL this provider fetches from` }
  return {
    kind: 'build',
    reopened: payload.action === 'reopened',
    announcement: { ...key, headSha: payload.pull_request.head.sha, cloneUrl: payload.repository.clone_url },
  }
}
