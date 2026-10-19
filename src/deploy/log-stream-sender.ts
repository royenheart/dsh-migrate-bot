import type { DeployResult } from './client.ts'

/**
 * The sending half of the run log stream: one event per line, in order, and a
 * finish that says how many arrived. It runs in the log stream's worker
 * (`log-stream-worker.ts`), off the thread whose checks block it.
 *
 * The first event the service does not take stops the stream: a service that
 * refused once keeps refusing, and every further event would cost a timeout.
 */

/** One POST to the deploy service. */
export type Post = (path: string, body: unknown, timeoutMs?: number) => Promise<DeployResult>

export interface Sender {
  /** Queue one line, logged at `at`. */
  publish(message: string, at: string): void
  /** Wait a bounded time for the queue, then seal the record. */
  close(): Promise<void>
}

/** How long one event may take; the finish has its own. */
const EVENT_TIMEOUT_MS = 10_000
/** How long a close waits for the events still queued. */
const DRAIN_MS = 5_000

/**
 * @param post - the request to the deploy service.
 * @param runPath - `/runs/{runId}`, the run's path on the service.
 * @param report - where a failure is told, once.
 */
export function createSender(post: Post, runPath: string, report: (line: string) => void): Sender {
  let seq = 0
  let delivered = 0
  let stopped = false
  let closed: Promise<void> | undefined
  let queue: Promise<void> = Promise.resolve()
  return {
    publish(message, at) {
      if (stopped) return
      seq += 1
      const event = { seq, at, message }
      queue = queue.then(async () => {
        if (stopped) return
        const sent = await post(`${runPath}/events`, event, EVENT_TIMEOUT_MS)
        if (sent.ok) delivered += 1
        else {
          stopped = true
          report(`dsh-migrate: log stream stopped: ${sent.reason}`)
        }
      })
    },
    async close() {
      closed ??= (async () => {
        await Promise.race([queue, new Promise<void>((resolve) => { setTimeout(resolve, DRAIN_MS).unref() })])
        stopped = true
        const finished = await post(`${runPath}/finish`, { events: delivered, attempted: seq, complete: delivered === seq })
        if (!finished.ok) report(`dsh-migrate: log stream not sealed: ${finished.reason}`)
      })()
      await closed
    },
  }
}
