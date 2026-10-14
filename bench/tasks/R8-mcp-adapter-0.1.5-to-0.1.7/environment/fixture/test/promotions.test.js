import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { McpClientManager } from '../src/host/manager.js'
import { McpPromotionRegistry } from '../src/host/promotions.js'

function serverConfig(overrides = {}) {
  return {
    command: process.execPath,
    args: [],
    env: {},
    headers: {},
    disabled: false,
    autoAllow: false,
    lifecycle: 'lazy',
    idleTimeoutMinutes: 10,
    promotedTools: [],
    ...overrides,
  }
}

class MemoryScope {
  constructor(value) {
    this.value = structuredClone(value)
    this.watchers = new Set()
  }

  get() {
    return structuredClone(this.value)
  }

  watch(callback) {
    this.watchers.add(callback)
    return () => this.watchers.delete(callback)
  }

  async update(value) {
    this.value = structuredClone(value)
    await Promise.all([...this.watchers].map((watcher) => watcher(this.get())))
  }
}

function toolRegistry() {
  const definitions = new Map()
  return {
    definitions,
    register(definition) {
      if (definitions.has(definition.name)) {
        throw new Error(`Tool ${definition.name} is already registered`)
      }
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) {
          definitions.delete(definition.name)
        }
      }
    },
  }
}

function execution() {
  return {
    name: 'fixture__ping',
    callId: 'promoted-call-1',
    signal: new AbortController().signal,
    agent: { session: { header: { id: 'session-1' } } },
  }
}

test('Promotion toggles a native tool and keeps approval and output guarding', async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url))
  const promoted = serverConfig({ args: [fixture], promotedTools: ['ping'] })
  const scope = new MemoryScope({ mcpServers: { fixture: promoted } })
  const manager = new McpClientManager(scope, { schedule: () => () => {} })
  const tools = toolRegistry()
  const approvalRequests = []
  const ctx = {
    tools,
    logger: { warn() {} },
    get(name) {
      if (name === 'approval') {
        return {
          async request(request) {
            approvalRequests.push(request)
            return 'allowed-once'
          },
        }
      }
      return undefined
    },
  }
  const registry = new McpPromotionRegistry(ctx, manager, scope)
  t.after(async () => {
    await registry.dispose()
    await manager.dispose()
  })
  await registry.settled()

  const definition = tools.definitions.get('fixture__ping')
  assert.ok(definition)
  assert.deepEqual(definition.parameters, {
    type: 'object',
    properties: {},
  })

  const result = await definition.execute({}, execution())
  assert.equal(result.text, 'pong')
  assert.equal(approvalRequests.length, 1)
  assert.equal(approvalRequests[0].toolName, 'fixture__ping')

  await scope.update({
    mcpServers: { fixture: { ...promoted, promotedTools: [] } },
  })
  await registry.settled()
  assert.equal(tools.definitions.has('fixture__ping'), false)

  await scope.update({ mcpServers: { fixture: promoted } })
  await registry.settled()
  assert.equal(tools.definitions.has('fixture__ping'), true)

  await registry.dispose()
  assert.equal(tools.definitions.size, 0)
  await manager.dispose()
})

test('Promotion follows MCP tool metadata changes', async () => {
  const scope = new MemoryScope({
    mcpServers: { fixture: serverConfig({ promotedTools: ['ping'] }) },
  })
  const tools = toolRegistry()
  const listeners = new Set()
  let catalogTools = [{
    name: 'ping',
    description: 'First description',
    inputSchema: { type: 'object' },
  }]
  const manager = {
    catalogSnapshot() {
      return {
        servers: [{
          name: 'fixture',
          disabled: false,
          tools: structuredClone(catalogTools),
        }],
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getCachedTools() {
      return structuredClone(catalogTools)
    },
    async listTools() {
      return structuredClone(catalogTools)
    },
    setTools(next) {
      catalogTools = structuredClone(next)
      for (const listener of listeners) listener()
    },
  }
  const registry = new McpPromotionRegistry(
    { tools, logger: { warn() {} }, get() {} },
    manager,
    scope,
  )
  await registry.settled()
  assert.equal(tools.definitions.get('fixture__ping').description, 'First description')

  manager.setTools([{
    name: 'ping',
    description: 'Updated description',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }])
  await registry.settled()
  assert.equal(tools.definitions.get('fixture__ping').description, 'Updated description')

  manager.setTools([])
  await registry.settled()
  assert.equal(tools.definitions.has('fixture__ping'), false)
  await registry.dispose()
})

test('non-promoted tools do not enter the native registry', async () => {
  const scope = new MemoryScope({
    mcpServers: { fixture: serverConfig() },
  })
  const tools = toolRegistry()
  const manager = {
    catalogSnapshot() {
      return { servers: [{ name: 'fixture', disabled: false, tools: [] }] }
    },
    subscribe() {
      return () => {}
    },
    getCachedTools() {
      return []
    },
  }
  const registry = new McpPromotionRegistry(
    { tools, logger: { warn() {} }, get() {} },
    manager,
    scope,
  )
  await registry.settled()
  assert.equal(tools.definitions.size, 0)
  await registry.dispose()
})
