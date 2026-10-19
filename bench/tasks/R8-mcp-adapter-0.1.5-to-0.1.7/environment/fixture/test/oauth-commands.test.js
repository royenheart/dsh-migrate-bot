import assert from 'node:assert/strict'
import test from 'node:test'

import { installMcpOauthCommands } from '../src/host/oauth-commands.js'
import { installMcpOauth } from '../src/host/oauth-service.js'

function memoryStore(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    async get(serverName) {
      return records.get(serverName)
    },
    async set(serverName, record) {
      records.set(serverName, record)
      return record
    },
    async delete(serverName) {
      return records.delete(serverName)
    },
    async has(serverName) {
      return records.has(serverName)
    },
  }
}

function commandHarness({ servers, store, oauth }) {
  const registered = []
  const effects = []
  const ctx = {
    inject(services, fn) {
      fn({
        commands: {
          register(definition) {
            registered.push(definition)
            return () => registered.pop()
          },
        },
      })
    },
    effect(setup, label) {
      effects.push({ dispose: setup(), label })
    },
  }
  const scope = { get: () => structuredClone({ mcpServers: servers }) }
  const manager = {
    disconnects: [],
    async disconnect(name, reason) {
      this.disconnects.push([name, reason])
    },
  }
  const controller = oauth ?? installMcpOauth(
    { effect() {}, logger: undefined },
    manager,
    scope,
    { store: store ?? memoryStore() },
  )
  installMcpOauthCommands(ctx, scope, controller)
  return { definition: registered[0], manager, controller }
}

function stubController(overrides = {}) {
  const calls = []
  return {
    calls,
    async startLogin(serverName) {
      calls.push(['startLogin', serverName])
      if (overrides.loginError) throw overrides.loginError
      return { authorizationUrl: 'https://auth.example.test/authorize?client_id=x' }
    },
    async logout(serverName) {
      calls.push(['logout', serverName])
      return { configured: true, signedIn: false, url: 'https://a.test/api' }
    },
    async status(serverName) {
      calls.push(['status', serverName])
      return overrides.status ?? { configured: true, signedIn: false, url: 'https://a.test/api' }
    },
    noteAuthorizationRequired() {},
  }
}

const SERVERS = {
  remote: { url: 'https://a.test/api', auth: 'oauth', disabled: false },
  local: { command: 'node', auth: 'headers', disabled: false },
}

test('registers the mcp-auth command with a usage hint', () => {
  const { definition } = commandHarness({ servers: SERVERS, oauth: stubController() })
  assert.equal(definition.name, 'mcp-auth')
  assert.match(definition.description, /OAuth/)
  assert.equal(definition.input.hint, '[server] [login|logout|status]')
})

test('empty input reports status for every OAuth Server', async () => {
  const oauth = stubController()
  const { definition } = commandHarness({ servers: SERVERS, oauth })
  const result = await definition.handler({ rawInput: '' })
  assert.deepEqual(oauth.calls, [['status', 'remote']], 'only OAuth Servers are listed')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /remote: signed out/)
  assert.equal(result.text.includes('local'), false)
})

test('empty input with no OAuth Servers explains how to configure one', async () => {
  const { definition } = commandHarness({
    servers: { local: { command: 'node', auth: 'headers', disabled: false } },
    oauth: stubController(),
  })
  const result = await definition.handler({ rawInput: undefined })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /No Server uses OAuth/)
})

test('login starts the flow and returns the authorization URL', async () => {
  const oauth = stubController()
  const { definition } = commandHarness({ servers: SERVERS, oauth })
  const result = await definition.handler({ rawInput: 'remote login' })
  assert.deepEqual(oauth.calls, [['startLogin', 'remote']])
  assert.equal(result.kind, 'success')
  assert.match(
    result.text,
    /https:\/\/auth\.example\.test\/authorize\?client_id=x/,
    'the text carries the authorization URL',
  )
  assert.match(result.text, /background/)
})

test('logout and status report through the controller', async () => {
  const oauth = stubController({
    status: {
      configured: true,
      signedIn: true,
      expiresAt: Date.now() + 60_000,
      url: 'https://a.test/api',
    },
  })
  const { definition, manager } = commandHarness({ servers: SERVERS, oauth })
  const login = await definition.handler({ rawInput: 'remote status' })
  assert.equal(login.kind, 'success')
  assert.match(login.text, /remote: signed in/)

  const out = await definition.handler({ rawInput: 'remote logout' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /signed out/)
  assert.deepEqual(oauth.calls, [
    ['status', 'remote'],
    ['logout', 'remote'],
  ])
})

test('malformed input returns the usage error', async () => {
  const oauth = stubController()
  const { definition } = commandHarness({ servers: SERVERS, oauth })
  for (const rawInput of ['remote', 'remote refresh', 'remote login extra', 'login']) {
    const result = await definition.handler({ rawInput })
    assert.deepEqual(result, {
      kind: 'error',
      text: 'Usage: /mcp-auth [server] [login|logout|status]',
    })
  }
  assert.deepEqual(oauth.calls, [])
})

test('the handler never throws: failures become error results', async () => {
  const { definition } = commandHarness({
    servers: SERVERS,
    oauth: stubController({ loginError: new Error('the authorization server is down') }),
  })
  const failedLogin = await definition.handler({ rawInput: 'remote login' })
  assert.equal(failedLogin.kind, 'error')
  assert.match(failedLogin.text, /the authorization server is down/)
})

test('the handler never throws: the real controller rejects bad targets', async () => {
  const { definition } = commandHarness({
    servers: SERVERS,
    store: memoryStore(),
  })
  const nonOauth = await definition.handler({ rawInput: 'local login' })
  assert.equal(nonOauth.kind, 'error')
  assert.match(nonOauth.text, /does not use OAuth authentication/)

  const unknown = await definition.handler({ rawInput: 'ghost logout' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown MCP server "ghost"/)

  // status stays lenient for unknown or non-OAuth Servers.
  const lenient = await definition.handler({ rawInput: 'ghost status' })
  assert.equal(lenient.kind, 'success')
  assert.match(lenient.text, /not configured for OAuth/)
})

test('the real controller reports expired tokens in status text', async () => {
  const store = memoryStore({
    remote: {
      url: 'https://a.test/api',
      accessToken: 'at-1',
      expiresAt: Date.now() - 1_000,
    },
  })
  const { definition } = commandHarness({ servers: SERVERS, store })
  const result = await definition.handler({ rawInput: 'remote status' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /signed in \(token expired/)
})
