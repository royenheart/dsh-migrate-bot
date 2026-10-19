import assert from 'node:assert/strict'
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

  async replace(value) {
    this.value = structuredClone(value)
    await Promise.all(
      [...this.watchers].map((watcher) => watcher(structuredClone(this.value))),
    )
  }
}

class ManualScheduler {
  tasks = []

  schedule(callback, delay) {
    const task = { callback, delay, active: true }
    this.tasks.push(task)
    return () => {
      task.active = false
    }
  }

  async runNext() {
    const task = this.tasks.find((candidate) => candidate.active)
    assert.ok(task, 'expected one active scheduled callback')
    task.active = false
    await task.callback()
  }

  active() {
    return this.tasks.filter((task) => task.active)
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

// A restart means fresh McpClientManager and McpPromotionRegistry instances:
// no in-memory tool cache exists, only the persisted Config with promotedTools.
function restartedStack(scope) {
  const connectedNames = []
  const connections = []
  const toolsByName = {
    promoted: [{
      name: 'ping',
      description: 'Rebuilt from the live Server',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    }],
  }
  const connectionFactory = async (name, _config, callbacks) => {
    connectedNames.push(name)
    const connection = {
      callbacks,
      closed: false,
      transportType: 'test',
      client: {
        async listTools() {
          return { tools: structuredClone(toolsByName[name] ?? []) }
        },
      },
      async close() {
        connection.closed = true
        callbacks.onClose?.()
      },
    }
    connections.push(connection)
    return connection
  }
  const scheduler = new ManualScheduler()
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory,
  })
  return { connectedNames, connections, scheduler, manager }
}

test('a persisted Promotion connects once at startup, registers natively, then idles', async (t) => {
  const scope = new MemoryScope({
    mcpServers: {
      promoted: serverConfig({ promotedTools: ['ping'] }),
      plain: serverConfig(),
    },
  })
  const { connectedNames, connections, scheduler, manager } = restartedStack(scope)
  const tools = toolRegistry()
  const registry = new McpPromotionRegistry(
    { tools, logger: { warn() {} }, get() {} },
    manager,
    scope,
  )
  t.after(async () => {
    await registry.dispose()
    await manager.dispose()
  })

  await registry.settled()

  // (a) The Server with a persisted Promotion connects during the registry's
  // initial sync; the fake connection's listTools fills the metadata cache.
  assert.deepEqual(connectedNames, ['promoted'])
  assert.equal(connections.length, 1)
  assert.deepEqual(
    manager.getCachedTools('promoted').map((tool) => tool.name),
    ['ping'],
  )

  // (b) The native promoted tool is registered with the MCP input schema.
  const definition = tools.definitions.get('promoted__ping')
  assert.ok(definition)
  assert.equal(definition.description, 'Rebuilt from the live Server')
  assert.deepEqual(definition.parameters, {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  })

  // (c) A Server without Promotions does not connect at startup.
  assert.equal(connectedNames.includes('plain'), false)
  assert.deepEqual(
    manager.statusSnapshot().servers.find((server) => server.name === 'plain'),
    { name: 'plain', state: 'disconnected', toolCount: 0 },
  )

  // (d) The startup connection follows the normal Lazy Lifecycle idle
  // schedule and closes through it.
  const idleTasks = scheduler.active()
  assert.equal(idleTasks.length, 1)
  assert.equal(idleTasks[0].delay, 600_000)
  await scheduler.runNext()
  assert.equal(connections[0].closed, true)
  assert.equal(
    manager.statusSnapshot().servers.find((server) => server.name === 'promoted').state,
    'disconnected',
  )

  // The rebuilt native tool outlives the idle disconnect.
  assert.ok(tools.definitions.has('promoted__ping'))
})

test('re-enabling a Server with a persisted Promotion reconnects it once', async (t) => {
  const scope = new MemoryScope({
    mcpServers: {
      promoted: serverConfig({ promotedTools: ['ping'], disabled: true }),
    },
  })
  const { connectedNames, connections, scheduler, manager } = restartedStack(scope)
  const tools = toolRegistry()
  const registry = new McpPromotionRegistry(
    { tools, logger: { warn() {} }, get() {} },
    manager,
    scope,
  )
  t.after(async () => {
    await registry.dispose()
    await manager.dispose()
  })

  await registry.settled()

  // A disabled Server connects nowhere at startup.
  assert.deepEqual(connectedNames, [])
  assert.equal(tools.definitions.size, 0)

  // Re-enable runs the same Promotion discovery through the settings watch:
  // exactly one connect rebuilds the native input schema, then the normal
  // idle schedule applies.
  await scope.replace({
    mcpServers: {
      promoted: serverConfig({ promotedTools: ['ping'] }),
    },
  })
  await registry.settled()

  assert.deepEqual(connectedNames, ['promoted'])
  assert.equal(connections.length, 1)
  assert.ok(tools.definitions.get('promoted__ping'))

  const idleTasks = scheduler.active()
  assert.equal(idleTasks.length, 1)
  assert.equal(idleTasks[0].delay, 600_000)
  await scheduler.runNext()
  assert.equal(connections[0].closed, true)
  assert.ok(tools.definitions.has('promoted__ping'))
})
