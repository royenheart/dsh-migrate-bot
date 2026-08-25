const RELEASES = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases'

export interface ResolvedVersion {
  tag: string
  version: string
}

function tagToVersion(tag: string): string {
  return tag.startsWith('dsh-v') ? tag.slice('dsh-v'.length) : tag.replace(/^v/, '')
}

/**
 * Resolve `latest` against public GitHub releases, or pass through a pin.
 * @param requested - `latest` or a concrete `0.1.1-rc.2` / `dsh-v0.1.1-rc.2`
 * @param fetchImpl - injectable fetch for tests
 */
export async function resolveDshVersion(
  requested: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedVersion> {
  if (requested !== 'latest') {
    const tag = requested.startsWith('dsh-v') ? requested : `dsh-v${requested}`
    return { tag, version: tagToVersion(tag) }
  }
  const response = await fetchImpl(RELEASES, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-migrate-action' },
  })
  if (!response.ok) {
    throw new Error(`failed to list dsh releases: HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error('dsh release list is empty')
  }
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue
    const tag = (item as { tag_name?: unknown }).tag_name
    if (typeof tag === 'string' && tag.startsWith('dsh-v')) {
      return { tag, version: tagToVersion(tag) }
    }
  }
  throw new Error('no dsh-v* release tag found')
}
