import { startOAuthFlow } from './oauth.js'
import { errorMessage } from './errors.js'

/**
 * Host controller for OAuth sign-in of one Adapter: per-Server pending-flow
 * tracking, login/logout/status, and the hook the connection-time provider
 * uses to report a mid-session re-authorization demand.
 *
 * startLogin resolves with `{ authorizationUrl }` as soon as the authorization
 * URL exists — the caller hands it to the DSH browser session — and the flow
 * completes in the background. A completed login disconnects the Server
 * (`oauth login`) so the next use reconnects with the fresh tokens. Logout
 * aborts a pending flow, deletes tokens, and disconnects.
 */
export function installMcpOauth(ctx, manager, settingsScope, { store } = {}) {
  if (store === undefined) {
    throw new TypeError('installMcpOauth requires a token store')
  }

  // `entries` holds the controller's own per-Server state (abort handle,
  // flow promise, authorization URL). `flows` is the refusal-guard map that
  // startOAuthFlow self-manages while a flow is pending.
  const entries = new Map()
  const flows = new Map()
  let disposed = false

  const requireServer = (serverName) => {
    if (typeof serverName !== 'string' || serverName === '') {
      throw new Error('OAuth requires a non-empty Server name')
    }
    const config = settingsScope.get().mcpServers[serverName]
    if (config === undefined) {
      throw new Error(`Unknown MCP server ${JSON.stringify(serverName)}`)
    }
    if (config.disabled) {
      throw new Error(`MCP server ${JSON.stringify(serverName)} is disabled`)
    }
    if (config.auth !== 'oauth') {
      throw new Error(
        `MCP server ${JSON.stringify(serverName)} does not use OAuth authentication`,
      )
    }
    return config
  }

  const forgetIfCurrent = (serverName, entry) => {
    if (entries.get(serverName) === entry) entries.delete(serverName)
  }

  const controller = {
    async startLogin(serverName) {
      const config = requireServer(serverName)
      if (flows.has(serverName)) {
        throw new Error(
          `An OAuth sign-in for ${JSON.stringify(serverName)} is already in progress`,
        )
      }

      const abort = new AbortController()
      const entry = { abort, authorizationUrl: undefined, flow: undefined }
      let notifyUrl
      const urlReady = new Promise((resolve) => {
        notifyUrl = resolve
      })
      entries.set(serverName, entry)

      const raw = startOAuthFlow({
        serverName,
        config,
        store,
        signal: abort.signal,
        flows,
        onAuthorizationUrl: (url) => {
          entry.authorizationUrl = String(url)
          notifyUrl(entry.authorizationUrl)
        },
      })
      const flow = raw.then(
        () => {
          forgetIfCurrent(serverName, entry)
          // Reconnect with the fresh tokens right away: the manual reconnect
          // path (disconnect, then list tools) works for every lifecycle —
          // lazy, eager, and both keep-alive modes.
          return manager
            .disconnect(serverName, 'oauth login')
            .catch(() => undefined)
            .then(() => manager.listTools(serverName).catch(() => undefined))
        },
        (error) => {
          forgetIfCurrent(serverName, entry)
          if (!disposed && abort.signal.reason !== error) {
            ctx.logger?.warn?.(
              `dsh-mcp-adapter: OAuth sign-in for ${JSON.stringify(serverName)} failed: ${errorMessage(error)}`,
            )
          }
        },
      )
      entry.flow = flow

      // The handled `flow` chain never rejects, so race the raw flow: a
      // failure before the authorization URL must surface here, not hang.
      let raceError
      try {
        await Promise.race([urlReady, raw])
      } catch (error) {
        raceError = error
      }
      if (entry.authorizationUrl === undefined) {
        throw raceError ?? new Error(
          `OAuth sign-in for ${JSON.stringify(serverName)} failed before authorization`,
        )
      }
      return { authorizationUrl: entry.authorizationUrl }
    },

    async logout(serverName) {
      if (typeof serverName !== 'string' || serverName === '') {
        throw new Error('OAuth requires a non-empty Server name')
      }
      const config = settingsScope.get().mcpServers[serverName]
      if (config === undefined) {
        throw new Error(`Unknown MCP server ${JSON.stringify(serverName)}`)
      }
      if (config.auth !== 'oauth') {
        throw new Error(
          `MCP server ${JSON.stringify(serverName)} does not use OAuth authentication`,
        )
      }
      const entry = entries.get(serverName)
      if (entry !== undefined) {
        entry.abort.abort(new Error('OAuth sign-out cancelled this sign-in'))
        await entry.flow
      }
      await store.delete(serverName)
      await manager.disconnect(serverName, 'oauth logout').catch(() => undefined)
      return controller.status(serverName)
    },

    async status(serverName) {
      const config = settingsScope.get().mcpServers[serverName]
      const configured =
        config !== undefined && config.auth === 'oauth' && typeof config.url === 'string'
      if (!configured) {
        return {
          configured: false,
          signedIn: false,
          ...(config?.url === undefined ? {} : { url: config.url }),
        }
      }
      const record = await store.get(serverName)
      const signedIn =
        record !== undefined &&
        record.url === config.url &&
        typeof record.accessToken === 'string' &&
        record.accessToken !== ''
      const expiresAt =
        signedIn && typeof record.expiresAt === 'number' ? record.expiresAt : undefined
      return {
        configured: true,
        signedIn,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        url: config.url,
      }
    },

    noteAuthorizationRequired(serverName, url) {
      if (disposed) return
      ctx.logger?.warn?.(
        `dsh-mcp-adapter: ${JSON.stringify(serverName)} needs re-authorization ` +
          `(${String(url)}). Sign in via Settings > MCP or /mcp-auth.`,
      )
    },
  }

  ctx.effect(
    () => () => {
      disposed = true
      for (const entry of entries.values()) {
        entry.abort.abort(new Error('The Adapter stopped; this OAuth sign-in was cancelled'))
      }
    },
    'dsh-mcp-adapter: OAuth flow lifecycle',
  )

  return controller
}
