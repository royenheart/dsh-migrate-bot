import z from '@deepseek-ai/schemastery'

// The plain namespace string works on both supported harness generations:
// DSH 0.1.1-rc.2 brands it via the (removed-in-0.1.2-rc.1) `settingsNamespace`
// export, while 0.1.2-rc.1 validates the raw string inside `register` itself.
// Branding was type-only, so no runtime behavior changes either way.
export const MCP_SETTINGS_NAMESPACE = 'mcp'

const optionalString = () => z.string().required(false)

export const McpServerSchema = z
  .object({
    // Standard mcpServers transport fields. command and url stay optional in
    // the serializable schema; validateMcpSettings enforces exactly one.
    command: optionalString().description('Executable for a stdio MCP server.'),
    args: z
      .array(z.string())
      .description('Arguments passed to the stdio server command.'),
    env: z
      .dict(z.string().role('secret'))
      .description('Environment variables passed to the stdio server.'),
    url: optionalString().description(
      'HTTP(S) endpoint for streamable HTTP with SSE fallback.',
    ),
    headers: z
      .dict(z.string().role('secret'))
      .description('Headers sent to the remote HTTP MCP server.'),
    auth: z
      .union(['headers', 'oauth'])
      .default('headers')
      .description('HTTP authentication mode: static headers, or OAuth 2.0 with PKCE.'),
    scopes: z
      .array(z.string())
      .default([])
      .description('OAuth scopes to request.'),

    // Adapter extensions. These fields remain paste-compatible with standard
    // clients because other clients ignore unknown per-server keys.
    disabled: z
      .boolean()
      .default(false)
      .description('Disable this server without deleting its Config.'),
    autoAllow: z
      .boolean()
      .default(false)
      .description('Run this server’s tool calls without DSH approval prompts.'),
    lifecycle: z
      .union(['lazy', 'eager', 'keep-alive', 'lazy-keep-alive'])
      .default('lazy')
      .description(
        'Connection lifecycle: lazy (connect on first use, disconnect after idle '
        + 'timeout), eager (connect at startup, idle timeout still applies), '
        + 'keep-alive (connect at startup, never idle out, auto-reconnect), or '
        + 'lazy-keep-alive (connect on first use, never idle out, auto-reconnect).',
      ),
    idleTimeoutMinutes: z
      .number()
      .default(10)
      .description('Disconnect after this many idle minutes.'),
    promotedTools: z
      .array(z.string())
      .default([])
      .description('MCP tool names promoted to native DSH tools.'),
  })
  .description('One configured MCP server.')

export const McpSettingsSchema = z.object({
  mcpServers: z
    .dict(McpServerSchema)
    .default({})
    .description('Global MCP servers, keyed by their unique server name.'),
  skillInstall: z
    .union(['file', 'runtime', 'off'])
    .default('file')
    .description(
      'How the bundled mcp-adapter agent skill is installed: file (copy to '
      + '$DSH_HOME/skills/mcp-adapter/ so Settings > Skills lists it; an '
      + 'existing file is never overwritten), runtime (register in memory '
      + 'only), or off (no skill). Read once at Adapter startup.',
    ),
})

const TOP_LEVEL_KEYS = new Set(['mcpServers', 'skillInstall'])
const SERVER_KEYS = new Set([
  'command',
  'args',
  'env',
  'url',
  'headers',
  'auth',
  'scopes',
  'disabled',
  'autoAllow',
  'lifecycle',
  'idleTimeoutMinutes',
  'promotedTools',
])
const RESERVED_SERVER_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`)
}

function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field')
  }
}

/**
 * Cross-field checks that the serializable Schemastery shape cannot express.
 * SettingsProvider runs this after schema validation and before every persist.
 */
export function validateMcpSettings(value) {
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, 'mcp')

  for (const [serverName, server] of Object.entries(value.mcpServers)) {
    const path = `mcp.mcpServers.${serverName}`

    if (serverName.trim() === '') fail('mcp.mcpServers', 'server names cannot be empty')
    if (RESERVED_SERVER_NAMES.has(serverName)) {
      fail(path, 'reserved server name')
    }

    rejectUnknownKeys(server, SERVER_KEYS, path)

    const hasCommand = typeof server.command === 'string'
    const hasUrl = typeof server.url === 'string'
    if (hasCommand === hasUrl) {
      fail(path, 'configure exactly one transport: "command" (stdio) or "url" (HTTP)')
    }

    if (hasCommand) {
      if (server.command.trim() === '') fail(`${path}.command`, 'cannot be empty')
      if (Object.keys(server.headers).length > 0) {
        fail(`${path}.headers`, 'only HTTP servers may configure headers')
      }
    } else {
      if (server.url.trim() === '') fail(`${path}.url`, 'cannot be empty')
      let url
      try {
        url = new URL(server.url)
      } catch {
        fail(`${path}.url`, 'must be a valid absolute HTTP(S) URL')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fail(`${path}.url`, 'must use http: or https:')
      }
      if (server.args.length > 0) {
        fail(`${path}.args`, 'only stdio servers may configure args')
      }
      if (Object.keys(server.env).length > 0) {
        fail(`${path}.env`, 'only stdio servers may configure env')
      }
    }

    if (server.auth === 'oauth' && !hasUrl) {
      fail(`${path}.auth`, 'OAuth requires the HTTP Transport (url)')
    }
    if (server.scopes.length > 0 && server.auth !== 'oauth') {
      fail(`${path}.scopes`, 'scopes require auth "oauth"')
    }

    if (
      !Number.isFinite(server.idleTimeoutMinutes) ||
      server.idleTimeoutMinutes <= 0
    ) {
      fail(`${path}.idleTimeoutMinutes`, 'must be a positive number')
    }

    const seenTools = new Set()
    for (const toolName of server.promotedTools) {
      if (toolName.trim() === '') {
        fail(`${path}.promotedTools`, 'tool names cannot be empty')
      }
      if (seenTools.has(toolName)) {
        fail(`${path}.promotedTools`, `duplicate tool name ${JSON.stringify(toolName)}`)
      }
      seenTools.add(toolName)
    }
  }
}

/**
 * Register Config while the optional Host settings service exists. The scope
 * belongs to the injected fiber, so provider reload or Adapter disposal removes
 * the namespace and every watcher cleanly.
 */
export function installMcpSettings(ctx, activate) {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      MCP_SETTINGS_NAMESPACE,
      McpSettingsSchema,
      { validate: validateMcpSettings },
    )
    return activate?.(settingsCtx, scope)
  })
}
