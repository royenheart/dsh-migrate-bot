import {
  createMcpCallOutput,
  executeMcpToolCall,
} from './proxy-tool.js'

const PUBLIC_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

function identity(serverName, toolName) {
  return `${serverName}\0${toolName}`
}

export function promotedToolName(serverName, toolName) {
  return `${serverName}__${toolName}`
}

function metadataFingerprint(serverName, tool) {
  return JSON.stringify({
    name: promotedToolName(serverName, tool.name),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  })
}

function catalogFingerprint(manager) {
  return JSON.stringify(
    manager.catalogSnapshot().servers.map((server) => ({
      name: server.name,
      disabled: server.disabled,
      tools: server.tools,
    })),
  )
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createPromotedTool(ctx, manager, serverName, tool) {
  const publicName = promotedToolName(serverName, tool.name)
  return {
    name: publicName,
    description:
      tool.description ??
      `MCP tool ${JSON.stringify(tool.name)} from Server ${JSON.stringify(serverName)}.`,
    parameters: tool.inputSchema,
    output: createMcpCallOutput(),
    execute(args, exec) {
      if (!isRecord(args)) {
        throw new Error(`Promoted MCP tool ${JSON.stringify(publicName)} requires object arguments`)
      }
      return executeMcpToolCall(
        ctx,
        manager,
        serverName,
        tool.name,
        args,
        exec,
        { approvalToolName: publicName },
      )
    },
  }
}

export class McpPromotionRegistry {
  constructor(ctx, manager, settingsScope) {
    this.ctx = ctx
    this.manager = manager
    this.settingsScope = settingsScope
    this.live = new Map()
    this.failures = new Map()
    this.revision = 0
    this.completedRevision = 0
    this.running = undefined
    this.disposed = false
    this.lastCatalog = catalogFingerprint(manager)

    this.unwatchSettings = settingsScope.watch(() => this.requestSync())
    this.unsubscribeManager = manager.subscribe(() => {
      const nextCatalog = catalogFingerprint(manager)
      if (nextCatalog === this.lastCatalog) return
      this.lastCatalog = nextCatalog
      this.requestSync()
    })
    this.requestSync()
  }

  desiredServers() {
    const servers = this.settingsScope.get().mcpServers
    return Object.entries(servers)
      .filter(([, config]) => !config.disabled && config.promotedTools.length > 0)
      .map(([serverName, config]) => ({
        serverName,
        toolNames: [...config.promotedTools].sort(),
      }))
      .sort((left, right) => left.serverName.localeCompare(right.serverName))
  }

  desiredIdentities() {
    return new Set(
      this.desiredServers().flatMap(({ serverName, toolNames }) =>
        toolNames.map((toolName) => identity(serverName, toolName)),
      ),
    )
  }

  isDesired(serverName, toolName) {
    const config = this.settingsScope.get().mcpServers[serverName]
    return (
      config !== undefined &&
      !config.disabled &&
      config.promotedTools.includes(toolName)
    )
  }

  removeEntry(key) {
    const entry = this.live.get(key)
    if (entry === undefined) return
    this.live.delete(key)
    try {
      entry.dispose()
    } catch {
      // Tool disposal is idempotent from the registry's point of view.
    }
  }

  pruneUndesired() {
    const desired = this.desiredIdentities()
    for (const key of this.live.keys()) {
      if (!desired.has(key)) this.removeEntry(key)
    }
  }

  reportFailure(key, message) {
    if (this.failures.get(key) === message) return
    this.failures.set(key, message)
    this.ctx.logger?.warn?.(`dsh-mcp-adapter: ${message}`)
  }

  clearFailure(key) {
    this.failures.delete(key)
  }

  requestSync() {
    if (this.disposed) return
    this.revision += 1
    this.pruneUndesired()
    this.startRun()
  }

  startRun() {
    if (this.disposed || this.running !== undefined) return
    const run = this.runLoop().finally(() => {
      if (this.running === run) this.running = undefined
      if (!this.disposed && this.completedRevision !== this.revision) this.startRun()
    })
    this.running = run
  }

  async runLoop() {
    while (!this.disposed && this.completedRevision !== this.revision) {
      const revision = this.revision
      try {
        await this.syncRevision(revision)
      } catch (error) {
        this.ctx.logger?.error?.(
          `dsh-mcp-adapter: Promotion reconciliation failed: ${String(error)}`,
        )
        this.completedRevision = revision
        return
      }
      this.completedRevision = revision
    }
  }

  async syncRevision(revision) {
    for (const desired of this.desiredServers()) {
      if (this.disposed || revision !== this.revision) return
      await this.syncServer(desired.serverName, desired.toolNames, revision)
    }
  }

  async syncServer(serverName, toolNames, revision) {
    const hasNewPromotion = toolNames.some(
      (toolName) => !this.live.has(identity(serverName, toolName)),
    )
    const cachedTools = this.manager.getCachedTools(serverName)
    let tools
    try {
      tools = hasNewPromotion
        ? await this.manager.listTools(serverName, {
            refresh: cachedTools.length > 0,
          })
        : cachedTools
    } catch (error) {
      for (const toolName of toolNames) {
        this.reportFailure(
          identity(serverName, toolName),
          `could not load Promotion ${JSON.stringify(promotedToolName(serverName, toolName))}: ${String(error)}`,
        )
      }
      return
    }

    if (this.disposed || revision !== this.revision) return
    for (const toolName of toolNames) {
      if (!this.isDesired(serverName, toolName)) continue
      const key = identity(serverName, toolName)
      const tool = tools.find((candidate) => candidate.name === toolName)
      if (tool === undefined) {
        this.removeEntry(key)
        this.reportFailure(
          key,
          `Promotion ${JSON.stringify(promotedToolName(serverName, toolName))} does not match a tool exposed by its Server`,
        )
        continue
      }
      this.register(serverName, tool)
    }
  }

  register(serverName, tool) {
    const key = identity(serverName, tool.name)
    const publicName = promotedToolName(serverName, tool.name)
    if (!PUBLIC_TOOL_NAME.test(publicName)) {
      this.removeEntry(key)
      this.reportFailure(
        key,
        `Promotion name ${JSON.stringify(publicName)} must match ${PUBLIC_TOOL_NAME} for DSH native tools`,
      )
      return
    }

    const fingerprint = metadataFingerprint(serverName, tool)
    const current = this.live.get(key)
    if (current?.fingerprint === fingerprint) {
      this.clearFailure(key)
      return
    }

    const collision = [...this.live.entries()].find(
      ([otherKey, entry]) => otherKey !== key && entry.publicName === publicName,
    )
    if (collision !== undefined) {
      this.removeEntry(key)
      this.reportFailure(
        key,
        `Promotion name ${JSON.stringify(publicName)} collides with another promoted MCP tool`,
      )
      return
    }

    this.removeEntry(key)
    try {
      const dispose = this.ctx.tools.register(
        createPromotedTool(this.ctx, this.manager, serverName, tool),
      )
      this.live.set(key, { dispose, fingerprint, publicName })
      this.clearFailure(key)
    } catch (error) {
      this.reportFailure(
        key,
        `could not register Promotion ${JSON.stringify(publicName)}: ${String(error)}`,
      )
    }
  }

  async settled() {
    while (this.running !== undefined) {
      const running = this.running
      await running
      if (this.running === running) return
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.revision += 1
    this.unwatchSettings?.()
    this.unsubscribeManager?.()
    for (const key of [...this.live.keys()]) this.removeEntry(key)
    await this.running
    this.failures.clear()
  }
}

export function installMcpPromotions(ctx, manager, settingsScope) {
  const registry = new McpPromotionRegistry(ctx, manager, settingsScope)
  ctx.effect(() => () => registry.dispose(), 'dsh-mcp-adapter: Promotion lifecycle')
  return registry
}
