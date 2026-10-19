import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { deployRequest, resolveDeployService } from './client.ts'
import type { StreamMessage, WorkerMessage } from './log-stream-worker.ts'
import { externalUrl } from '../render/text.ts'
import type { MigrateConfig } from '../config/schema.ts'

/**
 * The run log stream: every line a run logs, sent to the deploy service, which
 * serves it read-only during and after the run.
 *
 * Best effort in every direction: an absent, slow or failing service is one log
 * line, and a migration never waits for it beyond the final flush. The run is
 * opened here; its events and its finish go out from a worker
 * (`log-stream-worker.ts`), which the run's checks do not block.
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

/** How long a close waits for the worker: the drain, the finish, and a margin. */
const CLOSE_MS = 30_000

export async function openLogStream(input: {
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  repository: string
  runId: string
  /** The `fetch` that opens the run; the worker sends the events with its own. */
  fetchImpl?: typeof fetch | undefined
  log: (message: string) => void
}): Promise<LogStream> {
  if (!input.config.deploy.logStream) return SILENT
  const service = resolveDeployService(input.config, input.env)
  if ('reason' in service) {
    if (input.config.deploy.enabled) input.log(`log stream: ${service.reason}`)
    return SILENT
  }
  const opened = await deployRequest({
    service,
    method: 'POST',
    path: '/runs',
    body: { runId: input.runId, repository: input.repository, kind: 'migration' },
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  if (!opened.ok) {
    input.log(`log stream: ${opened.reason}`)
    return SILENT
  }
  const named = (opened.body as { url?: unknown } | undefined)?.url
  const url = typeof named === 'string' ? externalUrl(named, 300) : undefined
  if (typeof named === 'string' && url === undefined) input.log('log stream: the deploy service named a page this Action will not link')
  input.log(url === undefined ? 'log stream: open' : `log stream: ${url}`)

  // The events go out from a worker: a check blocks this thread while its commands run.
  const worker = new Worker(new URL(`./log-stream-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url), {
    workerData: { service, runPath: `/runs/${encodeURIComponent(input.runId)}` },
  })
  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'report') process.stderr.write(`${message.line}\n`)
  })
  // After the listener, which would hold the process open again: a run that
  // never closes its stream still exits.
  worker.unref()
  let closed: Promise<void> | undefined
  return {
    ...(url === undefined ? {} : { url }),
    publish(message) {
      worker.postMessage({ type: 'event', message, at: new Date().toISOString() } satisfies StreamMessage)
    },
    async close() {
      closed ??= new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          void worker.terminate().then(() => { resolve() })
        }
        // Past the drain and the finish, a worker that has not answered is not waited for.
        const timer = setTimeout(done, CLOSE_MS)
        worker.on('message', (message: WorkerMessage) => { if (message.type === 'closed') done() })
        worker.once('error', done)
        worker.once('exit', done)
        worker.postMessage({ type: 'close' } satisfies StreamMessage)
      })
      await closed
    },
  }
}
