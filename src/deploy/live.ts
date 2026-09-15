import { deployRequest } from './client.ts'
import { resolveDeployTarget } from '../commands/run.ts'
import { resolveRepo } from '../github/pr.ts'
import { externalUrl } from '../render/text.ts'
import type { MigrateConfig } from '../config/schema.ts'

/**
 * The read-only live view of a run.
 *
 * Every line a run already logs goes to the deploy target, which serves it and
 * keeps it after the run ends — the part that is missing today, when the only
 * lasting record of a run is the pull request it produced. The stream is
 * one-way: nothing a viewer does reaches a run, because a migration is an
 * unattended process and interactivity belongs to the preview, which has a
 * different lifetime.
 *
 * It is best effort in every direction. A target that is absent, slow, or
 * rejecting is a logged skip; a migration never fails because a viewer did not
 * answer, exactly as it never fails because a feedback channel could not.
 */

export interface LiveView {
  /** Whether anything is being streamed. */
  enabled: boolean
  /** Where a human watches, when the target named one. */
  url?: string | undefined
  /** Send one line. Never throws and never blocks the caller. */
  publish(message: string): void
  /** Stop streaming and let the queue drain. */
  close(): Promise<void>
}

/** A live view that sends nothing, for every reason a target may be unusable. */
export function disabledLiveView(reason: string, log: (message: string) => void): LiveView {
  log(`live view: ${reason}`)
  return { enabled: false, publish: () => {}, close: async () => {} }
}

/**
 * Open a live view for one run.
 *
 * Opening is the only call that is awaited, so the run has a URL to report
 * before it starts working. The events themselves are queued and drained in
 * order, so a slow target delays the stream rather than the migration.
 * @param input.config - the parsed configuration.
 * @param input.env - environment holding the target's token.
 * @param input.workdir - the plugin repository, for the run's identity.
 * @param input.runId - identifier this run is known by.
 * @param input.fetchImpl - injectable fetch.
 * @param input.log - sink for the one line that says whether a view exists.
 */
export async function openLiveView(input: {
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  workdir: string
  runId: string
  fetchImpl?: typeof fetch | undefined
  log: (message: string) => void
}): Promise<LiveView> {
  if (!input.config.deploy.enabled) {
    return disabledLiveView('no deploy target is configured (`deploy.enabled` is false)', input.log)
  }
  if (!input.config.deploy.liveView) {
    return disabledLiveView('`deploy.liveView` is false', input.log)
  }
  const target = resolveDeployTarget(input.config, input.env)
  if ('reason' in target) return disabledLiveView(target.reason, input.log)

  let repository = 'unknown'
  try {
    const resolved = resolveRepo(input.workdir)
    repository = `${resolved.owner}/${resolved.repo}`
  } catch {
    // A run outside a GitHub checkout can still stream; it just cannot say
    // which repository it belongs to.
  }

  const opened = await deployRequest({
    target,
    method: 'POST',
    path: '/runs',
    body: { runId: input.runId, repository, kind: 'migration' },
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  if (!opened.ok) return disabledLiveView(opened.reason, input.log)
  const raw = (opened.body as { url?: unknown } | undefined)?.url
  // The page the target names is rendered into a step summary, an output, a
  // comment and the log, so it has to be a URL this Action will link to: a
  // scheme that is not http(s), a credential in it, or a value that is not a URL
  // at all leaves the run without a page rather than with a link somebody else
  // chose.
  const url = typeof raw === 'string' ? externalUrl(raw, 300) : undefined
  if (typeof raw === 'string' && raw !== '' && url === undefined) {
    input.log('live view: the target named a page this Action will not link to')
  }
  input.log(url === undefined ? 'live view: streaming' : `live view: ${url}`)

  let seq = 0
  let delivered = 0
  let queue: Promise<void> = Promise.resolve()
  let reported = false
  // A target that has refused once keeps refusing, and every further event
  // would burn a timeout before the run could finish. One failure ends the
  // stream: the design's promise is that a slow target delays the stream
  // rather than the migration, and an unbounded queue of doomed requests
  // breaks exactly that promise.
  let dead = false
  let closed = false
  const publish = (message: string): void => {
    if (dead || closed) return
    seq += 1
    const event = { seq, at: new Date().toISOString(), message }
    queue = queue
      .then(async () => {
        if (dead) return
        const sent = await deployRequest({
          target,
          method: 'POST',
          path: `/runs/${encodeURIComponent(input.runId)}/events`,
          body: event,
          ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
          timeoutMs: 10_000,
        })
        if (sent.ok) {
          delivered += 1
          return
        }
        if (!reported) {
          reported = true
          // Straight to stderr, never through the caller's log: that log feeds
          // this stream, so reporting a stream failure through it would send
          // the report as an event and count it.
          process.stderr.write(`dsh-migrate: live view: ${sent.reason} (stream stopped)\n`)
        }
        dead = true
      })
      .catch(() => {
        dead = true
      })
  }
  return {
    enabled: true,
    ...(url === undefined ? {} : { url }),
    publish,
    close: async () => {
      if (closed) return
      closed = true
      // Draining is bounded: a target that stopped answering must not hold a
      // finished migration open.
      await Promise.race([
        queue,
        new Promise<void>(resolve => { setTimeout(resolve, 5_000) }),
      ])
      const finished = await deployRequest({
        target,
        method: 'POST',
        path: `/runs/${encodeURIComponent(input.runId)}/finish`,
        body: { events: delivered, attempted: seq, complete: delivered === seq },
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      })
      if (!finished.ok) {
        process.stderr.write(`dsh-migrate: live view finish failed, the record is not sealed: ${finished.reason}\n`)
      }
    },
  }
}
