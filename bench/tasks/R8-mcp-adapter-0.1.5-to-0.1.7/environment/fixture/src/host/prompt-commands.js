import { renderPromptMessages } from './proxy-tool.js'
import { errorMessage } from './errors.js'

export const MCP_PROMPT_COMMAND_NAME = 'mcp-prompt'

const USAGE = 'Usage: /mcp-prompt <server> <prompt> [json-args]'

function parseInvocation(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text === '') return { error: USAGE }
  const match = text.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/)
  if (match === null) return { error: USAGE }
  return { server: match[1], prompt: match[2], argsText: match[3] }
}

function createMcpPromptHandler(manager) {
  return async function mcpPromptHandler(invocation) {
    try {
      const parsed = parseInvocation(invocation?.rawInput)
      if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }

      let args = {}
      if (parsed.argsText !== undefined) {
        try {
          args = JSON.parse(parsed.argsText)
        } catch (error) {
          return {
            kind: 'error',
            text: `Invalid JSON arguments: ${errorMessage(error)}`,
          }
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) {
          return { kind: 'error', text: 'Prompt arguments must be a JSON object.' }
        }
      }

      const result = await manager.getPrompt(parsed.server, parsed.prompt, args, {
        signal: invocation?.signal,
      })
      return { kind: 'success', text: renderPromptMessages(result) }
    } catch (error) {
      return { kind: 'error', text: `/mcp-prompt failed: ${errorMessage(error)}` }
    }
  }
}

export function installMcpPromptCommand(ctx, manager) {
  ctx.inject(['commands'], (commandsCtx) => {
    const commands = commandsCtx.commands
    const dispose = commands.register({
      name: MCP_PROMPT_COMMAND_NAME,
      description: 'Fetch an MCP prompt from a Server.',
      input: { hint: '<server> <prompt> [json-args]' },
      handler: createMcpPromptHandler(manager),
    })
    commandsCtx.effect(() => dispose, 'dsh-mcp-adapter: /mcp-prompt command')
  })
}
