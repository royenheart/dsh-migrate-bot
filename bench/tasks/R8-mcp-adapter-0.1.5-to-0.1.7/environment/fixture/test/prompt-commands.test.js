import assert from 'node:assert/strict'
import test from 'node:test'

import {
  installMcpPromptCommand,
  MCP_PROMPT_COMMAND_NAME,
} from '../src/host/prompt-commands.js'

class FakeManager {
  constructor({ promptResult, errors = {} } = {}) {
    this.promptResult = promptResult ?? {
      messages: [
        { role: 'user', content: { type: 'text', text: 'Review the code.' } },
        { role: 'assistant', content: { type: 'text', text: 'On it.' } },
      ],
    }
    this.errors = errors
    this.calls = []
  }

  async getPrompt(name, prompt, args) {
    this.calls.push({ name, prompt, args })
    const error = this.errors[name]
    if (error !== undefined) throw error
    return structuredClone(this.promptResult)
  }
}

function harness(manager) {
  const effects = []
  let definition
  let disposeCalls = 0
  const commands = {
    register(input) {
      definition = input
      return () => {
        disposeCalls += 1
      }
    },
  }
  const ctx = {
    effect(callback, label) {
      effects.push({ callback, label })
    },
    inject(services, callback) {
      assert.deepEqual(services, ['commands'])
      callback({ commands, effect: (cb, label) => ctx.effect(cb, label) })
    },
  }
  installMcpPromptCommand(ctx, manager)
  return {
    definition,
    effects,
    run: (rawInput, signal) => definition.handler({ rawInput, signal }),
    disposeEffect() {
      for (const effect of effects) {
        const dispose = effect.callback()
        if (typeof dispose === 'function') dispose()
      }
      return disposeCalls
    },
  }
}

test('mcp-prompt registers one command and wires its disposer through ctx.effect', () => {
  const commandHarness = harness(new FakeManager())
  assert.equal(commandHarness.definition.name, MCP_PROMPT_COMMAND_NAME)
  assert.equal(commandHarness.definition.name, 'mcp-prompt')
  assert.equal(commandHarness.definition.description, 'Fetch an MCP prompt from a Server.')
  assert.deepEqual(commandHarness.definition.input, { hint: '<server> <prompt> [json-args]' })
  assert.equal(typeof commandHarness.definition.handler, 'function')
  assert.equal(commandHarness.effects.length, 1)
  assert.equal(commandHarness.effects[0].label, 'dsh-mcp-adapter: /mcp-prompt command')
  assert.equal(commandHarness.disposeEffect(), 1)
})

test('mcp-prompt answers usage errors without throwing', async () => {
  const commandHarness = harness(new FakeManager())
  const empty = await commandHarness.run('')
  assert.deepEqual(empty, {
    kind: 'error',
    text: 'Usage: /mcp-prompt <server> <prompt> [json-args]',
  })
  const oneToken = await commandHarness.run('demo')
  assert.equal(oneToken.kind, 'error')
  assert.match(oneToken.text, /Usage: \/mcp-prompt/)
  const notAString = await commandHarness.run(undefined)
  assert.equal(notAString.kind, 'error')
  assert.match(notAString.text, /Usage: \/mcp-prompt/)
})

test('mcp-prompt fetches prompts and formats messages with JSON args', async () => {
  const manager = new FakeManager()
  const commandHarness = harness(manager)

  const success = await commandHarness.run('demo review')
  assert.equal(success.kind, 'success')
  assert.equal(success.text, 'user: Review the code.\nassistant: On it.')
  assert.deepEqual(manager.calls, [{ name: 'demo', prompt: 'review', args: {} }])

  const withArgs = await commandHarness.run('demo review {"path": "a.md", "depth": 2}')
  assert.equal(withArgs.kind, 'success')
  assert.deepEqual(manager.calls[1].args, { path: 'a.md', depth: 2 })
})

test('mcp-prompt wraps every failure as an error result', async () => {
  const manager = new FakeManager({
    errors: {
      demo: new Error('connection closed'),
      missing: new Error('Unknown MCP server "missing"'),
    },
  })
  const commandHarness = harness(manager)

  const badJson = await commandHarness.run('demo review {nope')
  assert.equal(badJson.kind, 'error')
  assert.match(badJson.text, /Invalid JSON arguments/)

  const notAnObject = await commandHarness.run('demo review ["path"]')
  assert.equal(notAnObject.kind, 'error')
  assert.match(notAnObject.text, /must be a JSON object/)

  const unknownServer = await commandHarness.run('missing review')
  assert.equal(unknownServer.kind, 'error')
  assert.match(unknownServer.text, /Unknown MCP server "missing"/)

  const failedFetch = await commandHarness.run('demo review')
  assert.equal(failedFetch.kind, 'error')
  assert.match(failedFetch.text, /connection closed/)
})
