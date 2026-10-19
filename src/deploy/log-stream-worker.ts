import { parentPort, workerData } from 'node:worker_threads'
import { deployRequest, type DeployService } from './client.ts'
import { createSender } from './log-stream-sender.ts'

/**
 * The log stream's worker: it sends what the run thread queues.
 *
 * A check runs its commands synchronously, which stops the run thread's event
 * loop for as long as the check takes. A request sent from there would neither
 * leave nor be answered until the check ended, and then time out at once;
 * this thread's loop keeps running through every check.
 */

/** What the run thread sends: a line to stream, or the end of the run. */
export type StreamMessage = { type: 'event'; message: string; at: string } | { type: 'close' }
/** What this worker answers: a failure to report, or that the record is sealed. */
export type WorkerMessage = { type: 'report'; line: string } | { type: 'closed' }

const port = parentPort
const { service, runPath } = workerData as { service: DeployService; runPath: string }
if (port !== null) {
  const tell = (message: WorkerMessage): void => { port.postMessage(message) }
  const sender = createSender(
    async (path, body, timeoutMs) => await deployRequest({ service, method: 'POST', path, body, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    runPath,
    line => tell({ type: 'report', line }),
  )
  port.on('message', (message: StreamMessage) => {
    if (message.type === 'event') sender.publish(message.message, message.at)
    else void sender.close().then(() => { tell({ type: 'closed' }) })
  })
}
