import assert from 'node:assert/strict'
import test from 'node:test'

import { installMcpCommands } from '../src/host/commands.js'
import { McpClientManager } from '../src/host/manager.js'

const MCP_USAGE = 'Usage: /mcp [status|reconnect|enable|disable] [server]'

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

function mergeDeep(under, over) {
  if (
    typeof under !== 'object' ||
    under === null ||
    Array.isArray(under) ||
    typeof over !== 'object' ||
    over === null ||
    Array.isArray(over)
  ) {
    return over
  }
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeDeep(merged[key], value) : value
  }
  return merged
}

class RecordingScope {
  constructor(value) {
    this.value = structuredClone(value)
    this.watchers = new Set()
    this.updates = []
    this.updateError = undefined
  }

  get() {
    return structuredClone(this.value)
  }

  watch(callback) {
    this.watchers.add(callback)
    return () => this.watchers.delete(callback)
  }

  async update(patch) {
    this.updates.push(structuredClone(patch))
    if (this.updateError !== undefined) throw this.updateError
    this.value = mergeDeep(structuredClone(this.value), structuredClone(patch))
    for (const watcher of [...this.watchers]) {
      await watcher(structuredClone(this.value))
    }
  }
}

function tool(name) {
  return { name, description: `${name} description`, inputSchema: { type: 'object' } }
}

function fakeConnectionFactory(toolsByServer = {}, failures = {}) {
  const connections = []
  const factory = async (name, _config, callbacks) => {
    if (failures[name] !== undefined) throw failures[name]
    const connection = {
      callbacks,
      closed: false,
      transportType: 'test',
      client: {
        async listTools() {
          return { tools: toolsByServer[name] ?? [] }
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

function commandContext() {
  const state = {
    injectedNames: undefined,
    definition: undefined,
    effects: [],
    unregisterCount: 0,
  }
  const ctx = {
    inject(names, activate) {
      state.injectedNames = names
      activate({
        commands: {
          register(definition) {
            state.definition = definition
            return () => {
              state.unregisterCount += 1
            }
          },
        },
      })
    },
    effect(factory, label) {
      state.effects.push({ label, dispose: factory() })
    },
  }
  return { ctx, state }
}

function inertContext() {
  return { inject() {} }
}

function invocation(rawInput) {
  return {
    rawInput,
    signal: new AbortController().signal,
    agent: { session: { header: { id: 'session-1' } } },
    commandId: 'cmd-test-1',
  }
}

async function startManager(scope, toolsByServer, failures) {
  const fake = fakeConnectionFactory(toolsByServer, failures)
  const manager = new McpClientManager(scope, {
    schedule: () => () => {},
    connectionFactory: fake.factory,
  })
  return { manager, fake }
}

test('registration exposes one mcp command and keeps its disposer alive', async (t) => {
  const scope = new RecordingScope({ mcpServers: {} })
  const { manager } = await startManager(scope)
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()

  installMcpCommands(ctx, manager, scope)

  assert.deepEqual(state.injectedNames, ['commands'])
  assert.equal(state.definition.name, 'mcp')
  assert.equal(typeof state.definition.handler, 'function')
  assert.equal(typeof state.definition.description, 'string')
  assert.ok(state.definition.description.trim().length > 0)
  assert.equal(typeof state.definition.input?.hint, 'string')

  assert.equal(state.effects.length, 1)
  assert.match(state.effects[0].label, /mcp/)
  state.effects[0].dispose()
  assert.equal(state.unregisterCount, 1)
})

test('a missing commands service never activates and never fails the Adapter', async (t) => {
  const scope = new RecordingScope({ mcpServers: {} })
  const { manager } = await startManager(scope)
  t.after(() => manager.dispose())

  assert.doesNotThrow(() => installMcpCommands(inertContext(), manager, scope))
})

test('empty and status input report one line per Server in snapshot order', async (t) => {
  const scope = new RecordingScope({
    mcpServers: {
      alpha: serverConfig(),
      beta: serverConfig({ disabled: true }),
      gamma: serverConfig({ command: 'missing-binary' }),
    },
  })
  const { manager } = await startManager(
    scope,
    { alpha: [tool('one'), tool('two')] },
    { gamma: new Error('spawn missing-binary ENOENT') },
  )
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)
  const handler = state.definition.handler

  await manager.listTools('alpha')
  await assert.rejects(manager.listTools('gamma'))

  const expected = [
    'alpha — connected (2 tools)',
    'beta — disabled (0 tools)',
    'gamma — error (0 tools) — spawn missing-binary ENOENT',
  ].join('\n')

  assert.deepEqual(await handler(invocation('')), { kind: 'success', text: expected })
  assert.deepEqual(await handler(invocation('status')), { kind: 'success', text: expected })
  for (const line of expected.split('\n')) {
    assert.equal(line, line.trimEnd())
  }
})

test('status with no Servers configured reports the empty state', async (t) => {
  const scope = new RecordingScope({ mcpServers: {} })
  const { manager } = await startManager(scope)
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  assert.deepEqual(await state.definition.handler(invocation('')), {
    kind: 'success',
    text: 'No MCP Servers configured.',
  })
})

test('reconnect closes the old connection, relists tools, and reports the new state', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager, fake } = await startManager(scope, { alpha: [tool('one'), tool('two')] })
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  await manager.listTools('alpha')
  assert.equal(fake.connections.length, 1)

  assert.deepEqual(await state.definition.handler(invocation('reconnect alpha')), {
    kind: 'success',
    text: 'Reconnected alpha — connected (2 tools)',
  })
  assert.equal(fake.connections.length, 2)
  assert.equal(fake.connections[0].closed, true)
  assert.equal(manager.statusSnapshot().servers[0].state, 'connected')
})

test('reconnect of an unknown Server settles as an error result', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager, fake } = await startManager(scope, { alpha: [] })
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  const result = await state.definition.handler(invocation('reconnect nope'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /nope/)
  assert.equal(fake.connections.length, 0)
})

test('a reconnect failure settles as an error result instead of throwing', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager } = await startManager(
    scope,
    {},
    { alpha: new Error('connect exploded') },
  )
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  const result = await state.definition.handler(invocation('reconnect alpha'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /connect exploded/)
})

test('disable records the Config path write and reports the new state', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager, fake } = await startManager(scope, { alpha: [tool('one')] })
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  await manager.listTools('alpha')
  assert.deepEqual(await state.definition.handler(invocation('disable alpha')), {
    kind: 'success',
    text: 'Server alpha disabled in the global Config.',
  })

  assert.deepEqual(scope.updates, [{ mcpServers: { alpha: { disabled: true } } }])
  assert.equal(manager.statusSnapshot().servers[0].state, 'disabled')
  assert.equal(fake.connections[0].closed, true)
})

test('enable clears the disabled flag and restores the lazy state', async (t) => {
  const scope = new RecordingScope({
    mcpServers: { alpha: serverConfig({ disabled: true }) },
  })
  const { manager, fake } = await startManager(scope, { alpha: [tool('one')] })
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  assert.equal(manager.statusSnapshot().servers[0].state, 'disabled')
  assert.deepEqual(await state.definition.handler(invocation('enable alpha')), {
    kind: 'success',
    text: 'Server alpha enabled in the global Config.',
  })

  assert.deepEqual(scope.updates, [{ mcpServers: { alpha: { disabled: false } } }])
  assert.equal(manager.statusSnapshot().servers[0].state, 'disconnected')
  assert.equal(fake.connections.length, 0)
})

test('enable and disable of an unknown Server settle as errors without writing Config', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager } = await startManager(scope)
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  const disabled = await state.definition.handler(invocation('disable nope'))
  assert.equal(disabled.kind, 'error')
  assert.match(disabled.text, /nope/)
  const enabled = await state.definition.handler(invocation('enable nope'))
  assert.equal(enabled.kind, 'error')
  assert.match(enabled.text, /nope/)
  assert.deepEqual(scope.updates, [])
})

test('unknown subcommands and malformed arguments settle as usage errors', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager } = await startManager(scope, { alpha: [] })
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  for (const rawInput of [
    'restart alpha',
    'status alpha beta',
    'reconnect',
    'reconnect alpha beta',
    'enable',
    'enable alpha extra',
    'disable',
    'disable alpha extra',
  ]) {
    const result = await state.definition.handler(invocation(rawInput))
    assert.equal(result.kind, 'error', rawInput)
    assert.equal(result.text, MCP_USAGE, rawInput)
  }
})

test('a Config write failure settles as an error result instead of throwing', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager } = await startManager(scope)
  t.after(() => manager.dispose())
  scope.updateError = new Error('settings locked')
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)

  const result = await state.definition.handler(invocation('disable alpha'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /settings locked/)
})

test('status reports one Server by name and rejects unknown names', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager } = await startManager(scope, { alpha: [tool('one')] })
  t.after(() => manager.dispose())
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, scope)
  await manager.listTools('alpha')

  const known = await state.definition.handler(invocation('status alpha'))
  assert.equal(known.kind, 'success')
  assert.equal(known.text, 'alpha — connected (1 tool)')

  const unknown = await state.definition.handler(invocation('status nope'))
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /nope/)
})

test('enable and disable refuse a workspace-sourced Server without writing Config', async (t) => {
  const scope = new RecordingScope({ mcpServers: { alpha: serverConfig() } })
  const { manager } = await startManager(scope)
  t.after(() => manager.dispose())
  const layered = {
    get: () => scope.get(),
    watch: (listener) => scope.watch(listener),
    update: (patch) => scope.update(patch),
    layerSnapshot: () => ({ source: { alpha: 'workspace' } }),
  }
  const { ctx, state } = commandContext()
  installMcpCommands(ctx, manager, layered)

  const result = await state.definition.handler(invocation('disable alpha'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /workspace \.dsh\/mcp\.json/)
  assert.deepEqual(scope.updates, [])
})
