import { inline } from '../render/text.ts'

export async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(`${apiBase()}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'dsh-migrate-action',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    // The answer is somebody else's text and this message reaches a log line and
    // a reply: one line of it, the way the deploy client treats its own errors.
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${inline(text, 300)}`)
  }
  return text === '' ? {} : JSON.parse(text)
}

/**
 * The REST endpoint this Action talks to.
 *
 * `GITHUB_API_URL` is what GitHub sets for the instance the workflow runs on, so
 * a GitHub Enterprise runner is answered by its own API rather than by
 * github.com — and a test can point it at a stub.
 */
export function apiBase(): string {
  const configured = process.env.GITHUB_API_URL
  return configured === undefined || configured === '' ? 'https://api.github.com' : configured.replace(/\/+$/, '')
}

export async function githubGet(
  token: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; detail: string }> {
  const response = await fetchImpl(`${apiBase()}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'dsh-migrate-action',
    },
  })
  const text = await response.text()
  if (!response.ok) {
    // One line, for the same reason: this detail is interpolated into messages
    // that a human reads, and a body can be several lines of JSON.
    return { ok: false, status: response.status, detail: inline(text, 300) }
  }
  return { ok: true, body: text === '' ? {} : JSON.parse(text) }
}
