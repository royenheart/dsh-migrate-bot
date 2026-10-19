import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import { createFileTokenStore, startOAuthFlow } from '../src/host/oauth.js'
import { installMcpOauth } from '../src/host/oauth-service.js'

function memoryDeps() {
  const files = new Map()
  return {
    files,
    deps: {
      async readFile(path) {
        if (!files.has(path)) {
          const error = new Error(`ENOENT: ${path}`)
          error.code = 'ENOENT'
          throw error
        }
        return files.get(path)
      },
      async writeFile(path, data) {
        files.set(path, data)
      },
      async rename(from, to) {
        files.set(to, files.get(from))
        files.delete(from)
      },
      async mkdir() {},
      async chmod() {},
    },
  }
}

function createStore() {
  const { deps } = memoryDeps()
  return createFileTokenStore({ home: '/home/test/.dsh', deps })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * One fake OAuth authorization server on an ephemeral loopback port. It
 * implements exactly what the SDK's `auth()` helper requests: protected
 * resource metadata (404, so the Server URL origin acts as the authorization
 * server), authorization server metadata, dynamic client registration, and a
 * token endpoint that verifies the PKCE S256 challenge.
 */
async function createFakeAuthServer({ tokenStatus = 200, tokenBody } = {}) {
  const requests = { register: [], token: [] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(404)
      res.end()
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const origin = `http://127.0.0.1:${server.address().port}`
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        issuer: `${origin}/`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const metadata = JSON.parse(await readBody(req))
      requests.register.push(metadata)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...metadata, client_id: 'test-client-1' }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const params = Object.fromEntries(new URLSearchParams(await readBody(req)))
      requests.token.push(params)
      if (tokenStatus !== 200) {
        res.writeHead(tokenStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(tokenBody ?? { error: 'invalid_grant', error_description: 'code rejected' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-1',
        scope: 'read write',
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    requests,
    port,
    serverUrl: `http://127.0.0.1:${port}/mcp`,
    async close() {
      server.closeAllConnections?.()
      server.close()
      await once(server, 'close').catch(() => undefined)
    },
  }
}

function beginFlow(auth, overrides = {}) {
  const seenUrls = []
  let notifyUrl
  const urlReady = new Promise((resolve) => {
    notifyUrl = resolve
  })
  let rejectionAssertion
  const promise = startOAuthFlow({
    serverName: 'remote',
    config: { url: auth.serverUrl, auth: 'oauth', scopes: ['read', 'write'] },
    store: overrides.store ?? createStore(),
    flows: overrides.flows,
    timeoutMs: overrides.timeoutMs,
    signal: overrides.signal,
    onAuthorizationUrl: (url) => {
      seenUrls.push(url)
      notifyUrl(url)
    },
  })
  // Track the expected rejection from the start so node --test never sees a
  // momentary unhandled rejection between the failure and the assertion.
  promise.catch(() => undefined)
  return {
    promise,
    seenUrls,
    urlReady,
    expectRejection: (matcher) => {
      rejectionAssertion ??= assert.rejects(promise, matcher)
      return rejectionAssertion
    },
  }
}

async function completeBrowserStep(authorizationUrl, { state } = {}) {
  const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri'))
  callbackUrl.searchParams.set('code', 'auth-code-1')
  callbackUrl.searchParams.set('state', state ?? authorizationUrl.searchParams.get('state'))
  return fetch(callbackUrl)
}

test('completes authorization code + PKCE and persists tokens through the store', async () => {
  const auth = await createFakeAuthServer()
  try {
    const store = createStore()
    const { promise, seenUrls, urlReady } = beginFlow(auth, { store })
    const authorizationUrl = await urlReady

    assert.equal(seenUrls.length, 1)
    assert.equal(authorizationUrl.searchParams.get('response_type'), 'code')
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'test-client-1')
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorizationUrl.searchParams.get('code_challenge').length >= 43)
    assert.equal(authorizationUrl.searchParams.get('scope'), 'read write')
    assert.ok(authorizationUrl.searchParams.get('state').length >= 16)
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri')
    assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    assert.notEqual(
      new URL(redirectUri).port,
      String(auth.port),
      'the callback listener is its own loopback listener',
    )

    // Dynamic client registration carried the public PKCE metadata.
    assert.deepEqual(auth.requests.register[0].token_endpoint_auth_method, 'none')
    assert.equal(auth.requests.register[0].client_name, 'dsh-mcp-adapter')
    assert.deepEqual(auth.requests.register[0].grant_types, [
      'authorization_code',
      'refresh_token',
    ])

    const response = await completeBrowserStep(authorizationUrl)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Sign-in for remote is complete/)

    const record = await promise
    assert.equal(record.url, auth.serverUrl)
    assert.equal(record.accessToken, 'at-1')
    assert.equal(record.refreshToken, 'rt-1')
    assert.equal(record.scope, 'read write')
    assert.ok(record.expiresAt > Date.now())
    assert.equal(record.clientInformation.client_id, 'test-client-1')
    assert.deepEqual(await store.get('remote'), record)

    // The token endpoint saw the authorization_code grant and a verifier whose
    // S256 digest equals the challenge from the authorization URL.
    const tokenRequest = auth.requests.token[0]
    assert.equal(tokenRequest.grant_type, 'authorization_code')
    assert.equal(tokenRequest.code, 'auth-code-1')
    assert.equal(tokenRequest.client_id, 'test-client-1')
    assert.equal(tokenRequest.redirect_uri, redirectUri)
    const challenge = createHash('sha256')
      .update(tokenRequest.code_verifier)
      .digest('base64url')
    assert.equal(challenge, authorizationUrl.searchParams.get('code_challenge'))

    await assert.rejects(
      fetch(`${redirectUri}?code=x&state=y`),
      /fetch failed/,
      'the callback listener is closed after the flow',
    )
  } finally {
    await auth.close()
  }
})

test('answers 400 and rejects the flow on a state mismatch', async () => {
  const auth = await createFakeAuthServer()
  try {
    const { promise, urlReady } = beginFlow(auth)
    const authorizationUrl = await urlReady
    const response = await completeBrowserStep(authorizationUrl, { state: 'forged-state' })
    assert.equal(response.status, 400)
    await assert.rejects(promise, /state mismatch/)
  } finally {
    await auth.close()
  }
})

test('rejects the flow when the authorization server reports an error', async () => {
  const auth = await createFakeAuthServer()
  try {
    const { promise, urlReady } = beginFlow(auth)
    const authorizationUrl = await urlReady
    const callbackUrl = new URL(authorizationUrl.searchParams.get('redirect_uri'))
    callbackUrl.searchParams.set('error', 'access_denied')
    callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state'))
    const response = await fetch(callbackUrl)
    assert.equal(response.status, 400)
    await assert.rejects(promise, /access_denied/)
  } finally {
    await auth.close()
  }
})

test('rejects and cleans up after the timeout', async () => {
  const auth = await createFakeAuthServer()
  try {
    const { promise, urlReady } = beginFlow(auth, { timeoutMs: 50 })
    const redirectUri = (await urlReady).searchParams.get('redirect_uri')
    await assert.rejects(promise, /timed out/)
    await assert.rejects(fetch(`${redirectUri}?code=x&state=y`), /fetch failed/)
  } finally {
    await auth.close()
  }
})

test('rejects when the abort signal fires and closes the listener', async () => {
  const auth = await createFakeAuthServer()
  try {
    const controller = new AbortController()
    const { promise, urlReady } = beginFlow(auth, { signal: controller.signal })
    await urlReady
    controller.abort(new Error('user navigated away'))
    await assert.rejects(promise, /user navigated away/)
  } finally {
    await auth.close()
  }
})

test('refuses a second concurrent flow for the same Server', async () => {
  const auth = await createFakeAuthServer()
  try {
    const flows = new Map()
    const first = beginFlow(auth, { flows })
    const firstUrl = await first.urlReady

    await assert.rejects(
      beginFlow(auth, { flows }).promise,
      /already in progress/,
    )

    const response = await completeBrowserStep(firstUrl)
    assert.equal(response.status, 200)
    const record = await first.promise
    assert.equal(record.accessToken, 'at-1')
    assert.equal(flows.size, 0, 'the finished flow releases its slot')
  } finally {
    await auth.close()
  }
})

test('rejects when the authorization server is unreachable', async () => {
  // Take a real ephemeral port, free it, and use it: a guaranteed refused
  // connection. Discovery falls back to it as the authorization server and
  // registration fails.
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const deadPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const auth = { serverUrl: `http://127.0.0.1:${deadPort}/mcp`, close: async () => {} }
  const { promise } = beginFlow(auth)
  await assert.rejects(promise, /fetch failed|ECONNREFUSED/)
})

test('rejects and keeps client registration when the token exchange fails', async () => {
  const auth = await createFakeAuthServer({ tokenStatus: 400 })
  try {
    const store = createStore()
    const { promise, urlReady } = beginFlow(auth, { store })
    const authorizationUrl = await urlReady
    await completeBrowserStep(authorizationUrl)
    await assert.rejects(promise, /code rejected|invalid_grant/)

    const record = await store.get('remote')
    assert.equal(record.url, auth.serverUrl)
    assert.equal(record.accessToken, undefined)
    assert.equal(record.clientInformation.client_id, 'test-client-1')
    assert.equal(auth.requests.token.length, 2, 'the SDK retried once after invalidation')
  } finally {
    await auth.close()
  }
})

test('a login always produces a fresh authorization URL even when signed in', async () => {
  const auth = await createFakeAuthServer()
  try {
    const store = createStore()
    await store.set('remote', {
      url: auth.serverUrl,
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      clientInformation: { client_id: 'registered-earlier' },
    })
    const { promise, urlReady } = beginFlow(auth, { store })
    const authorizationUrl = await urlReady
    assert.equal(
      authorizationUrl.searchParams.get('client_id'),
      'registered-earlier',
      'the flow produces a fresh authorization URL instead of silently refreshing',
    )
    await completeBrowserStep(authorizationUrl)
    const record = await promise
    assert.equal(record.accessToken, 'at-1')
    assert.equal(record.refreshToken, 'rt-1')
  } finally {
    await auth.close()
  }
})

test('a completed sign-in reconnects the Server through the manager', async () => {
  const auth = await createFakeAuthServer()
  try {
    const store = createStore()
    const manager = {
      disconnects: [],
      reconnects: [],
      async disconnect(name, reason) {
        this.disconnects.push([name, reason])
      },
      async listTools(name) {
        this.reconnects.push(name)
        return { tools: [] }
      },
    }
    const oauth = installMcpOauth(
      { effect() {}, logger: { warn() {} } },
      manager,
      {
        get: () => ({
          mcpServers: {
            remote: {
              url: auth.serverUrl,
              auth: 'oauth',
              scopes: ['read', 'write'],
              disabled: false,
            },
          },
        }),
      },
      { store },
    )
    const login = await oauth.startLogin('remote')
    const response = await completeBrowserStep(new URL(login.authorizationUrl))
    assert.equal(response.status, 200)

    for (let i = 0; i < 500 && manager.reconnects.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(await store.get('remote'), 'the flow persisted tokens')
    assert.deepEqual(manager.disconnects, [['remote', 'oauth login']])
    assert.deepEqual(manager.reconnects, ['remote'])
  } finally {
    await auth.close()
  }
})
