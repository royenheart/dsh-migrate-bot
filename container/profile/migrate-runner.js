/**
 * One-shot dsh runner for the migrate profile: headless task + preset mount.
 * Stock `@deepseek-ai/dsh-headless` does not join a preset roster; this copy
 * of that driver calls `agentPresets.mount` during setup when the roster is
 * composed (see @deepseek-ai/dsh-agent-presets README, "Composing a child agent").
 *
 * LLM text is written to stdout only after the session is idle. Progress
 * lines go to stderr as `dsh-migrate-status: …` so the Action can print
 * turns/steps/usage without streaming model output.
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

function fallbackProgress(events, elapsedSeconds) {
  let turns = 0
  let steps = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0
  for (const event of events) {
    const type = event?.type
    const data = event?.data ?? event
    if (type === 'turn/start') turns += 1
    if (type === 'step/start') steps += 1
    const usage = data?.usage
      ?? (data?.chunk?.type === 'usage' ? data.chunk.usage : undefined)
    if (usage === undefined || typeof usage !== 'object') continue
    if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
      cacheHitTokens += usage.cacheReadTokens ?? 0
      cacheMissTokens += usage.cacheMissTokens ?? usage.inputTokens
      continue
    }
    if (typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      const hit = usage.prompt_cache_hit_tokens
        ?? usage.prompt_tokens_details?.cached_tokens
        ?? 0
      const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit)
      inputTokens += miss
      outputTokens += usage.completion_tokens
      cacheHitTokens += hit
      cacheMissTokens += miss
    }
  }
  return {
    turns,
    steps,
    elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheMissTokens,
  }
}

function usageUnits(progress) {
  return typeof progress.costUsd === 'number' ? progress.costUsd : 0
}

async function loadProgress() {
  const root = process.env.DSH_MIGRATE_APP_ROOT
  if (root) {
    try {
      const mod = await import(`${root}/dist/src/agents/session-status.js`)
      return mod.summarizeSessionEvents
    } catch {
      return fallbackProgress
    }
  }
  return fallbackProgress
}

function isQuotaReason(reason) {
  const code = reason?.error?.code
  const message = reason?.error?.message ?? ''
  return code === 'QUOTA'
    || /insufficient[\s_-]+(?:quota|balance|credits?)/i.test(message)
    || /(?:balance|credits?)[\s_-]+(?:exhausted|depleted)/i.test(message)
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
  const progressOf = await loadProgress()
  const startedAt = Date.now()
  const intervalMs = Number(process.env.DSH_MIGRATE_STATUS_INTERVAL_MS || 10000)

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
  const soFar = Number(process.env.DSH_MIGRATE_USAGE_SO_FAR || 0)
  const limit = Number(process.env.DSH_MIGRATE_USAGE_LIMIT || 0)
  const timer = setInterval(() => {
    try {
      const progress = progressOf(agent.session.events, (Date.now() - startedAt) / 1000, {
        model: process.env.DSH_MIGRATE_MODEL || 'deepseek-v4-pro',
      })
      io.stderr.write(`dsh-migrate-status: ${JSON.stringify(progress)}\n`)
      const used = soFar + usageUnits(progress)
      if (Number.isFinite(limit) && limit > 0 && used >= limit) {
        io.stderr.write(`dsh-migrate: quota limit exceeded: this run spent ${used} USD of limit ${limit}\n`)
        io.exit(1)
      }
    } catch {
      // status is best-effort; never interrupt the session for a print failure
    }
  }, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 10000)
  if (typeof timer.unref === 'function') timer.unref()

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  clearInterval(timer)
  await sessions.flush(agent.session)
  const finalProgress = progressOf(agent.session.events, (Date.now() - startedAt) / 1000, {
    model: process.env.DSH_MIGRATE_MODEL || 'deepseek-v4-pro',
  })
  io.stderr.write(`dsh-migrate-status: ${JSON.stringify(finalProgress)}\n`)
  const used = soFar + usageUnits(finalProgress)
  if (Number.isFinite(limit) && limit > 0 && used >= limit) {
    io.stderr.write(`dsh-migrate: quota limit exceeded: this run spent ${used} USD of limit ${limit}\n`)
    io.exit(1)
    return
  }
  const outcome = summarize(agent.session.events, firstSeq)
  if (isQuotaReason(outcome.reason)) {
    io.stderr.write(`dsh-migrate: insufficient balance: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    io.exit(1)
    return
  }
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
