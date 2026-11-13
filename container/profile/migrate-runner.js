/**
 * One-shot dsh runner for the migrate profile, derived from the
 * `@deepseek-ai/dsh-headless` driver of the pinned agent runtime.
 *
 * It differs from the stock driver in two ways: progress lines go to stderr as
 * `dsh-migrate-status: …` every few seconds so the Action can print turns,
 * steps and usage, and the spend cap is enforced while the session runs.
 * LLM text is written to stdout only after the session is idle.
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

function usageUnits(progress) {
  return typeof progress.costUsd === 'number' ? progress.costUsd : 0
}

async function loadProgress() {
  // The session accounting is the Action's own, so a session is counted and
  // priced exactly as the spend cap and the reports count it.
  const root = process.env.DSH_MIGRATE_APP_ROOT
  if (!root) throw new Error('DSH_MIGRATE_APP_ROOT is not set; dsh-migrate passes it to every session')
  const mod = await import(`${root}/dist/src/agents/session-status.js`)
  return mod.summarizeSessionEvents
}

async function loadTrace() {
  const root = process.env.DSH_MIGRATE_APP_ROOT
  if (!root) return undefined
  try {
    return await import(`${root}/dist/src/agents/session-trace.js`)
  } catch {
    // The trace is an improvement; an older Action image without it still runs.
    return undefined
  }
}

async function loadObservation() {
  const root = process.env.DSH_MIGRATE_APP_ROOT
  if (!root) return undefined
  try {
    return await import(`${root}/dist/src/agents/session-observation.js`)
  } catch {
    // Observation is an improvement; a run without it keeps the status counter.
    return undefined
  }
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
  const current = { ...selection, provider, model }
  const progressOf = await loadProgress()
  const traceLevel = process.env.DSH_MIGRATE_TRACE_LEVEL || 'summary'
  const traceModule = await loadTrace()
  const traceOf = traceLevel === 'off' ? undefined : traceModule
  const explicitSecrets = (() => { try { const parsed = JSON.parse(process.env.DSH_MIGRATE_SECRET_VALUES ?? '[]'); return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [] } catch { return [] } })()
  const traceSecrets = traceModule === undefined || typeof traceModule.traceSecrets !== 'function' ? explicitSecrets : traceModule.traceSecrets(process.env, explicitSecrets)
  const traceState = {}
  const traceKind = process.env.DSH_MIGRATE_TRACE_KIND || ''
  const eventToken = process.env.DSH_MIGRATE_EVENT_TOKEN || ''
  const observationOf = process.env.DSH_MIGRATE_OBSERVATIONS === '1' ? await loadObservation() : undefined
  const startedAt = Date.now()
  const intervalMs = Number(process.env.DSH_MIGRATE_STATUS_INTERVAL_MS || 10000)

  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider, model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current, assembled: undefined })
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  let traceCursor = firstSeq
  let observationCursor = firstSeq
  const emitTrace = () => {
    if (traceOf === undefined) return
    try {
      const events = agent.session.snapshotEvents()
      let emitted = 0
      for (const event of events) {
        const seq = typeof event.seq === 'number' ? event.seq : undefined
        if (seq === undefined || seq < traceCursor) continue
        const lines = traceOf.translateSessionEvent(event, traceState, {
          secrets: traceSecrets,
          maxChars: 2000,
          includeText: traceKind !== 'report',
          toolResults: traceLevel === 'full' ? 'full' : 'summary',
        })
        if (lines.length === 0) {
          traceCursor = seq + 1
          continue
        }
        if (emitted + lines.length > 20) {
          io.stderr.write(`${traceOf.encodeTraceLine('… further events omitted from this tick', eventToken)}\n`)
          return
        }
        for (const line of lines) {
          io.stderr.write(`${traceOf.encodeTraceLine(line, eventToken)}\n`)
          emitted += 1
        }
        traceCursor = seq + 1
      }
    } catch {
      // A trace failure must never interrupt the session; the counter still runs.
    }
  }
  const emitObservations = (limit = 100) => {
    if (observationOf === undefined || typeof observationOf.translateObservation !== 'function') return 0
    try {
      const events = agent.session.snapshotEvents()
      let emitted = 0
      for (const event of events) {
        const seq = typeof event.seq === 'number' ? event.seq : undefined
        if (seq === undefined || seq < observationCursor) continue
        const observation = observationOf.translateObservation(event, { secrets: traceSecrets, maxChars: 4000 })
        if (observation === undefined) {
          observationCursor = seq + 1
          continue
        }
        if (emitted >= limit) return
        observationCursor = seq + 1
        io.stderr.write(`${observationOf.encodeObservationLine(observation, eventToken)}\n`)
        emitted += 1
      }
    } catch {
      // Observation is evidence; never interrupt the session for it.
    }
    return emitted
  }
  const soFar = Number(process.env.DSH_MIGRATE_USAGE_SO_FAR || 0)
  const limit = Number(process.env.DSH_MIGRATE_USAGE_LIMIT || 0)
  const timer = setInterval(() => {
    try {
      const progress = progressOf(agent.session.snapshotEvents(), (Date.now() - startedAt) / 1000, {
        model: process.env.DSH_MIGRATE_MODEL || 'deepseek-v4-flash',
      })
      io.stderr.write(`dsh-migrate-status: ${JSON.stringify(progress)}\n`)
      emitTrace()
      emitObservations()
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
  emitTrace()
  for (let pass = 0; pass < 100; pass += 1) {
    if (emitObservations(500) === 0) break
  }
  await sessions.flush(agent.session)
  const finalProgress = progressOf(agent.session.snapshotEvents(), (Date.now() - startedAt) / 1000, {
    model: process.env.DSH_MIGRATE_MODEL || 'deepseek-v4-flash',
  })
  io.stderr.write(`dsh-migrate-status: ${JSON.stringify(finalProgress)}\n`)
  const used = soFar + usageUnits(finalProgress)
  if (Number.isFinite(limit) && limit > 0 && used >= limit) {
    io.stderr.write(`dsh-migrate: quota limit exceeded: this run spent ${used} USD of limit ${limit}\n`)
    io.exit(1)
    return
  }
  const outcome = summarize(agent.session.snapshotEvents(), firstSeq)
  if (isQuotaReason(outcome.reason)) {
    io.stderr.write(`dsh-migrate: insufficient balance: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    io.exit(1)
    return
  }
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh-migrate: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    // The dsh error carries the real failure as `cause`; without it a wrapped
    // code like REQUEST_EXTENSION says nothing about what actually broke.
    io.stderr.write(`dsh-migrate: reason ${JSON.stringify(outcome.reason)}\n`)
    for (const line of describeCauses(outcome.reason.error)) io.stderr.write(`dsh-migrate: cause: ${line}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Flatten an error's `cause` chain into one line per link.
 * @param {unknown} error - the outermost error.
 * @returns {string[]} one description per cause, outermost first.
 */
function describeCauses(error) {
  const lines = []
  let current = error?.cause
  let depth = 0
  while (current !== undefined && current !== null && depth < 6) {
    const name = current?.constructor?.name ?? typeof current
    const code = current?.code === undefined ? '' : `${current.code}: `
    const message = current?.message ?? String(current)
    lines.push(`${name} ${code}${message}`.trim())
    current = current.cause
    depth += 1
  }
  return lines
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
