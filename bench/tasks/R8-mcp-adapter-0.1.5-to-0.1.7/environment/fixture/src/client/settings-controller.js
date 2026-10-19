export const MCP_SETTINGS_NAMESPACE = 'mcp'
export const MCP_RPC_CHANNEL = '/mcp-adapter'

const SERVER_FIELDS = new Set([
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function requireStringRecord(value, label) {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${label} must be an object of string values`)
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '' || typeof entry !== 'string') {
      throw new Error(`${label} must contain non-empty keys and string values`)
    }
  }
  return value
}

export function normalizeServerConfig(name, input) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('Server name cannot be empty')
  }
  if (!isRecord(input)) throw new Error(`Server ${JSON.stringify(name)} must be an object`)
  for (const key of Object.keys(input)) {
    if (!SERVER_FIELDS.has(key)) {
      throw new Error(`Server ${JSON.stringify(name)} has unknown field ${JSON.stringify(key)}`)
    }
  }

  const hasCommand = typeof input.command === 'string'
  const hasUrl = typeof input.url === 'string'
  if (hasCommand === hasUrl) {
    throw new Error(`Server ${JSON.stringify(name)} needs exactly one of command or url`)
  }
  if (hasCommand && input.command.trim() === '') {
    throw new Error(`Server ${JSON.stringify(name)} command cannot be empty`)
  }
  if (hasUrl) {
    let url
    try {
      url = new URL(input.url)
    } catch {
      throw new Error(`Server ${JSON.stringify(name)} URL must be absolute`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Server ${JSON.stringify(name)} URL must use HTTP or HTTPS`)
    }
  }

  const args = input.args ?? []
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Server ${JSON.stringify(name)} args must be an array of strings`)
  }
  const env = requireStringRecord(input.env, `Server ${JSON.stringify(name)} env`)
  const headers = requireStringRecord(input.headers, `Server ${JSON.stringify(name)} headers`)
  if (hasCommand && Object.keys(headers).length > 0) {
    throw new Error(`Server ${JSON.stringify(name)} headers require HTTP transport`)
  }
  if (hasUrl && (args.length > 0 || Object.keys(env).length > 0)) {
    throw new Error(`Server ${JSON.stringify(name)} args and env require stdio transport`)
  }

  const idleTimeoutMinutes = input.idleTimeoutMinutes ?? 10
  if (!Number.isFinite(idleTimeoutMinutes) || idleTimeoutMinutes <= 0) {
    throw new Error(`Server ${JSON.stringify(name)} idle timeout must be positive`)
  }

  const auth = input.auth ?? 'headers'
  if (auth !== 'headers' && auth !== 'oauth') {
    throw new Error(`Server ${JSON.stringify(name)} auth must be "headers" or "oauth"`)
  }
  if (auth === 'oauth' && !hasUrl) {
    throw new Error(`Server ${JSON.stringify(name)} OAuth requires the HTTP Transport (url)`)
  }
  const scopes = input.scopes ?? []
  if (
    !Array.isArray(scopes) ||
    scopes.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw new Error(`Server ${JSON.stringify(name)} scopes must be an array of scope strings`)
  }
  if (scopes.length > 0 && auth !== 'oauth') {
    throw new Error(`Server ${JSON.stringify(name)} scopes require OAuth authentication`)
  }

  const promotedTools = input.promotedTools ?? []
  if (
    !Array.isArray(promotedTools) ||
    promotedTools.some((entry) => typeof entry !== 'string' || entry.trim() === '') ||
    new Set(promotedTools).size !== promotedTools.length
  ) {
    throw new Error(`Server ${JSON.stringify(name)} promotedTools must contain unique names`)
  }

  return {
    ...(hasCommand ? { command: input.command.trim(), args, env } : {
      url: input.url.trim(),
      headers,
    }),
    auth,
    scopes,
    disabled: input.disabled === true,
    autoAllow: input.autoAllow === true,
    lifecycle: 'lazy',
    idleTimeoutMinutes,
    promotedTools,
  }
}

/** Parse comma-separated OAuth scope text into a clean string array. */
export function parseScopes(text) {
  return String(text ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export function parseMcpImport(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON: ${messageOf(error)}`)
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error('Import JSON must contain an mcpServers object')
  }
  const servers = {}
  for (const [name, config] of Object.entries(parsed.mcpServers)) {
    servers[name] = normalizeServerConfig(name, config)
  }
  if (Object.keys(servers).length === 0) {
    throw new Error('Import JSON contains no Servers')
  }
  return servers
}

export function parseArgs(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Args must be a JSON array: ${messageOf(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('Args must be a JSON array of strings')
  }
  return parsed
}

export function secretKeysFromView(view, serverName, field) {
  const namespace = view?.namespaces?.find((entry) => entry.ns === MCP_SETTINGS_NAMESPACE)
  if (namespace === undefined) return []
  return namespace.secrets
    .filter(
      (secret) =>
        secret.set === true &&
        secret.path.length === 4 &&
        secret.path[0] === 'mcpServers' &&
        secret.path[1] === serverName &&
        secret.path[2] === field,
    )
    .map((secret) => secret.path[3])
    .sort()
}

export function secretRowOps(serverName, field, rows, existingKeys) {
  const unsetKeys = new Set()
  const sets = []
  const retained = new Set()
  for (const row of rows) {
    const originalKey = typeof row.originalKey === 'string' ? row.originalKey : undefined
    const key = typeof row.key === 'string' ? row.key.trim() : ''
    const value = typeof row.value === 'string' ? row.value : ''
    if (row.removed) {
      if (originalKey !== undefined) unsetKeys.add(originalKey)
      continue
    }
    if (key === '') throw new Error(`${field} keys cannot be empty`)
    if (retained.has(key)) throw new Error(`${field} key ${JSON.stringify(key)} is duplicated`)
    retained.add(key)
    if (originalKey !== undefined && originalKey !== key) {
      unsetKeys.add(originalKey)
      if (value === '') {
        throw new Error(`Enter a new value when renaming secret key ${JSON.stringify(originalKey)}`)
      }
    }
    if (value !== '') {
      sets.push({ op: 'set', path: ['mcpServers', serverName, field, key], value })
    } else if (originalKey === undefined && !existingKeys.includes(key)) {
      throw new Error(`Enter a value for new ${field} key ${JSON.stringify(key)}`)
    }
  }
  for (const key of existingKeys) {
    if (!rows.some((row) => row.originalKey === key || (!row.removed && row.key === key))) {
      unsetKeys.add(key)
    }
  }
  return [
    ...[...unsetKeys].map((key) => ({
      op: 'unset',
      path: ['mcpServers', serverName, field, key],
    })),
    ...sets,
  ]
}

function overviewEmpty() {
  return { status: { servers: [] }, catalog: { servers: [] } }
}

/**
 * Resolve the Config source of one Server from the workspace layer snapshot
 * delivered by the `layers` Connection RPC endpoint. Without a snapshot —
 * for example an older Host — every Server reads as global.
 */
export function serverSource(layers, name) {
  return layers?.source?.[name] === 'workspace' ? 'workspace' : 'global'
}

export class McpSettingsController {
  constructor({ scope, describe, settingsApi, rpc, pollIntervalMs = 3_000 }) {
    this.scope = scope
    this.describe = describe
    this.settingsApi = settingsApi
    this.rpc = rpc
    this.pollIntervalMs = pollIntervalMs
    this.listeners = new Set()
    this.overview = overviewEmpty()
    this.oauthStatuses = {}
    this.actionError = undefined
    this.overviewError = undefined
    this.layers = undefined
    this.pendingWrites = 0
    this.mounted = 0
    this.stopPoll = undefined
    this.loadingOverview = undefined
    this.loadingLayers = undefined
    this.tail = Promise.resolve()
    this.disposed = false
    this.unsubscribeScope = scope.subscribe(() => {
      this.publish()
      if (this.mounted > 0) {
        void this.loadOverview()
        void this.loadLayers()
      }
    })
    this.unsubscribeDescribe = describe.subscribe(() => this.publish())
    this.snapshot = this.projection()

    this.subscribe = (listener) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }
    this.getSnapshot = () => this.snapshot
  }

  projection() {
    return {
      settings: this.scope.getSnapshot(),
      settingsDocument: this.describe.getSnapshot(),
      overview: this.overview,
      layers: this.layers,
      oauthStatuses: this.oauthStatuses,
      error: this.actionError ?? this.overviewError,
      busy: this.pendingWrites > 0,
    }
  }

  publish() {
    this.snapshot = this.projection()
    for (const listener of this.listeners) listener()
  }

  mount() {
    if (this.disposed) return () => {}
    this.mounted += 1
    if (this.mounted === 1) {
      void this.describe.ensure().catch((error) => {
        this.actionError = `Could not load MCP Settings: ${messageOf(error)}`
        this.publish()
      })
      void this.loadOverview()
      void this.loadLayers()
      const id = setInterval(() => {
        void this.loadOverview()
        void this.loadLayers()
      }, this.pollIntervalMs)
      this.stopPoll = () => clearInterval(id)
    }
    return () => {
      this.mounted -= 1
      if (this.mounted === 0) {
        this.stopPoll?.()
        this.stopPoll = undefined
      }
    }
  }

  async loadOverview() {
    if (this.disposed) return
    if (this.loadingOverview !== undefined) return this.loadingOverview
    const request = (async () => {
      try {
        const result = await this.rpc('overview', {})
        if (!result.ok) throw new Error(result.error.message)
        this.overview = result.value
        this.overviewError = undefined
        await this.loadOauthStatuses()
      } catch (error) {
        this.overviewError = `Could not load MCP status: ${messageOf(error)}`
      } finally {
        this.loadingOverview = undefined
        this.publish()
      }
    })()
    this.loadingOverview = request
    return request
  }

  async loadLayers() {
    if (this.disposed) return
    if (this.loadingLayers !== undefined) return this.loadingLayers
    const request = (async () => {
      try {
        const result = await this.rpc('layers', {})
        if (!result.ok) throw new Error(result.error.message)
        this.layers = result.value
      } catch {
        // The layer snapshot is auxiliary; without it every Server reads as global.
        this.layers = undefined
      } finally {
        this.loadingLayers = undefined
        this.publish()
      }
    })()
    this.loadingLayers = request
    return request
  }

  /** Fetch `oauth-status` for every Server configured with OAuth. */
  async loadOauthStatuses() {
    if (this.disposed) return
    // Names come from the merged Config view: the global namespace plus the
    // sanitized workspace layer, so workspace-defined Servers are signable.
    const globalServers = this.scope.getSnapshot().value?.mcpServers ?? {}
    const workspaceServers = this.layers?.servers ?? {}
    const names = new Set()
    for (const [name, config] of Object.entries(globalServers)) {
      if (config?.auth === 'oauth' && typeof config.url === 'string') names.add(name)
    }
    for (const [name, config] of Object.entries(workspaceServers)) {
      if (config?.auth === 'oauth' && typeof config.url === 'string') names.add(name)
    }
    const statuses = {}
    await Promise.all(
      [...names].map(async (name) => {
        try {
          const result = await this.rpc('oauth-status', { server: name })
          if (result.ok) statuses[name] = result.value
        } catch {
          // A failed status probe leaves the Server out of the snapshot.
        }
      }),
    )
    this.oauthStatuses = statuses
    this.publish()
  }

  enqueue(label, operation) {
    this.pendingWrites += 1
    this.actionError = undefined
    this.publish()
    const run = this.tail.then(async () => {
      try {
        await operation()
        await Promise.all([this.loadOverview(), this.loadLayers()])
        return true
      } catch (error) {
        this.actionError = `${label}: ${messageOf(error)}`
        return false
      } finally {
        this.pendingWrites -= 1
        this.publish()
      }
    })
    this.tail = run.then(() => undefined)
    return run
  }

  async settingsWrite(method, input) {
    const revision = this.scope.getSnapshot().revision
    if (revision === undefined) throw new Error('Settings have not loaded yet')
    const response = await this.settingsApi[method]({
      ns: MCP_SETTINGS_NAMESPACE,
      ...input,
      expectedRevision: revision,
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    this.describe.acceptView(response.result.value)
  }

  addServer(name, config) {
    return this.enqueue('Could not add Server', async () => {
      const normalizedName = name.trim()
      const current = this.scope.getSnapshot().value?.mcpServers ?? {}
      if (Object.hasOwn(current, normalizedName)) {
        throw new Error(`Server ${JSON.stringify(normalizedName)} already exists`)
      }
      const server = normalizeServerConfig(normalizedName, config)
      await this.settingsWrite('update', {
        patch: { mcpServers: { [normalizedName]: server } },
      })
    })
  }

  importJson(text) {
    return this.enqueue('Could not import Servers', async () => {
      const servers = parseMcpImport(text)
      const current = this.scope.getSnapshot().value?.mcpServers ?? {}
      const replacesExisting = Object.keys(servers).some((name) => Object.hasOwn(current, name))
      if (!replacesExisting) {
        await this.settingsWrite('update', { patch: { mcpServers: servers } })
        return
      }
      await this.settingsWrite('mutate', {
        ops: Object.entries(servers).map(([name, server]) => ({
          op: 'set',
          path: ['mcpServers', name],
          value: server,
        })),
      })
    })
  }

  deleteServer(name) {
    return this.enqueue('Could not delete Server', () =>
      this.settingsWrite('mutate', {
        ops: [{ op: 'unset', path: ['mcpServers', name] }],
      }),
    )
  }

  setServerField(name, field, value) {
    return this.enqueue(`Could not update ${field}`, () =>
      this.settingsWrite('mutate', {
        ops: [{ op: 'set', path: ['mcpServers', name, field], value }],
      }),
    )
  }

  saveServer(name, draft, secretRows) {
    return this.enqueue('Could not save Server', async () => {
      const existing = this.scope.getSnapshot().value?.mcpServers?.[name]
      if (existing === undefined) throw new Error(`Server ${JSON.stringify(name)} no longer exists`)
      const args = draft.transport === 'stdio' ? parseArgs(draft.argsText) : []
      const scopes = draft.transport === 'http' ? parseScopes(draft.scopesText) : []
      const candidate = normalizeServerConfig(name, {
        ...(draft.transport === 'stdio'
          ? { command: draft.command, args, env: {} }
          : { url: draft.url, headers: {} }),
        auth: draft.transport === 'http' ? (draft.auth ?? 'headers') : 'headers',
        scopes,
        disabled: draft.disabled,
        autoAllow: draft.autoAllow,
        idleTimeoutMinutes: Number(draft.idleTimeoutMinutes),
        promotedTools: existing.promotedTools,
      })
      const ops = [
        { op: 'set', path: ['mcpServers', name, 'disabled'], value: candidate.disabled },
        { op: 'set', path: ['mcpServers', name, 'autoAllow'], value: candidate.autoAllow },
        {
          op: 'set',
          path: ['mcpServers', name, 'idleTimeoutMinutes'],
          value: candidate.idleTimeoutMinutes,
        },
        { op: 'set', path: ['mcpServers', name, 'auth'], value: candidate.auth },
        { op: 'set', path: ['mcpServers', name, 'scopes'], value: candidate.scopes },
      ]
      if (draft.transport === 'stdio') {
        ops.push(
          { op: 'set', path: ['mcpServers', name, 'command'], value: candidate.command },
          { op: 'set', path: ['mcpServers', name, 'args'], value: candidate.args },
          { op: 'unset', path: ['mcpServers', name, 'url'] },
          { op: 'unset', path: ['mcpServers', name, 'headers'] },
          ...secretRowOps(name, 'env', secretRows, secretKeysFromView(
            this.describe.getSnapshot().view,
            name,
            'env',
          )),
        )
      } else {
        ops.push(
          { op: 'set', path: ['mcpServers', name, 'url'], value: candidate.url },
          { op: 'unset', path: ['mcpServers', name, 'command'] },
          { op: 'unset', path: ['mcpServers', name, 'args'] },
          { op: 'unset', path: ['mcpServers', name, 'env'] },
          ...secretRowOps(name, 'headers', secretRows, secretKeysFromView(
            this.describe.getSnapshot().view,
            name,
            'headers',
          )),
        )
      }
      await this.settingsWrite('mutate', { ops })
    })
  }

  togglePromotion(name, toolName) {
    const tools = this.scope.getSnapshot().value?.mcpServers?.[name]?.promotedTools ?? []
    const next = tools.includes(toolName)
      ? tools.filter((entry) => entry !== toolName)
      : [...tools, toolName]
    return this.setServerField(name, 'promotedTools', next)
  }

  reconnect(name) {
    return this.enqueue('Could not reconnect Server', async () => {
      const result = await this.rpc('reconnect', { server: name })
      if (!result.ok) {
        await this.loadOverview()
        throw new Error(result.error.message)
      }
      this.overview = result.value
    })
  }

  /**
   * Start the OAuth flow for one Server. Resolves with the RPC value
   * (`{ authorizationUrl }`); the caller opens the URL in the browser.
   */
  async signIn(name) {
    this.pendingWrites += 1
    this.actionError = undefined
    this.publish()
    try {
      const result = await this.rpc('oauth-login', { server: name })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    } catch (error) {
      this.actionError = `Could not start sign-in: ${messageOf(error)}`
      return undefined
    } finally {
      this.pendingWrites -= 1
      this.publish()
    }
  }

  signOut(name) {
    return this.enqueue('Could not sign out', async () => {
      const result = await this.rpc('oauth-logout', { server: name })
      if (!result.ok) throw new Error(result.error.message)
    })
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stopPoll?.()
    this.unsubscribeScope?.()
    this.unsubscribeDescribe?.()
    await this.tail
    this.listeners.clear()
  }
}
