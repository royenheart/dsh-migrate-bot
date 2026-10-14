import {
  REQUEST_TIMEOUT_MS,
  createMcpConnection,
} from './mcp-connection.js'

export const KEEP_ALIVE_RETRY_MS = 30_000

const EAGER_LIFECYCLES = new Set(['eager', 'keep-alive'])
const KEEP_ALIVE_LIFECYCLES = new Set(['keep-alive', 'lazy-keep-alive'])

function connectsAtStartup(lifecycle) {
  return EAGER_LIFECYCLES.has(lifecycle)
}

function isKeepAlive(lifecycle) {
  return KEEP_ALIVE_LIFECYCLES.has(lifecycle)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

function waitWithSignal(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function cloneJson(value) {
  return structuredClone(value)
}

function equalJson(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((item, index) => equalJson(item, right[index]))
  }
  if (typeof left !== 'object') return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && equalJson(left[key], right[key]),
    )
  )
}

function normalizeTool(tool) {
  return cloneJson({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  })
}

function connectionConfig(config) {
  return {
    command: config.command,
    args: config.args,
    env: config.env,
    url: config.url,
    headers: config.headers,
    auth: config.auth,
    scopes: config.scopes,
    disabled: config.disabled,
    lifecycle: config.lifecycle,
  }
}

function initialState(config) {
  return config.disabled ? 'disabled' : 'disconnected'
}

function createRecord(name, config) {
  return {
    name,
    config,
    state: initialState(config),
    message: undefined,
    transportType: undefined,
    tools: [],
    connection: undefined,
    connectPromise: undefined,
    connectAbort: undefined,
    generation: 0,
    activeCalls: 0,
    cancelIdle: undefined,
    cancelReconnect: undefined,
    lastUsedAt: undefined,
  }
}

/**
 * Host owner for MCP connections and cached tool metadata.
 *
 * The manager does not expose SDK Client or Transport instances. Consumers get
 * detached JSON snapshots and call through manager methods, so live Host data
 * never crosses the client RPC boundary by accident.
 */
export class McpClientManager {
  constructor(
    settingsScope,
    {
      connectionFactory = createMcpConnection,
      schedule,
      now = Date.now,
    } = {},
  ) {
    if (typeof schedule !== 'function') {
      throw new TypeError('McpClientManager requires a lifecycle-owned schedule(callback, delay)')
    }

    this.settingsScope = settingsScope
    this.connectionFactory = connectionFactory
    this.schedule = schedule
    this.now = now
    this.records = new Map()
    this.listeners = new Set()
    this.disposed = false

    this.installConfig(settingsScope.get())
    this.scheduleStartupConnects()
    this.unwatch = settingsScope.watch((next) => this.reconcile(next))
  }

  installConfig(settings) {
    for (const [name, config] of Object.entries(settings.mcpServers)) {
      this.records.set(name, createRecord(name, config))
    }
  }

  async reconcile(settings) {
    if (this.disposed) return
    const nextServers = settings.mcpServers

    for (const [name, record] of [...this.records]) {
      const next = nextServers[name]
      if (next === undefined) {
        await this.closeRecord(record, 'removed')
        this.records.delete(name)
        continue
      }
      if (!equalJson(record.config, next)) {
        const mustReconnect = !equalJson(
          connectionConfig(record.config),
          connectionConfig(next),
        )
        const idleTimeoutChanged =
          record.config.idleTimeoutMinutes !== next.idleTimeoutMinutes
        if (mustReconnect) {
          await this.closeRecord(record, 'changed')
          record.state = initialState(next)
          record.message = undefined
          record.transportType = undefined
          record.tools = []
        }
        record.config = next
        if (!mustReconnect && idleTimeoutChanged) this.scheduleIdle(record)
        if (mustReconnect) this.scheduleStartupConnect(record)
      }
    }

    for (const [name, config] of Object.entries(nextServers)) {
      if (!this.records.has(name)) {
        const record = createRecord(name, config)
        this.records.set(name, record)
        this.scheduleStartupConnect(record)
      }
    }

    this.emit()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    const snapshot = this.statusSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Status observers cannot break connection ownership.
      }
    }
  }

  requireRecord(name) {
    const record = this.records.get(name)
    if (record === undefined) throw new Error(`Unknown MCP server ${JSON.stringify(name)}`)
    if (record.config.disabled) throw new Error(`MCP server ${JSON.stringify(name)} is disabled`)
    return record
  }

  getServerConfig(name) {
    const record = this.records.get(name)
    return record === undefined ? undefined : cloneJson(record.config)
  }

  getCachedTools(name) {
    const record = this.records.get(name)
    return record === undefined ? [] : cloneJson(record.tools)
  }

  statusSnapshot() {
    return {
      servers: [...this.records.values()].map((record) => ({
        name: record.name,
        state: record.state,
        ...(record.message === undefined ? {} : { message: record.message }),
        ...(record.transportType === undefined
          ? {}
          : { transport: record.transportType }),
        toolCount: record.tools.length,
        ...(record.lastUsedAt === undefined
          ? {}
          : { lastUsedAt: record.lastUsedAt }),
      })),
    }
  }

  catalogSnapshot() {
    return {
      servers: [...this.records.values()].map((record) => ({
        name: record.name,
        disabled: record.config.disabled,
        state: record.state,
        tools: cloneJson(record.tools),
      })),
    }
  }

  setState(record, state, message) {
    record.state = state
    record.message = message
    this.emit()
  }

  cancelIdle(record) {
    record.cancelIdle?.()
    record.cancelIdle = undefined
  }

  scheduleIdle(record) {
    this.cancelIdle(record)
    if (isKeepAlive(record.config.lifecycle)) return
    if (
      this.disposed ||
      record.connection === undefined ||
      record.activeCalls > 0
    ) {
      return
    }

    const delay = record.config.idleTimeoutMinutes * 60_000
    record.cancelIdle = this.schedule(async () => {
      record.cancelIdle = undefined
      if (record.activeCalls > 0) {
        this.scheduleIdle(record)
        return
      }
      await this.disconnect(record.name, 'idle timeout')
    }, delay)
  }

  touch(record) {
    record.lastUsedAt = this.now()
    this.scheduleIdle(record)
  }

  cancelReconnect(record) {
    record.cancelReconnect?.()
    record.cancelReconnect = undefined
  }

  /**
   * Eager and keep-alive Servers connect without a user request. Connects run
   * through the fiber-owned schedule so construction and reconcile never block;
   * ensureConnection already records failures on the record's error state.
   */
  scheduleStartupConnects() {
    for (const record of this.records.values()) this.scheduleStartupConnect(record)
  }

  scheduleStartupConnect(record) {
    if (this.disposed || record.config.disabled) return
    if (!connectsAtStartup(record.config.lifecycle)) return
    if (record.connection !== undefined || record.connectPromise !== undefined) return
    this.schedule(async () => {
      if (this.disposed || record.config.disabled) return
      if (record.connection !== undefined || record.connectPromise !== undefined) return
      await this.ensureConnection(record, undefined).catch(() => {
        // Error state is already recorded; keep-alive retries via onClose.
      })
    }, 0)
  }

  /**
   * Keep-alive Servers reconnect KEEP_ALIVE_RETRY_MS after an unexpected close
   * and keep retrying while the guards hold. Closes initiated by the manager
   * (config change, disable, removal, dispose) bump the generation, so their
   * onClose callbacks never reach this path; closeRecord also cancels any
   * pending timer explicitly.
   */
  scheduleReconnect(record) {
    if (this.disposed || record.config.disabled) return
    if (!isKeepAlive(record.config.lifecycle)) return
    if (record.connection !== undefined || record.connectPromise !== undefined) return
    this.cancelReconnect(record)
    record.cancelReconnect = this.schedule(async () => {
      record.cancelReconnect = undefined
      if (this.disposed || record.config.disabled) return
      if (record.connection !== undefined || record.connectPromise !== undefined) return
      try {
        await this.ensureConnection(record, undefined)
      } catch {
        this.scheduleReconnect(record)
      }
    }, KEEP_ALIVE_RETRY_MS)
  }

  callbacksFor(record, generation) {
    return {
      onToolsChanged: (error, tools) => {
        if (record.generation !== generation || this.disposed) return
        if (error !== null) {
          this.setState(record, 'error', `Tool list refresh failed: ${errorMessage(error)}`)
          return
        }
        if (tools !== null) {
          record.tools = tools.map(normalizeTool)
          record.message = undefined
          if (record.connection !== undefined) record.state = 'connected'
          this.emit()
        }
      },
      onError: (error) => {
        if (record.generation !== generation || this.disposed) return
        this.setState(record, 'error', errorMessage(error))
      },
      onClose: () => {
        if (record.generation !== generation || this.disposed) return
        record.connection = undefined
        record.transportType = undefined
        this.cancelIdle(record)
        this.setState(record, 'disconnected', 'Connection closed')
        this.scheduleReconnect(record)
      },
    }
  }

  async ensureConnection(record, signal) {
    if (record.connection !== undefined) return record.connection
    if (record.connectPromise !== undefined) {
      return waitWithSignal(record.connectPromise, signal)
    }

    const generation = ++record.generation
    const controller = new AbortController()
    record.connectAbort = controller
    this.setState(record, 'connecting')

    const promise = (async () => {
      let connection
      try {
        connection = await this.connectionFactory(
          record.name,
          record.config,
          this.callbacksFor(record, generation),
          controller.signal,
        )

        if (
          this.disposed ||
          record.generation !== generation ||
          record.config.disabled
        ) {
          throw new Error(`MCP server ${JSON.stringify(record.name)} changed while connecting`)
        }

        record.connection = connection
        record.transportType = connection.transportType
        record.state = 'connected'
        record.message = undefined

        const listed = await connection.client.listTools(undefined, {
          signal: controller.signal,
          timeout: REQUEST_TIMEOUT_MS,
        })
        record.tools = listed.tools.map(normalizeTool)
        this.touch(record)
        this.emit()
        return connection
      } catch (error) {
        if (connection !== undefined) await connection.close()
        if (record.generation === generation && !this.disposed) {
          record.connection = undefined
          record.transportType = undefined
          this.setState(record, 'error', errorMessage(error))
        }
        throw error
      } finally {
        if (record.generation === generation) record.connectAbort = undefined
      }
    })()

    record.connectPromise = promise
    const clearPromise = () => {
      if (record.connectPromise === promise) record.connectPromise = undefined
    }
    promise.then(clearPromise, clearPromise)
    return waitWithSignal(promise, signal)
  }

  async withConnection(name, signal, operation) {
    if (signal?.aborted) throw abortError(signal)
    const record = this.requireRecord(name)
    record.activeCalls += 1
    this.cancelIdle(record)
    try {
      const connection = await this.ensureConnection(record, signal)
      return await operation(connection, record)
    } finally {
      record.activeCalls -= 1
      this.touch(record)
    }
  }

  async listTools(name, { refresh = false, signal } = {}) {
    return this.withConnection(name, signal, async (connection, record) => {
      if (refresh) {
        const listed = await connection.client.listTools(undefined, {
          signal,
          timeout: REQUEST_TIMEOUT_MS,
        })
        record.tools = listed.tools.map(normalizeTool)
        this.emit()
      }
      return cloneJson(record.tools)
    })
  }

  async callTool(name, toolName, args = {}, { signal } = {}) {
    return this.withConnection(name, signal, async (connection) => {
      return connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal, timeout: REQUEST_TIMEOUT_MS },
      )
    })
  }

  // Resources and prompts are never cached: every method below connects
  // lazily and hits the live Server, so results always reflect the Server's
  // current state. The tool metadata cache is untouched by these methods.

  async listResources(name, { signal } = {}) {
    return this.withConnection(name, signal, async (connection) => {
      return cloneJson(
        await connection.client.listResources(undefined, {
          signal,
          timeout: REQUEST_TIMEOUT_MS,
        }),
      )
    })
  }

  async readResource(name, uri, { signal } = {}) {
    return this.withConnection(name, signal, async (connection) => {
      return cloneJson(
        await connection.client.readResource({ uri }, {
          signal,
          timeout: REQUEST_TIMEOUT_MS,
        }),
      )
    })
  }

  async listTemplates(name, { signal } = {}) {
    return this.withConnection(name, signal, async (connection) => {
      return cloneJson(
        await connection.client.listResourceTemplates(undefined, {
          signal,
          timeout: REQUEST_TIMEOUT_MS,
        }),
      )
    })
  }

  async listPrompts(name, { signal } = {}) {
    return this.withConnection(name, signal, async (connection) => {
      return cloneJson(
        await connection.client.listPrompts(undefined, {
          signal,
          timeout: REQUEST_TIMEOUT_MS,
        }),
      )
    })
  }

  async getPrompt(name, promptName, args = {}, { signal } = {}) {
    return this.withConnection(name, signal, async (connection) => {
      return cloneJson(
        await connection.client.getPrompt(
          { name: promptName, arguments: args },
          { signal, timeout: REQUEST_TIMEOUT_MS },
        ),
      )
    })
  }

  async disconnect(name, reason = 'disconnected') {
    const record = this.records.get(name)
    if (record === undefined) return false
    await this.closeRecord(record, reason)
    if (record.config.disabled) {
      this.setState(record, 'disabled')
    } else {
      this.setState(record, 'disconnected')
    }
    return true
  }

  async closeRecord(record) {
    record.generation += 1
    this.cancelIdle(record)
    this.cancelReconnect(record)
    record.connectAbort?.abort()
    record.connectAbort = undefined
    const connection = record.connection
    const connecting = record.connectPromise
    record.connection = undefined
    record.connectPromise = undefined
    record.transportType = undefined
    if (connection !== undefined) await connection.close()
    if (connecting !== undefined) await connecting.catch(() => undefined)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.unwatch?.()
    await Promise.all([...this.records.values()].map((record) => this.closeRecord(record)))
    this.listeners.clear()
  }
}

export const MCP_RPC_CHANNEL = '/mcp-adapter'

export function installMcpManagerRpc(ctx, manager, options = {}) {
  const layerSnapshot = options.layerSnapshot
  const oauth = options.oauth
  // Every response envelope must satisfy the platform's client-side RpcError
  // schema: `bad-request` carries `details: { issues: [] }`, every other
  // failure uses `internal` with empty `details`. A custom code passes the
  // host, but the Client rejects the whole result with a schema error and the
  // real message never reaches the UI.
  ctx.connection.rpc.handle(
    MCP_RPC_CHANNEL,
    async (endpoint, payload, signal) => {
      if (endpoint === 'status') {
        return { ok: true, value: manager.statusSnapshot() }
      }
      if (endpoint === 'catalog') {
        return { ok: true, value: manager.catalogSnapshot() }
      }
      if (endpoint === 'overview') {
        return {
          ok: true,
          value: {
            status: manager.statusSnapshot(),
            catalog: manager.catalogSnapshot(),
          },
        }
      }
      if (endpoint === 'layers') {
        if (typeof layerSnapshot !== 'function') {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'The MCP workspace layer snapshot is unavailable.',
              details: { issues: [] },
            },
          }
        }
        // The snapshot may be async (the wiring refreshes the workspace layer
        // first, which gives the layers poll a real refresh path).
        return { ok: true, value: await layerSnapshot() }
      }
      if (endpoint === 'oauth-login' || endpoint === 'oauth-logout' || endpoint === 'oauth-status') {
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload) ||
          typeof payload.server !== 'string' ||
          payload.server.trim() === ''
        ) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'OAuth endpoints require a non-empty Server name.',
              details: { issues: [] },
            },
          }
        }
        if (oauth === undefined) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: 'OAuth support is not available on this Adapter',
              details: {},
            },
          }
        }
        const serverName = payload.server.trim()
        try {
          if (endpoint === 'oauth-login') {
            return { ok: true, value: await oauth.startLogin(serverName) }
          }
          if (endpoint === 'oauth-logout') {
            return { ok: true, value: await oauth.logout(serverName) }
          }
          return { ok: true, value: await oauth.status(serverName) }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: errorMessage(error),
              details: {},
            },
          }
        }
      }
      if (endpoint === 'reconnect') {
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload) ||
          typeof payload.server !== 'string' ||
          payload.server.trim() === ''
        ) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'Reconnect requires a non-empty Server name.',
              details: { issues: [] },
            },
          }
        }
        const serverName = payload.server.trim()
        try {
          await manager.disconnect(serverName, 'manual reconnect')
          await manager.listTools(serverName, { signal })
          return {
            ok: true,
            value: {
              status: manager.statusSnapshot(),
              catalog: manager.catalogSnapshot(),
            },
          }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: errorMessage(error),
              details: {},
            },
          }
        }
      }
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: `Unknown MCP Adapter endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        },
      }
    },
    { authority: 'trusted-host' },
  )
}

export function installMcpManager(ctx, settingsScope, options = {}) {
  const manager = new McpClientManager(settingsScope, {
    schedule: (callback, delay) => ctx.timeout(callback, delay),
    ...options,
  })
  ctx.provide('mcpManager', manager)
  ctx.effect(() => () => manager.dispose(), 'dsh-mcp-adapter: manager lifecycle')
  return manager
}
