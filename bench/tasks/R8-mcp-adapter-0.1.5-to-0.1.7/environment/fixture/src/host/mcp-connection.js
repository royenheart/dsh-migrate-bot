import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createOAuthProvider } from './oauth.js'

export const CONNECT_TIMEOUT_MS = 30_000
export const REQUEST_TIMEOUT_MS = 30_000

const DEFAULT_SDK = {
  Client,
  SSEClientTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  getDefaultEnvironment,
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function createClient(serverName, callbacks, sdk) {
  const client = new sdk.Client(
    { name: 'dsh-mcp-adapter', version: '0.1.0' },
    {
      listChanged: {
        tools: {
          autoRefresh: true,
          debounceMs: 100,
          onChanged(error, tools) {
            callbacks.onToolsChanged?.(error, tools)
          },
        },
      },
    },
  )

  client.onerror = (error) => callbacks.onError?.(error)
  client.onclose = () => callbacks.onClose?.()
  return client
}

async function closeQuietly(client, transport) {
  try {
    await client?.close()
  } catch {
    try {
      await transport?.close()
    } catch {
      // The failed connection has no remaining lifecycle work.
    }
  }
}

async function connectClient(client, transport, signal) {
  await client.connect(transport, {
    signal,
    timeout: CONNECT_TIMEOUT_MS,
  })
}

function oauthSignInError(serverName) {
  return new Error(
    `OAuth authorization required for ${serverName} — sign in via Settings > MCP or /mcp-auth`,
  )
}

/**
 * Build the connection-time OAuth provider for one Server. The provider is
 * non-interactive: without a redirectUrl the SDK can never start a browser
 * flow from a background connect. Signed-in state is required up front; the
 * URL binding from the store must match the configured Server URL.
 */
async function createHttpAuthProvider(serverName, config, oauth) {
  const record = oauth?.store === undefined ? undefined : await oauth.store.get(serverName)
  if (
    record === undefined ||
    record.url !== config.url ||
    typeof record.accessToken !== 'string' ||
    record.accessToken === ''
  ) {
    throw oauthSignInError(serverName)
  }
  return createOAuthProvider(serverName, config, {
    store: oauth.store,
    callbacks: { onAuthorizationRequired: oauth.onAuthorizationRequired },
  })
}

/**
 * Create one connected SDK client. HTTP follows the MCP compatibility rule:
 * attempt streamable HTTP first, then retry once with the legacy SSE transport
 * and a fresh Client/Transport pair.
 *
 * `sdk` is injectable for transport-contract tests. Production callers omit it.
 * `oauth` carries `{ store, onAuthorizationRequired }`; Servers configured with
 * `auth: "oauth"` require signed-in tokens in the store before connecting, and
 * both HTTP transports receive the provider as their `authProvider`. The
 * header/bearer path (`auth: "headers"`) is unchanged.
 */
export async function createMcpConnection(
  serverName,
  config,
  callbacks = {},
  signal,
  sdk = DEFAULT_SDK,
  oauth,
) {
  if (typeof config.command === 'string') {
    const client = createClient(serverName, callbacks, sdk)
    const transport = new sdk.StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...sdk.getDefaultEnvironment(),
        ...config.env,
      },
      stderr: 'pipe',
    })

    let stderr = ''
    transport.stderr?.on?.('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8192)
    })

    try {
      await connectClient(client, transport, signal)
      return {
        client,
        transport,
        transportType: 'stdio',
        diagnostic: () => stderr.trim(),
        close: () => closeQuietly(client, transport),
      }
    } catch (error) {
      await closeQuietly(client, transport)
      const detail = stderr.trim()
      if (detail === '') throw error
      throw new Error(`${errorMessage(error)}\nServer stderr:\n${detail}`, {
        cause: error,
      })
    }
  }

  const url = new URL(config.url)
  const requestInit = { headers: { ...config.headers } }
  const authProvider =
    config.auth === 'oauth' ? await createHttpAuthProvider(serverName, config, oauth) : undefined

  let streamableClient = createClient(serverName, callbacks, sdk)
  let streamableTransport = new sdk.StreamableHTTPClientTransport(url, {
    requestInit,
    ...(authProvider === undefined ? {} : { authProvider }),
  })
  let streamableError

  try {
    await connectClient(streamableClient, streamableTransport, signal)
    return {
      client: streamableClient,
      transport: streamableTransport,
      transportType: 'streamable-http',
      diagnostic: () => '',
      close: () => closeQuietly(streamableClient, streamableTransport),
    }
  } catch (error) {
    streamableError = error
    await closeQuietly(streamableClient, streamableTransport)
  }

  const sseClient = createClient(serverName, callbacks, sdk)
  const sseTransport = new sdk.SSEClientTransport(url, {
    requestInit,
    ...(authProvider === undefined ? {} : { authProvider }),
  })
  try {
    await connectClient(sseClient, sseTransport, signal)
    return {
      client: sseClient,
      transport: sseTransport,
      transportType: 'sse',
      diagnostic: () => '',
      close: () => closeQuietly(sseClient, sseTransport),
    }
  } catch (sseError) {
    await closeQuietly(sseClient, sseTransport)
    throw new Error(
      `Could not connect to ${serverName} with streamable HTTP or SSE. ` +
        `Streamable HTTP: ${errorMessage(streamableError)}. ` +
        `SSE: ${errorMessage(sseError)}.`,
      { cause: sseError },
    )
  }
}
