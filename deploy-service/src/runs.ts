import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJson, writeJson } from './files.ts'
import { escapeHtml, failure, json, type Answer } from './http.ts'

/**
 * The run store: the record behind the run log stream.
 *
 * One directory per run, `runs/<runId>/`, with `meta.json` (who opened it, and
 * how it was sealed) and `events.jsonl` (one line per event, in arrival order).
 * `finish` seals the record: what the Action says it delivered is kept next to
 * what was stored, so a reader can tell a whole record from a partial one.
 */

/** A run id is a path segment here, so it is held to a file-name alphabet. */
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'must be 1-128 letters, digits, ".", "_" or "-"')

export const openSchema = z.object({
  runId: runIdSchema,
  repository: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
})

export const eventSchema = z.object({
  seq: z.number().int().min(1),
  at: z.string().min(1).max(64),
  message: z.string(),
})

export const finishSchema = z.object({
  events: z.number().int().min(0),
  attempted: z.number().int().min(0),
  complete: z.boolean(),
})

const metaSchema = z.object({
  runId: z.string(),
  repository: z.string(),
  kind: z.string(),
  openedAt: z.string(),
  stored: z.number().int(),
  finish: finishSchema.extend({ at: z.string() }).optional(),
})

export type RunMeta = z.output<typeof metaSchema>

/** The most one event message may carry; longer text is cut, not refused, so the stream keeps going. */
const MAX_MESSAGE = 16 * 1024
/** The most events one run stores; past this the run refuses, which stops the Action's stream. */
const MAX_EVENTS = 100_000

export class RunStore {
  /**
   * @param dir - `DATA_DIR/runs`.
   * @param publicUrl - the service's public base URL, for the page link.
   */
  constructor(private readonly dir: string, private readonly publicUrl: string) {
    mkdirSync(dir, { recursive: true })
  }

  private paths(runId: string): { dir: string; meta: string; events: string } {
    const dir = join(this.dir, runId)
    return { dir, meta: join(dir, 'meta.json'), events: join(dir, 'events.jsonl') }
  }

  /** The page a person reads the run on. */
  pageUrl(runId: string): string {
    return `${this.publicUrl}/view/${encodeURIComponent(runId)}`
  }

  /**
   * The stored record of a run.
   * @param runId - the run.
   */
  meta(runId: string): RunMeta | undefined {
    if (!runIdSchema.safeParse(runId).success) return undefined
    return readJson(this.paths(runId).meta, metaSchema)
  }

  /**
   * The stored events of a run, in arrival order.
   * @param runId - the run.
   */
  events(runId: string): Array<z.output<typeof eventSchema>> {
    if (!runIdSchema.safeParse(runId).success) return []
    const file = this.paths(runId).events
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').flatMap((line) => {
      const parsed = eventSchema.safeParse(JSON.parse(line))
      return parsed.success ? [parsed.data] : []
    })
  }

  /**
   * `POST /runs`: open a record, or answer for the one already open.
   * @param body - the parsed request body.
   */
  open(body: unknown): Answer {
    const parsed = openSchema.safeParse(body)
    if (!parsed.success) return failure(400, `invalid run: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    const { runId, repository, kind } = parsed.data
    const existing = this.meta(runId)
    if (existing !== undefined && existing.repository !== repository) {
      return failure(409, `run ${runId} is already open for another repository`)
    }
    if (existing === undefined) {
      const paths = this.paths(runId)
      mkdirSync(paths.dir, { recursive: true })
      writeJson(paths.meta, { runId, repository, kind, openedAt: new Date().toISOString(), stored: 0 })
    }
    return json(201, { url: this.pageUrl(runId) })
  }

  /**
   * `POST /runs/{runId}/events`: append one event.
   * @param runId - the run.
   * @param body - the parsed request body.
   */
  append(runId: string, body: unknown): Answer {
    const meta = this.meta(runId)
    if (meta === undefined) return failure(404, `no run ${runId}`)
    if (meta.finish !== undefined) return failure(409, `run ${runId} is sealed`)
    if (meta.stored >= MAX_EVENTS) return failure(413, `run ${runId} holds the most events a run may store`)
    const parsed = eventSchema.safeParse(body)
    if (!parsed.success) return failure(400, `invalid event: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    const event = parsed.data
    const message = event.message.length > MAX_MESSAGE ? `${event.message.slice(0, MAX_MESSAGE)} [cut at ${String(MAX_MESSAGE)} characters]` : event.message
    const paths = this.paths(runId)
    appendFileSync(paths.events, `${JSON.stringify({ seq: event.seq, at: event.at, message })}\n`)
    writeJson(paths.meta, { ...meta, stored: meta.stored + 1 })
    return json(202, { stored: meta.stored + 1 })
  }

  /**
   * `POST /runs/{runId}/finish`: seal the record.
   * @param runId - the run.
   * @param body - the parsed request body.
   */
  finish(runId: string, body: unknown): Answer {
    const meta = this.meta(runId)
    if (meta === undefined) return failure(404, `no run ${runId}`)
    const parsed = finishSchema.safeParse(body)
    if (!parsed.success) return failure(400, `invalid finish: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    if (meta.finish === undefined) {
      writeJson(this.paths(runId).meta, { ...meta, finish: { ...parsed.data, at: new Date().toISOString() } })
    }
    const sealed = this.meta(runId)
    return json(200, { stored: meta.stored, finish: sealed?.finish })
  }

  /**
   * `GET /view/{runId}`: the run as an HTML page, every value escaped.
   * @param runId - the run.
   */
  page(runId: string): Answer {
    const meta = this.meta(runId)
    if (meta === undefined) return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'no such run\n' }
    const events = this.events(runId)
    const sealed = meta.finish === undefined
      ? 'The run is in progress; this page reloads every five seconds.'
      : `The run ended at ${meta.finish.at}. The Action delivered ${String(meta.finish.events)} of ${String(meta.finish.attempted)} event(s); this service stored ${String(meta.stored)}.${meta.finish.complete ? '' : ' The record is incomplete.'}`
    const rows = events.map(event => `<tr><td>${String(event.seq)}</td><td>${escapeHtml(event.at)}</td><td><pre>${escapeHtml(event.message)}</pre></td></tr>`).join('\n')
    const body = [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8">',
      meta.finish === undefined ? '<meta http-equiv="refresh" content="5">' : '',
      `<title>${escapeHtml(meta.repository)} — run ${escapeHtml(meta.runId)}</title>`,
      '<style>body{font-family:sans-serif;margin:2rem}td{vertical-align:top;padding:0 .5rem}pre{margin:0;white-space:pre-wrap}</style>',
      '</head><body>',
      `<h1>${escapeHtml(meta.repository)}</h1>`,
      `<p>Run <code>${escapeHtml(meta.runId)}</code> (${escapeHtml(meta.kind)}), opened at ${escapeHtml(meta.openedAt)}. ${escapeHtml(sealed)}</p>`,
      '<table><thead><tr><th>#</th><th>At</th><th>Message</th></tr></thead><tbody>',
      rows,
      '</tbody></table></body></html>',
      '',
    ].join('\n')
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body,
      headers: { 'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'', 'Referrer-Policy': 'no-referrer' },
    }
  }
}
