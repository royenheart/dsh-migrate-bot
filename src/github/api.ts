export async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(`https://api.github.com${path}`, {
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
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${text}`)
  }
  return text === '' ? {} : JSON.parse(text)
}

export async function githubGet(
  token: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; detail: string }> {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'dsh-migrate-action',
    },
  })
  const text = await response.text()
  if (!response.ok) {
    return { ok: false, status: response.status, detail: text }
  }
  return { ok: true, body: text === '' ? {} : JSON.parse(text) }
}
