import { errorMessage } from './errors.js'

const MCP_COMMAND_NAME = 'mcp'

const MCP_USAGE = 'Usage: /mcp [status|reconnect|enable|disable] [server]'

function success(text) {
  return { kind: 'success', text }
}

function failure(text) {
  return { kind: 'error', text }
}

/**
 * One status line per Server: `name — state (N tools)`, plus the live
 * message when one is present. Never ends in whitespace.
 */
function describeServer(server) {
  const noun = server.toolCount === 1 ? 'tool' : 'tools'
  const line = `${server.name} — ${server.state} (${server.toolCount} ${noun})`
  return server.message === undefined ? line : `${line} — ${server.message}`
}

function statusText(manager, name) {
  const { servers } = manager.statusSnapshot()
  if (name !== undefined) {
    const server = servers.find((entry) => entry.name === name)
    return server === undefined
      ? `No status reported for ${JSON.stringify(name)} yet.`
      : describeServer(server)
  }
  if (servers.length === 0) return 'No MCP Servers configured.'
  return servers.map(describeServer).join('\n')
}

/**
 * Same semantics as the `/mcp-adapter` reconnect RPC endpoint: close the
 * current connection, then list tools so the lazy lifecycle reconnects.
 */
async function reconnectServer(manager, name) {
  await manager.disconnect(name, 'manual reconnect')
  await manager.listTools(name)
  const server = manager
    .statusSnapshot()
    .servers.find((entry) => entry.name === name)
  return server === undefined
    ? `Reconnected ${name}.`
    : `Reconnected ${describeServer(server)}`
}

/**
 * Writes the global Config layer through the settings scope. The scope's
 * `update` merges the patch deeply, so sibling Servers and untouched fields
 * of the target Server survive. A workspace-sourced Server is refused: its
 * workspace entry would shadow the global write, so the file must change.
 */
async function setServerDisabled(settingsScope, name, disabled) {
  if (!Object.hasOwn(settingsScope.get().mcpServers ?? {}, name)) {
    throw new Error(`Unknown MCP server ${JSON.stringify(name)}`)
  }
  if (settingsScope.layerSnapshot?.().source?.[name] === 'workspace') {
    throw new Error(
      `Server ${name} is defined by the workspace .dsh/mcp.json; edit that file to change it`,
    )
  }
  await settingsScope.update({ mcpServers: { [name]: { disabled } } })
  return disabled
    ? `Server ${name} disabled in the global Config.`
    : `Server ${name} enabled in the global Config.`
}

async function handleMcpCommand(invocation, manager, settingsScope) {
  try {
    const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
    const subcommand = tokens[0] ?? 'status'
    const args = tokens.slice(1)

    if (subcommand === 'status' && args.length === 0) {
      return success(statusText(manager))
    }
    if (subcommand === 'status' && args.length === 1) {
      if (!Object.hasOwn(settingsScope.get().mcpServers ?? {}, args[0])) {
        throw new Error(`Unknown MCP server ${JSON.stringify(args[0])}`)
      }
      return success(statusText(manager, args[0]))
    }
    if (subcommand === 'reconnect' && args.length === 1) {
      return success(await reconnectServer(manager, args[0]))
    }
    if ((subcommand === 'enable' || subcommand === 'disable') && args.length === 1) {
      return success(await setServerDisabled(settingsScope, args[0], subcommand === 'disable'))
    }
    return failure(MCP_USAGE)
  } catch (error) {
    return failure(errorMessage(error))
  }
}

/**
 * Register the human `/mcp` command while the optional DSH commands service
 * exists. When it never appears, the nested fiber stays inactive and the
 * Adapter keeps running without the command.
 */
export function installMcpCommands(ctx, manager, settingsScope) {
  ctx.inject(['commands'], (commandsCtx) => {
    const unregister = commandsCtx.commands.register({
      name: MCP_COMMAND_NAME,
      description: 'Show MCP Server status, reconnect one Server, or enable or disable it.',
      input: { hint: '[status|reconnect|enable|disable] [server]' },
      handler: (invocation) => handleMcpCommand(invocation, manager, settingsScope),
    })
    ctx.effect(() => unregister, 'dsh-mcp-adapter: /mcp command')
  })
}
