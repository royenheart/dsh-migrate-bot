import { deployRequest } from './client.ts'
import { resolveDeployService } from '../commands/run.ts'
import { externalUrl } from '../render/text.ts'
import type { MigrateConfig } from '../config/schema.ts'

/**
 * The run log stream: every line a run logs, sent to the deploy service, which
 * serves it read-only during and after the run.
 *
 * Best effort in every direction: an absent, slow or failing service is one log
 * line, and a migration never waits for it beyond the final flush.
 */

export interface LogStream {
  /** Where a person reads the stream, when the service named a page. */
  url?: string | undefined
  /** Queue one line. Never throws and never blocks. */
  publish(message: string): void
  /** Flush the queue and seal the record. */
  close(): Promise<void>
}

const SILENT: LogStream = { publish: () => {}, close: async () => {} }

export async function openLogStream(input: {
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  repository: string
  runId: string
  fetchImpl?: typeof fetch | undefined
  log: (message: string) => void
}): Promise<LogStream> {
  if (!input.config.deploy.logStream) return SILENT
  const service = resolveDeployService(input.config, input.env)
  if ('reason' in service) {
    if (input.config.deploy.enabled) input.log(`log stream: ${service.reason}`)
    return SILENT
  }
  const request = (path: string, body: unknown, timeoutMs?: number) => deployRequest({
    service,
    method: 'POST',
    path,
    body,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  const opened = await request('/runs', { runId: input.runId, repository: input.repository, kind: 'migration' })
  if (!opened.ok) {
    input.log(`log stream: ${opened.reason}`)
    return SILENT
  }
  const named = (opened.body as { url?: unknown } | undefined)?.url
  const url = typeof named === 'string' ? externalUrl(named, 300) : undefined
  if (typeof named === 'string' && url === undefined) input.log('log stream: the deploy service named a page this Action will not link')
  input.log(url === undefined ? 'log stream: open' : `log stream: ${url}`)

  const runPath = `/runs/${encodeURIComponent(input.runId)}`
  let seq = 0
  let delivered = 0
  let stopped = false
  let closed: Promise<void> | undefined
  let queue: Promise<void> = Promise.resolve()
  return {
    ...(url === undefined ? {} : { url }),
    publish(message) {
      if (stopped) return
      seq += 1
      const event = { seq, at: new Date().toISOString(), message }
      queue = queue.then(async () => {
        if (stopped) return
        const sent = await request(`${runPath}/events`, event, 10_000)
        if (sent.ok) delivered += 1
        else {
          stopped = true
          process.stderr.write(`dsh-migrate: log stream stopped: ${sent.reason}\n`)
        }
      })
    },
    async close() {
      closed ??= (async () => {
        await Promise.race([queue, new Promise<void>((resolve) => { setTimeout(resolve, 5_000).unref() })])
        stopped = true
        const finished = await request(`${runPath}/finish`, { events: delivered, attempted: seq, complete: delivered === seq })
        if (!finished.ok) process.stderr.write(`dsh-migrate: log stream not sealed: ${finished.reason}\n`)
      })()
      await closed
    },
  }
}
