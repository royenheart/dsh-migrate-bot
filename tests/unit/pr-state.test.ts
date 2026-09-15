import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPullRequestState, parsePullRequestNumber } from '../../src/github/pr.ts'
import { publishedPullRequest } from '../../src/watch/sync.ts'

test('parsePullRequestNumber reads /pull/N from a GitHub URL', () => {
  assert.equal(parsePullRequestNumber('https://github.com/acme/plug/pull/12'), 12)
  assert.equal(parsePullRequestNumber('https://github.com/acme/plug/pull/12/files'), 12)
  assert.equal(parsePullRequestNumber(undefined), undefined)
  assert.equal(parsePullRequestNumber('https://example.test/x'), undefined)
})

test('publishedPullRequest prefers the numeric field then the URL', () => {
  assert.deepEqual(
    publishedPullRequest({ pullRequestNumber: 4, pullRequestUrl: 'https://github.com/a/b/pull/9' }),
    { number: 4, url: 'https://github.com/a/b/pull/9' },
  )
  assert.deepEqual(
    publishedPullRequest({ pullRequestUrl: 'https://github.com/a/b/pull/9' }),
    { number: 9, url: 'https://github.com/a/b/pull/9' },
  )
  assert.equal(publishedPullRequest({}), undefined)
})

test('fetchPullRequestState maps merged, open, closed, and 404', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input))
    if (String(input).endsWith('/pulls/1')) {
      return new Response(JSON.stringify({ state: 'closed', merged: true }), { status: 200 })
    }
    if (String(input).endsWith('/pulls/2')) {
      return new Response(JSON.stringify({ state: 'open', merged: false }), { status: 200 })
    }
    if (String(input).endsWith('/pulls/3')) {
      return new Response(JSON.stringify({ state: 'closed', merged: false }), { status: 200 })
    }
    return new Response('gone', { status: 404 })
  }
  assert.equal(await fetchPullRequestState({
    token: 't', owner: 'a', repo: 'b', pr: 1, fetchImpl,
  }), 'merged')
  assert.equal(await fetchPullRequestState({
    token: 't', owner: 'a', repo: 'b', pr: 2, fetchImpl,
  }), 'open')
  assert.equal(await fetchPullRequestState({
    token: 't', owner: 'a', repo: 'b', pr: 3, fetchImpl,
  }), 'closed')
  assert.equal(await fetchPullRequestState({
    token: 't', owner: 'a', repo: 'b', pr: 4, fetchImpl,
  }), 'missing')
  assert.ok(calls[0]?.includes('/repos/a/b/pulls/1'))
})

test('a GitHub answer cannot add a line to the message it becomes', async () => {
  // An error body is JSON from somebody else's service, and these messages reach
  // a log line and, through a thrown error, whatever renders it.
  const { githubGet, githubRequest } = await import('../../src/github/api.ts')
  const body = '{\n  "message": "Validation Failed",\n  "errors": [{"code": "missing"}]\n}'
  const answer = await githubGet('t', '/repos/a/b/pulls/1', async () => new Response(body, { status: 422 }))
  assert.equal(answer.ok, false)
  const detail = answer.ok ? '' : answer.detail
  assert.equal(detail.split('\n').length, 1)
  assert.match(detail, /Validation Failed/)

  await assert.rejects(
    async () => await githubRequest('t', 'POST', '/repos/a/b/issues', {}, async () => new Response(body, { status: 422 })),
    (error: Error) => {
      assert.equal(error.message.split('\n').length, 1)
      assert.match(error.message, /Validation Failed/)
      return true
    },
  )
})
