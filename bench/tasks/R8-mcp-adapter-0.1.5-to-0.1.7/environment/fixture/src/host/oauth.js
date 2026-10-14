import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { auth } from '@modelcontextprotocol/sdk/client/auth.js'

import { errorMessage } from './errors.js'

export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000
const TOKENS_FILE = join('mcp-auth', 'tokens.json')
const CALLBACK_PATH = '/callback'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pruneUndefined(record) {
  const output = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

/**
 * Absolute path of the token file. The DSH home wins when set; otherwise the
 * store falls back to `~/.dsh`. `home` overrides both for tests.
 */
export function tokenStorePath({ home, env = process.env } = {}) {
  const base = home ?? env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, TOKENS_FILE)
}

/**
 * File-backed TokenStore at `${DSH_HOME}/mcp-auth/tokens.json`, one JSON object
 * keyed by Server name. DSH exposes no credentials service for plugins, so the
 * file is the v1 backend: a directory created with 0700 and a file written with
 * 0600 (both best-effort; some filesystems ignore modes). Writes go to a temp
 * file and rename into place, and every operation runs through one in-process
 * queue so reads observe pending writes. A missing or unparsable file reads as
 * empty. `deps` injects fs-like functions for tests.
 */
export function createFileTokenStore({ home, env = process.env, deps = {} } = {}) {
  const fs = {
    readFile: deps.readFile ?? readFile,
    writeFile: deps.writeFile ?? writeFile,
    rename: deps.rename ?? rename,
    mkdir: deps.mkdir ?? mkdir,
    chmod: deps.chmod ?? chmod,
  }
  const path = tokenStorePath({ home, env })
  const directory = dirname(path)
  const tempPath = `${path}.tmp`

  let chain = Promise.resolve()
  const enqueue = (operation) => {
    const run = chain.then(operation, operation)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const requireName = (serverName) => {
    if (typeof serverName !== 'string' || serverName === '') {
      throw new TypeError('Token store operations require a non-empty Server name')
    }
  }

  const readAll = async () => {
    let text
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (error) {
      if (isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return {}
      }
      throw error
    }
    try {
      const parsed = JSON.parse(text)
      if (isRecord(parsed)) return parsed
    } catch {
      // A corrupt token file reads as empty; the next sign-in rewrites it.
    }
    return {}
  }

  const writeAll = async (data) => {
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    } catch {
      // Best-effort: some filesystems reject or ignore directory modes.
    }
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    try {
      await fs.chmod(tempPath, 0o600)
    } catch {
      // Best-effort: some filesystems ignore file modes.
    }
    await fs.rename(tempPath, path)
    try {
      await fs.chmod(path, 0o600)
    } catch {
      // Best-effort: some filesystems ignore file modes.
    }
  }

  const mutate = (operation) =>
    enqueue(async () => {
      const data = await readAll()
      const result = operation(data)
      await writeAll(result.data)
      return result.value
    })

  return {
    path,
    async get(serverName) {
      requireName(serverName)
      return enqueue(async () => {
        const record = (await readAll())[serverName]
        return isRecord(record) ? record : undefined
      })
    },
    async has(serverName) {
      requireName(serverName)
      return enqueue(async () => {
        const record = (await readAll())[serverName]
        return isRecord(record)
      })
    },
    async set(serverName, record) {
      requireName(serverName)
      if (!isRecord(record)) {
        throw new TypeError('Token store records must be plain objects')
      }
      return mutate((data) => {
        data[serverName] = pruneUndefined(record)
        return { data, value: pruneUndefined(record) }
      })
    },
    async delete(serverName) {
      requireName(serverName)
      return mutate((data) => {
        const existed = isRecord(data[serverName])
        delete data[serverName]
        return { data, value: existed }
      })
    },
  }
}

function tokensFromRecord(record, now) {
  const tokens = { access_token: record.accessToken, token_type: 'Bearer' }
  if (typeof record.refreshToken === 'string') tokens.refresh_token = record.refreshToken
  if (typeof record.expiresAt === 'number') {
    tokens.expires_in = Math.max(0, Math.round((record.expiresAt - now()) / 1000))
  }
  if (typeof record.scope === 'string') tokens.scope = record.scope
  return tokens
}

/**
 * Build the SDK's OAuthClientProvider (per @modelcontextprotocol/sdk 1.30.0,
 * dist/esm/client/auth.d.ts) for one Server.
 *
 * `redirectUrl` is the loopback callback of a sign-in flow's local listener.
 * Omit it for the connection-time provider: the SDK then treats the provider as
 * non-interactive and can never start a browser redirect from a background
 * connect. `flow: true` marks a sign-in flow: tokens() reports nothing so the
 * SDK always produces a fresh authorization URL, and the code verifier stays in
 * flow-local memory. Outside a flow, tokens() reads the store with URL binding
 * enforced and saveTokens() writes through.
 */
export function createOAuthProvider(
  serverName,
  config,
  { store, callbacks = {}, redirectUrl, flow = false, now = Date.now } = {},
) {
  if (typeof config?.url !== 'string' || config.url === '') {
    throw new TypeError('createOAuthProvider requires an HTTP Server config with a url')
  }
  if (store === undefined) {
    throw new TypeError('createOAuthProvider requires a token store')
  }

  let codeVerifier

  const boundRecord = async () => {
    const record = await store.get(serverName)
    return record !== undefined && record.url === config.url ? record : undefined
  }

  return {
    get redirectUrl() {
      return redirectUrl
    },

    get clientMetadata() {
      return {
        redirect_uris: [redirectUrl ?? 'http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'dsh-mcp-adapter',
        ...(Array.isArray(config.scopes) && config.scopes.length > 0
          ? { scope: config.scopes.join(' ') }
          : {}),
      }
    },

    ...(flow
      ? {
          state() {
            return randomBytes(16).toString('hex')
          },
        }
      : {}),

    async clientInformation() {
      return (await boundRecord())?.clientInformation ?? undefined
    },

    async saveClientInformation(clientInformation) {
      const record = await store.get(serverName)
      await store.set(serverName, {
        ...(record ?? {}),
        url: config.url,
        clientInformation,
      })
    },

    async tokens() {
      if (flow) return undefined
      const record = await boundRecord()
      if (
        record === undefined ||
        typeof record.accessToken !== 'string' ||
        record.accessToken === ''
      ) {
        return undefined
      }
      return tokensFromRecord(record, now)
    },

    async saveTokens(tokens) {
      if (!isRecord(tokens) || typeof tokens.access_token !== 'string') {
        throw new Error('OAuth token response did not include an access token')
      }
      const previous = await store.get(serverName)
      await store.set(serverName, {
        url: config.url,
        accessToken: tokens.access_token,
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
        ...(tokens.expires_in === undefined
          ? {}
          : { expiresAt: now() + tokens.expires_in * 1000 }),
        ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
        ...(previous?.clientInformation === undefined
          ? {}
          : { clientInformation: previous.clientInformation }),
      })
    },

    redirectToAuthorization(authorizationUrl) {
      callbacks.onAuthorizationRequired?.(authorizationUrl)
    },

    async saveCodeVerifier(verifier) {
      if (!flow) {
        throw new Error('OAuth code verifiers are only available during a sign-in flow')
      }
      codeVerifier = verifier
    },

    codeVerifier() {
      if (codeVerifier === undefined) {
        throw new Error('No OAuth code verifier is available for this Server')
      }
      return codeVerifier
    },

    async invalidateCredentials(scope) {
      if (scope === 'verifier') {
        codeVerifier = undefined
        return
      }
      if (scope === 'discovery') return
      const record = await store.get(serverName)
      if (record === undefined) return
      if (scope === 'all') {
        await store.delete(serverName)
        return
      }
      if (scope === 'tokens') {
        await store.set(serverName, {
          url: record.url,
          ...(record.clientInformation === undefined
            ? {}
            : { clientInformation: record.clientInformation }),
        })
        return
      }
      if (scope === 'client') {
        await store.set(serverName, pruneUndefined({ ...record, clientInformation: undefined }))
      }
    },
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function listenOnEphemeralPort(httpServer) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      httpServer.off('error', onError)
      resolve(httpServer.address().port)
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(0, '127.0.0.1')
  })
}

/**
 * Run one full authorization_code + PKCE sign-in for a Server.
 *
 * The flow listens on `http://127.0.0.1:<ephemeral>/callback` (RFC 8252
 * loopback), drives SDK discovery, dynamic client registration, and the
 * authorization URL through `auth()`, hands the authorization URL to the caller
 * via `onAuthorizationUrl`, then waits for the browser callback: it validates
 * the state parameter, exchanges the code through `auth()`, persists the tokens
 * through the store, closes the listener, and resolves with the stored record.
 *
 * Exactly one pending flow per Server when a `flows` Map is passed: the flow
 * registers itself under the Server name, refuses a second start while
 * pending, and removes itself when settled. The flow rejects on listener
 * errors, state mismatch, SDK failures, the abort signal, or after `timeoutMs`
 * (default 5 minutes).
 */
export async function startOAuthFlow({
  serverName,
  config,
  store,
  signal,
  onAuthorizationUrl,
  timeoutMs = OAUTH_FLOW_TIMEOUT_MS,
  flows,
} = {}) {
  if (typeof serverName !== 'string' || serverName === '') {
    throw new TypeError('startOAuthFlow requires a non-empty Server name')
  }
  if (typeof config?.url !== 'string' || config.url === '') {
    throw new TypeError('startOAuthFlow requires an HTTP Server config with a url')
  }
  if (store === undefined) throw new TypeError('startOAuthFlow requires a token store')
  if (flows !== undefined && flows.has(serverName)) {
    throw new Error(
      `An OAuth sign-in for ${JSON.stringify(serverName)} is already in progress`,
    )
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('OAuth sign-in was aborted')
  }

  const httpServer = createServer()
  let port
  try {
    port = await listenOnEphemeralPort(httpServer)
  } catch (error) {
    httpServer.close()
    throw new Error(
      `Could not start the OAuth callback listener for ${JSON.stringify(serverName)}: ${errorMessage(error)}`,
      { cause: error },
    )
  }

  const redirectUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  let authorizationUrl
  const provider = createOAuthProvider(serverName, config, {
    store,
    redirectUrl,
    flow: true,
    callbacks: {
      onAuthorizationRequired: (url) => {
        authorizationUrl = url
        try {
          onAuthorizationUrl?.(url)
        } catch {
          // A listener failure must not break the authorization handoff.
        }
      },
    },
  })

  // Settlement order matters: the request handler only answers the browser and
  // settles `callbackUrl`; every rejection flows through `run()` so the outer
  // promise never rejects from inside an HTTP event callback.
  try {
    flows?.set(serverName, true)
    return await new Promise((resolve, reject) => {
      let expectedState
      let callbackUrlResolve
      const callbackUrl = new Promise((resolveCallback) => {
        callbackUrlResolve = resolveCallback
      })
      let done = false
      let timer

      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error, cause) => {
        if (done) return
        done = true
        cleanup()
        reject(new Error(
          `OAuth sign-in for ${JSON.stringify(serverName)} failed: ${errorMessage(error)}`,
          { cause },
        ))
      }
      const finish = (value) => {
        if (done) return
        done = true
        cleanup()
        resolve(value)
      }
      const onAbort = () => {
        fail(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('OAuth sign-in was aborted'),
        )
      }

      const answer = (res, status, text) => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(text)
      }

      httpServer.on('request', (req, res) => {
        let url
        try {
          url = new URL(req.url, `http://127.0.0.1:${port}`)
        } catch {
          answer(res, 400, 'Malformed OAuth callback request.')
          return
        }
        if (url.pathname !== CALLBACK_PATH) {
          answer(res, 404, 'Not found')
          return
        }
        if (done) {
          answer(res, 410, 'This OAuth sign-in has already finished.')
          return
        }
        const state = url.searchParams.get('state')
        const oauthError = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        if (expectedState === undefined || state === null || state !== expectedState) {
          answer(res, 400, 'OAuth sign-in failed: authorization response state mismatch.')
          callbackUrlResolve({ error: 'authorization response state mismatch' })
          return
        }
        if (oauthError !== null) {
          answer(res, 400, `OAuth sign-in failed: the server returned ${oauthError}.`)
          callbackUrlResolve({
            error: `the authorization server returned ${JSON.stringify(oauthError)}`,
          })
          return
        }
        if (code === null || code === '') {
          answer(res, 400, 'OAuth sign-in failed: the callback carried no authorization code.')
          callbackUrlResolve({ error: 'the callback carried no authorization code' })
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><html><head><title>DSH MCP Adapter</title></head>` +
            `<body><p>Sign-in for ${escapeHtml(serverName)} is complete.` +
            ` The Adapter finished the OAuth flow in the background.` +
            ` You can close this tab.</p></body></html>`,
        )
        callbackUrlResolve({ url })
      })

      httpServer.on('error', (error) => {
        fail(new Error(
          `OAuth callback listener failed: ${errorMessage(error)}`,
          { cause: error },
        ))
      })

      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () =>
          fail(new Error(
            `the sign-in timed out after ${Math.round(timeoutMs / 1000)} seconds`,
          )),
        timeoutMs,
      )
      timer.unref?.()

      const run = async () => {
        try {
          const redirect = await auth(provider, { serverUrl: config.url })
          if (redirect !== 'REDIRECT') {
            throw new Error('OAuth authorization did not reach the redirect step')
          }
          if (authorizationUrl === undefined) {
            throw new Error('OAuth authorization did not produce an authorization URL')
          }
          expectedState = authorizationUrl.searchParams.get('state')
          if (expectedState === null || expectedState === undefined) {
            throw new Error('OAuth authorization URL did not include a state parameter')
          }
          const callback = await callbackUrl
          if (callback.error !== undefined) {
            throw new Error(`authorization response was rejected: ${callback.error}`)
          }
          const authorizationCode = callback.url.searchParams.get('code')
          const result = await auth(provider, {
            serverUrl: config.url,
            authorizationCode,
          })
          if (result !== 'AUTHORIZED') {
            throw new Error('OAuth token exchange did not complete')
          }
          const record = await store.get(serverName)
          if (
            record === undefined ||
            record.url !== config.url ||
            typeof record.accessToken !== 'string'
          ) {
            throw new Error('OAuth tokens were not persisted for the Server')
          }
          finish(record)
        } catch (error) {
          fail(error, error)
        }
      }
      void run()
    })
  } finally {
    flows?.delete(serverName)
    httpServer.close()
    httpServer.closeAllConnections?.()
  }
}
