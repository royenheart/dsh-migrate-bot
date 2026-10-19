import { errorMessage } from './errors.js'

const USAGE = 'Usage: /mcp-auth [server] [login|logout|status]'

function statusText(serverName, status) {
  if (status.configured !== true) {
    return `${serverName}: not configured for OAuth authentication.`
  }
  if (status.signedIn !== true) return `${serverName}: signed out.`
  if (
    status.expiresAt !== undefined &&
    status.expiresAt <= Date.now()
  ) {
    return `${serverName}: signed in (token expired; the Adapter refreshes or asks to sign in again on next use).`
  }
  return `${serverName}: signed in.`
}

function usageError() {
  return { kind: 'error', text: USAGE }
}

async function statusAll(oauth, settingsScope) {
  const servers = Object.entries(settingsScope.get().mcpServers).filter(
    ([, config]) => config.auth === 'oauth',
  )
  if (servers.length === 0) {
    return {
      kind: 'success',
      text: 'No Server uses OAuth authentication. Set auth "oauth" on a remote HTTP Server in Settings > MCP.',
    }
  }
  const lines = []
  for (const [serverName] of servers) {
    lines.push(statusText(serverName, await oauth.status(serverName)))
  }
  return { kind: 'success', text: lines.join('\n') }
}

async function runMcpAuthCommand(rawInput, oauth, settingsScope) {
  const parts = (typeof rawInput === 'string' ? rawInput : '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return statusAll(oauth, settingsScope)
  if (parts.length > 2) return usageError()
  const [serverName, action] = parts
  if (action !== 'login' && action !== 'logout' && action !== 'status') return usageError()

  if (action === 'login') {
    const { authorizationUrl } = await oauth.startLogin(serverName)
    return {
      kind: 'success',
      text:
        `Sign-in started for ${JSON.stringify(serverName)}. Open the authorization URL in your browser if it did not open by itself:\n` +
        `${authorizationUrl}\n` +
        `The Adapter finishes the OAuth flow in the background and reconnects the Server with fresh tokens.`,
    }
  }
  if (action === 'logout') {
    const status = await oauth.logout(serverName)
    return {
      kind: 'success',
      text: `${statusText(serverName, status)} Tokens were deleted and the Server disconnected.`,
    }
  }
  return {
    kind: 'success',
    text: statusText(serverName, await oauth.status(serverName)),
  }
}

/**
 * Register the `mcp-auth` DSH command. The handler never throws: every outcome
 * becomes `{ kind: 'success' | 'error', text }`. The controller owns
 * disconnects, so the manager is not needed here.
 */
export function installMcpOauthCommands(ctx, settingsScope, oauth) {
  ctx.inject(['commands'], (commandsCtx) => {
    const dispose = commandsCtx.commands.register({
      name: 'mcp-auth',
      description:
        'Show or manage OAuth 2.0 sign-in for remote HTTP MCP Servers.',
      input: { hint: '[server] [login|logout|status]' },
      handler: ({ rawInput } = {}) => {
        return runMcpAuthCommand(rawInput, oauth, settingsScope).catch((error) => ({
          kind: 'error',
          text: errorMessage(error),
        }))
      },
    })
    ctx.effect(() => dispose, 'dsh-mcp-adapter: mcp-auth command')
  })
}
