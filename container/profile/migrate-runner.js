/**
 * One-shot dsh runner for the migrate profile: headless task + preset mount.
 * Stock `@deepseek-ai/dsh-headless` does not join a preset roster; this copy
 * of that driver calls `agentPresets.mount` during setup when the roster is
 * composed (see @deepseek-ai/dsh-agent-presets README, "Composing a child agent").
 */
import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'dsh-migrate-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

function fail(io, error) {
  io.stderr.write(`dsh-migrate: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

async function run(ctx, task, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const provider = process.env.DSH_MIGRATE_PROVIDER || selection.provider
  const model = process.env.DSH_MIGRATE_MODEL || selection.model
  const mode = process.env.DSH_MIGRATE_MODE || 'anchored-standard'
  const current = { ...selection, provider, model }

  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd(), agentPreset: mode },
    agentOptions: { provider, model },
    setup: async (agentCtx) => {
      const presets = ctx.get('agentPresets')
      if (presets !== undefined) {
        await presets.mount(agentCtx, mode)
      }
      installModelSelection(agentCtx, { current, assembled: undefined })
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh-migrate: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('dsh-migrate-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const task = (config?.task || process.env.DSH_MIGRATE_TASK || '').trim()
  if (task === '') {
    throw new Error('dsh-migrate-runner: missing task (dsh --profile migrate "<task>" or DSH_MIGRATE_TASK)')
  }
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  void run(ctx, task, io).catch((error) => { fail(io, error) })
}
