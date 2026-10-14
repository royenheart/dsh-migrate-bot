import assert from 'node:assert/strict'
import test from 'node:test'

import { KEEP_ALIVE_RETRY_MS, McpClientManager } from '../src/host/manager.js'

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
    const previous = this.value
    this.value = structuredClone(value)
    for (const callback of this.watchers) {
      await callback(structuredClone(this.value), structuredClone(previous))
    }
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

function fakeConnectionFactory(initialTools) {
  const connections = []
  const factory = async (_name, _config, callbacks) => {
    const connection = {
      callbacks,
      closed: false,
      transportType: 'test',
      client: {
        async listTools() {
          return { tools: initialTools }
        },
        async callTool({ name, arguments: args }) {
          return { content: [{ type: 'text', text: `${name}:${args.value}` }] }
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
  return { factory, connections }
}

test('eager Server connects at startup without a user request', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'eager' }) },
  })
  const scheduler = new ManualScheduler()
  const fake = fakeConnectionFactory([{ name: 'alpha', inputSchema: { type: 'object' } }])
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: fake.factory,
  })

  // Construction schedules the connect; it never blocks on it.
  assert.equal(fake.connections.length, 0)
  assert.equal(scheduler.active().length, 1)
  assert.equal(scheduler.active()[0].delay, 0)

  await scheduler.runNext()
  assert.equal(fake.connections.length, 1)
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')
  assert.deepEqual(manager.getCachedTools('demo').map((tool) => tool.name), ['alpha'])

  await manager.dispose()
})

test('eager Server still idles out after startup connect', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'eager' }) },
  })
  const scheduler = new ManualScheduler()
  const fake = fakeConnectionFactory([])
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: fake.factory,
  })

  await scheduler.runNext()
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')
  assert.equal(scheduler.active().length, 1)
  assert.equal(scheduler.active()[0].delay, 600_000)

  await scheduler.runNext()
  assert.equal(fake.connections[0].closed, true)
  assert.equal(manager.statusSnapshot().servers[0].state, 'disconnected')
  assert.equal(scheduler.active().length, 0)

  await manager.dispose()
})

test('keep-alive Server connects at startup and never schedules idle', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'keep-alive' }) },
  })
  const scheduler = new ManualScheduler()
  const fake = fakeConnectionFactory([])
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: fake.factory,
  })

  await scheduler.runNext()
  assert.equal(fake.connections.length, 1)
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')
  assert.deepEqual(scheduler.active(), [])

  await manager.dispose()
})

test('lazy-keep-alive Server waits for first use and never schedules idle', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'lazy-keep-alive' }) },
  })
  const scheduler = new ManualScheduler()
  const fake = fakeConnectionFactory([])
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: fake.factory,
  })

  assert.equal(fake.connections.length, 0)
  assert.deepEqual(scheduler.active(), [])

  await manager.listTools('demo')
  assert.equal(fake.connections.length, 1)
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')
  assert.deepEqual(scheduler.active(), [])

  await manager.dispose()
})

test('unexpected close on a keep-alive Server reconnects after 30 seconds', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'keep-alive' }) },
  })
  const scheduler = new ManualScheduler()
  const fake = fakeConnectionFactory([])
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: fake.factory,
  })

  await scheduler.runNext()
  fake.connections[0].callbacks.onClose()
  assert.equal(manager.statusSnapshot().servers[0].state, 'disconnected')
  assert.equal(scheduler.active().length, 1)
  assert.equal(scheduler.active()[0].delay, KEEP_ALIVE_RETRY_MS)

  await scheduler.runNext()
  assert.equal(fake.connections.length, 2)
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')

  await manager.dispose()
})

test('failed keep-alive reconnects keep retrying every 30 seconds', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'keep-alive' }) },
  })
  const scheduler = new ManualScheduler()
  let attempt = 0
  const connections = []
  const factory = async (_name, _config, callbacks) => {
    attempt += 1
    if (attempt === 2) throw new Error('reconnect refused')
    const connection = {
      callbacks,
      closed: false,
      transportType: 'test',
      client: { async listTools() { return { tools: [] } } },
      async close() {
        connection.closed = true
        callbacks.onClose?.()
      },
    }
    connections.push(connection)
    return connection
  }
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: factory,
  })

  await scheduler.runNext()
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')

  connections[0].callbacks.onClose()
  await scheduler.runNext()
  assert.equal(manager.statusSnapshot().servers[0].state, 'error')
  assert.equal(manager.statusSnapshot().servers[0].message, 'reconnect refused')

  // The failed attempt rearms the retry timer.
  assert.equal(scheduler.active().length, 1)
  assert.equal(scheduler.active()[0].delay, KEEP_ALIVE_RETRY_MS)

  await scheduler.runNext()
  assert.equal(attempt, 3)
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')

  await manager.dispose()
})

test('disabling a keep-alive Server cancels its pending reconnect', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'keep-alive' }) },
  })
  const scheduler = new ManualScheduler()
  const fake = fakeConnectionFactory([])
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: fake.factory,
  })

  await scheduler.runNext()
  fake.connections[0].callbacks.onClose()
  assert.equal(scheduler.active().length, 1)

  await scope.replace({
    mcpServers: { demo: serverConfig({ lifecycle: 'keep-alive', disabled: true }) },
  })
  // The reconnect timer is gone and the disabled Server never reconnects.
  assert.deepEqual(scheduler.active(), [])
  assert.equal(manager.statusSnapshot().servers[0].state, 'disabled')

  await manager.dispose()
})

test('Config change on an eager Server closes and reconnects', async () => {
  const scope = new MemoryScope({
    mcpServers: { demo: serverConfig({ lifecycle: 'eager', args: ['first'] }) },
  })
  const scheduler = new ManualScheduler()
  const fake = fakeConnectionFactory([])
  const manager = new McpClientManager(scope, {
    schedule: scheduler.schedule.bind(scheduler),
    connectionFactory: fake.factory,
  })

  await scheduler.runNext()
  assert.equal(fake.connections.length, 1)

  await scope.replace({
    mcpServers: { demo: serverConfig({ lifecycle: 'eager', args: ['second'] }) },
  })
  assert.equal(fake.connections[0].closed, true)
  assert.equal(manager.statusSnapshot().servers[0].state, 'disconnected')
  assert.equal(scheduler.active().length, 1)
  assert.equal(scheduler.active()[0].delay, 0)

  await scheduler.runNext()
  assert.equal(fake.connections.length, 2)
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')

  await manager.dispose()
})
