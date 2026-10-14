import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { McpClientManager } from '../src/host/manager.js'
import { createMcpProxyTool } from '../src/host/proxy-tool.js'

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
}

function execution() {
  return {
    name: 'mcp',
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: {
      session: { header: { id: 'session-1' } },
    },
  }
}

function createContext({ approval, spillStore } = {}) {
  const warnings = []
  return {
    warnings,
    logger: { warn(message) { warnings.push(message) } },
    get(name) {
      if (name === 'approval') return approval
      if (name === 'spillStore') return spillStore
      return undefined
    },
  }
}

class FakeManager {
  constructor({
    name = 'github',
    config = serverConfig(),
    tools = [{ name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } }],
    result = { content: [{ type: 'text', text: 'done' }] },
    listError,
    resources = {
      resources: [{
        uri: 'file:///docs/readme.md',
        name: 'readme.md',
        description: 'Docs',
        mimeType: 'text/markdown',
      }],
    },
    templates = {
      resourceTemplates: [{ uriTemplate: 'file:///docs/{path}', name: 'docs' }],
    },
    readResult = { contents: [] },
    prompts = {
      prompts: [{ name: 'review', description: 'Review code', arguments: [{ name: 'path' }] }],
    },
    promptResult = { messages: [] },
    promptError,
  } = {}) {
    this.name = name
    this.config = config
    this.tools = tools
    this.result = result
    this.listError = listError
    this.resources = resources
    this.templates = templates
    this.readResult = readResult
    this.prompts = prompts
    this.promptResult = promptResult
    this.promptError = promptError
    this.callCount = 0
    this.listCount = 0
    this.lastPrompt = undefined
  }

  getServerConfig(name) {
    return name === this.name ? structuredClone(this.config) : undefined
  }

  catalogSnapshot() {
    return {
      servers: [{
        name: this.name,
        disabled: this.config.disabled,
        state: 'disconnected',
        tools: structuredClone(this.tools),
      }],
    }
  }

  async listTools(name) {
    this.listCount += 1
    if (name !== this.name) throw new Error(`Unknown MCP server ${name}`)
    if (this.listError !== undefined) throw this.listError
    return structuredClone(this.tools)
  }

  async callTool(name, tool, args) {
    this.callCount += 1
    this.lastCall = { name, tool, args }
    return structuredClone(this.result)
  }

  async listResources(name) {
    this.requireServer(name)
    return structuredClone(this.resources)
  }

  async readResource(name, uri) {
    this.requireServer(name)
    this.lastRead = { name, uri }
    return structuredClone(this.readResult)
  }

  async listTemplates(name) {
    if (this.templates === undefined) throw new Error('Templates unsupported')
    this.requireServer(name)
    return structuredClone(this.templates)
  }

  async listPrompts(name) {
    this.requireServer(name)
    return structuredClone(this.prompts)
  }

  async getPrompt(name, prompt, args) {
    this.requireServer(name)
    if (this.promptError !== undefined) throw this.promptError
    this.lastPrompt = { server: name, prompt, args }
    return structuredClone(this.promptResult)
  }

  requireServer(name) {
    if (name !== this.name) throw new Error(`Unknown MCP server ${name}`)
  }
}

test('mcp alone discovers, describes, approves, and calls a stdio fixture', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url))
  const manager = new McpClientManager(
    new MemoryScope({
      mcpServers: { fixture: serverConfig({ args: [fixture] }) },
    }),
    { schedule: () => () => {} },
  )
  const approvalRequests = []
  const ctx = createContext({
    approval: {
      async request(request) {
        approvalRequests.push(request)
        return 'allowed-once'
      },
    },
  })
  const tool = createMcpProxyTool(ctx, manager)
  const exec = execution()

  const search = await tool.execute({ action: 'search', query: 'ping' }, exec)
  assert.deepEqual(search.data.results.map((result) => result.name), ['fixture__ping'])

  const describe = await tool.execute(
    { action: 'describe', server: 'fixture', tool: 'fixture__ping' },
    exec,
  )
  assert.equal(describe.data.inputSchema.type, 'object')

  const call = await tool.execute(
    {
      action: 'call',
      server: 'fixture',
      tool: 'ping',
      args: { token: 'must-not-appear' },
    },
    exec,
  )
  assert.equal(call.text, 'pong')
  assert.equal(approvalRequests.length, 1)
  assert.match(approvalRequests[0].reason, /fixture.*ping/)
  assert.match(approvalRequests[0].reason, /\[redacted\]/)
  assert.doesNotMatch(approvalRequests[0].reason, /must-not-appear/)

  await manager.dispose()
})

test('autoAllow skips approval and rejection blocks the remote call', async () => {
  const autoManager = new FakeManager({ config: serverConfig({ autoAllow: true }) })
  const autoTool = createMcpProxyTool(
    createContext({ approval: { request() { throw new Error('must not ask') } } }),
    autoManager,
  )
  const allowed = await autoTool.execute(
    { action: 'call', server: 'github', tool: 'list_issues', args: {} },
    execution(),
  )
  assert.equal(allowed.text, 'done')
  assert.equal(autoManager.callCount, 1)

  const gatedManager = new FakeManager()
  const gatedTool = createMcpProxyTool(
    createContext({ approval: { async request() { return 'rejected' } } }),
    gatedManager,
  )
  await assert.rejects(
    gatedTool.execute(
      { action: 'call', server: 'github', tool: 'list_issues', args: {} },
      execution(),
    ),
    /not approved \(rejected\)/,
  )
  assert.equal(gatedManager.callCount, 0)
})

test('unknown names return suggestions and transport failures return setup hints', async () => {
  const manager = new FakeManager()
  const tool = createMcpProxyTool(createContext(), manager)

  await assert.rejects(
    tool.execute(
      { action: 'describe', server: 'gitub', tool: 'list_issues' },
      execution(),
    ),
    /Did you mean: github/,
  )
  await assert.rejects(
    tool.execute(
      { action: 'describe', server: 'github', tool: 'list_issue' },
      execution(),
    ),
    /Did you mean: list_issues/,
  )

  const broken = new FakeManager({ listError: new Error('spawn ENOENT') })
  const brokenTool = createMcpProxyTool(createContext(), broken)
  await assert.rejects(
    brokenTool.execute(
      { action: 'describe', server: 'github', tool: 'list_issues' },
      execution(),
    ),
    /Setup hint: check command.*executable path.*Settings > MCP/,
  )
})

test('large call output is bounded and spills full text and raw result', async () => {
  const text = `${'large line\n'.repeat(6_000)}tail`
  const manager = new FakeManager({
    config: serverConfig({ autoAllow: true }),
    result: {
      content: [{ type: 'text', text }],
      structuredContent: { rows: Array.from({ length: 3_000 }, (_, index) => ({ index })) },
    },
  })
  const saves = []
  const spillStore = {
    async saveText(input) {
      saves.push(input)
      return {
        locator: `spill://${input.source.label}`,
        bytes: Buffer.byteLength(input.content),
        retrievalHint: 'Use read or grep.',
      }
    },
  }
  const tool = createMcpProxyTool(createContext({ spillStore }), manager)

  const result = await tool.execute(
    { action: 'call', server: 'github', tool: 'list_issues', args: {} },
    execution(),
  )

  assert.equal(result.guard.textTruncated, true)
  assert.equal(result.guard.resultSummarized, true)
  assert.ok(Buffer.byteLength(result.text) <= 50 * 1024)
  assert.match(result.text, /Full text stored at: spill:\/\/mcp-output/)
  assert.equal(result.data.omitted, true)
  assert.equal(result.data.fullResult.locator, 'spill://mcp-result')
  assert.deepEqual(
    saves.map((save) => save.source.label).sort(),
    ['mcp-output', 'mcp-result'],
  )
})

test('resources action lists one Server and requires its server field', async () => {
  const manager = new FakeManager()
  const tool = createMcpProxyTool(createContext(), manager)
  const exec = execution()

  const result = await tool.execute({ action: 'resources', server: 'github' }, exec)
  assert.equal(result.action, 'resources')
  assert.deepEqual(result.data, {
    resources: [{
      uri: 'file:///docs/readme.md',
      name: 'readme.md',
      description: 'Docs',
      mimeType: 'text/markdown',
    }],
    templates: [{ uriTemplate: 'file:///docs/{path}', name: 'docs' }],
  })
  assert.match(result.text, /file:\/\/\/docs\/readme\.md/)
  assert.match(result.text, /Templates:/)

  await assert.rejects(
    tool.execute({ action: 'resources' }, exec),
    /mcp action "resources" requires a non-empty server/,
  )
  await assert.rejects(
    tool.execute({ action: 'resources', server: 'gitub' }, exec),
    /Unknown MCP Server "gitub".*Did you mean: github/,
  )

  const noTemplates = new FakeManager({ templates: { resourceTemplates: [] } })
  const noTemplatesTool = createMcpProxyTool(createContext(), noTemplates)
  const withoutTemplates = await noTemplatesTool.execute(
    { action: 'resources', server: 'github' },
    exec,
  )
  assert.deepEqual(withoutTemplates.data, {
    resources: [{ uri: 'file:///docs/readme.md', name: 'readme.md', description: 'Docs', mimeType: 'text/markdown' }],
  })
})

test('read action inlines text and materializes binary blobs into the injected temp root', async () => {
  const fsCalls = []
  const fakeFs = {
    async mkdtemp(prefix) {
      fsCalls.push(['mkdtemp', prefix])
      return '/tmp/fake-root/mcp-resource-abc'
    },
    async writeFile(target, data) {
      fsCalls.push(['writeFile', target, data])
    },
  }
  const blob = Buffer.from('PDF-bytes').toString('base64')
  const manager = new FakeManager({
    readResult: {
      contents: [
        { uri: 'file:///docs/readme.md', mimeType: 'text/markdown', text: '# hello' },
        { uri: 'file:///docs/report final.pdf', mimeType: 'application/pdf', blob },
      ],
    },
  })
  const tool = createMcpProxyTool(
    createContext(),
    manager,
    { fs: fakeFs, tempRoot: '/tmp/fake-root' },
  )
  const exec = execution()

  const result = await tool.execute(
    { action: 'read', server: 'github', uri: 'file:///docs/readme.md' },
    exec,
  )
  assert.equal(result.action, 'read')
  assert.deepEqual(result.data.contents, [
    { uri: 'file:///docs/readme.md', mimeType: 'text/markdown', text: '# hello' },
    {
      uri: 'file:///docs/report final.pdf',
      mimeType: 'application/pdf',
      path: '/tmp/fake-root/mcp-resource-abc/report_final.pdf',
      size: 9,
    },
  ])
  assert.match(result.text, /# hello/)
  assert.match(result.text, /report_final\.pdf/)
  assert.doesNotMatch(result.text, /UERGLWJ5/)
  assert.equal(fsCalls.length, 2)
  assert.match(fsCalls[0][1], /^\/tmp\/fake-root\/mcp-resource-/)
  assert.equal(fsCalls[1][1], '/tmp/fake-root/mcp-resource-abc/report_final.pdf')
  assert.deepEqual(fsCalls[1][2], Buffer.from('PDF-bytes'))
  assert.deepEqual(manager.lastRead, { name: 'github', uri: 'file:///docs/readme.md' })

  const textOnlyManager = new FakeManager({
    readResult: {
      contents: [{ uri: 'file:///docs/readme.md', mimeType: 'text/markdown', text: '# hello' }],
    },
  })
  const textOnlyTool = createMcpProxyTool(
    createContext(),
    textOnlyManager,
    { fs: fakeFs, tempRoot: '/tmp/fake-root' },
  )
  const onlyText = await textOnlyTool.execute(
    { action: 'read', server: 'github', uri: 'file:///docs/readme.md' },
    exec,
  )
  assert.equal(onlyText.data.contents.length, 1)
  assert.equal(onlyText.text, '# hello')
  assert.equal(fsCalls.length, 2, 'text-only reads never touch the temp file system')

  await assert.rejects(
    tool.execute({ action: 'read', server: 'github' }, exec),
    /mcp action "read" requires a non-empty uri/,
  )
  await assert.rejects(
    tool.execute({ action: 'read', server: 'gitub', uri: 'file:///x' }, exec),
    /Unknown MCP Server "gitub"/,
  )
})

test('large resource text is guarded and spills like tool output', async () => {
  const text = `${'large line\n'.repeat(6_000)}tail`
  const manager = new FakeManager({
    readResult: {
      contents: [{ uri: 'file:///docs/big.txt', mimeType: 'text/plain', text }],
    },
  })
  const spillStore = {
    async saveText(input) {
      return {
        locator: `spill://${input.source.label}`,
        bytes: Buffer.byteLength(input.content),
        retrievalHint: 'Use read or grep.',
      }
    },
  }
  const tool = createMcpProxyTool(createContext({ spillStore }), manager)

  const result = await tool.execute(
    { action: 'read', server: 'github', uri: 'file:///docs/big.txt' },
    execution(),
  )
  assert.equal(result.guard.textTruncated, true)
  assert.ok(Buffer.byteLength(result.text) <= 50 * 1024)
  assert.match(result.text, /Full text stored at: spill:\/\/mcp-output/)
})

test('prompt actions list prompts and fetch formatted messages', async () => {
  const manager = new FakeManager({
    promptResult: {
      messages: [
        { role: 'user', content: { type: 'text', text: 'Review the code.' } },
        { role: 'assistant', content: { type: 'text', text: 'Here are my findings.' } },
      ],
    },
  })
  const tool = createMcpProxyTool(createContext(), manager)
  const exec = execution()

  const list = await tool.execute({ action: 'prompts', server: 'github' }, exec)
  assert.equal(list.action, 'prompts')
  assert.deepEqual(list.data, {
    prompts: [{ name: 'review', description: 'Review code', arguments: [{ name: 'path' }] }],
  })
  assert.match(list.text, /review/)
  await assert.rejects(
    tool.execute({ action: 'prompts' }, exec),
    /mcp action "prompts" requires a non-empty server/,
  )

  const fetched = await tool.execute(
    { action: 'prompt', server: 'github', name: 'review', args: { path: 'a.md' } },
    exec,
  )
  assert.equal(fetched.action, 'prompt')
  assert.equal(fetched.text, 'user: Review the code.\nassistant: Here are my findings.')
  assert.deepEqual(manager.lastPrompt, { server: 'github', prompt: 'review', args: { path: 'a.md' } })

  await assert.rejects(
    tool.execute({ action: 'prompt', server: 'github', name: 'review', args: 'nope' }, exec),
    /mcp action "prompt" requires args to be an object when supplied/,
  )
  await assert.rejects(
    tool.execute({ action: 'prompt', server: 'gitub', name: 'review' }, exec),
    /Unknown MCP Server "gitub"/,
  )

  const broken = new FakeManager({ promptError: new Error('connection closed') })
  const brokenTool = createMcpProxyTool(createContext(), broken)
  await assert.rejects(
    brokenTool.execute({ action: 'prompt', server: 'github', name: 'review' }, exec),
    /Setup hint: check command.*executable path.*Settings > MCP/,
  )
})

test('unknown mcp actions list every supported action', async () => {
  const manager = new FakeManager()
  const tool = createMcpProxyTool(createContext(), manager)
  await assert.rejects(
    tool.execute({ action: 'nope' }, execution()),
    /Use search, describe, call, resources, read, prompts, or prompt\./,
  )
})
