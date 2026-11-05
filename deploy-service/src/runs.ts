import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { inspectDataSchema } from '#action/observability/evidence-schema.js'
import { readJson, writeJson, writeJsonCompact } from './files.ts'
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
  openedAt: z.iso.datetime().optional(),
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

const evidenceSchema = inspectDataSchema

const metaSchema = z.object({
  runId: z.string(),
  repository: z.string(),
  kind: z.string(),
  openedAt: z.string(),
  stored: z.number().int(),
  finish: finishSchema.extend({ at: z.string() }).optional(),
  evidence: z.boolean().optional(),
})

export type RunMeta = z.output<typeof metaSchema>

/** The most one event message may carry; longer text is cut, not refused, so the stream keeps going. */
const MAX_MESSAGE = 16 * 1024
/** The most events one run stores; past this the run refuses, which stops the Action's stream. */
const MAX_EVENTS = 100_000
/** The most one evidence bundle may store; prompts and manifests are text. */
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024

export class RunStore {
  /**
   * @param dir - `DATA_DIR/runs`.
   * @param publicUrl - the service's public base URL, for the page link.
   */
  constructor(private readonly dir: string, private readonly publicUrl: string, private readonly evidenceSite?: string) {
    mkdirSync(dir, { recursive: true })
  }

  private paths(runId: string): { dir: string; meta: string; events: string; evidence: string } {
    const dir = join(this.dir, runId)
    return { dir, meta: join(dir, 'meta.json'), events: join(dir, 'events.jsonl'), evidence: join(dir, 'inspect.json') }
  }

  /**
   * Delete run records older than the retention window.
   * @param days - how long a run record is kept.
   * @param now - the clock, injected for tests.
   * @returns the number of records deleted.
   */
  prune(days: number, now = Date.now()): number {
    let deleted = 0
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const meta = this.meta(entry.name)
      if (meta === undefined) continue
      const opened = Date.parse(meta.openedAt)
      if (!Number.isFinite(opened) || now - opened < days * 24 * 60 * 60 * 1000) continue
      rmSync(this.paths(entry.name).dir, { recursive: true, force: true })
      deleted += 1
    }
    return deleted
  }

  /** The page a person reads the run on. */
  pageUrl(runId: string): string {
    return `${this.publicUrl}/view/${encodeURIComponent(runId)}`
  }

  /** The JSON evidence endpoint, or the benchmark page that can load it. */
  evidenceUrl(runId: string): string {
    const bundle = `${this.publicUrl}/view/${encodeURIComponent(runId)}/inspect.json`
    return this.evidenceSite === undefined ? bundle : `${this.evidenceSite}/inspect.html?data=${encodeURIComponent(bundle)}&credentials=include`
  }

  corsHeaders(): Record<string, string> {
    if (this.evidenceSite === undefined) return { 'Access-Control-Allow-Origin': '*' }
    return { 'Access-Control-Allow-Origin': new URL(this.evidenceSite).origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' }
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
      try {
        const parsed = eventSchema.safeParse(JSON.parse(line))
        return parsed.success ? [parsed.data] : []
      } catch {
        return []
      }
    })
  }

  /**
   * `POST /runs`: open a record, or answer for the one already open.
   * @param body - the parsed request body.
   */
  open(body: unknown): Answer {
    const parsed = openSchema.safeParse(body)
    if (!parsed.success) return failure(400, `invalid run: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    const { runId, repository, kind, openedAt } = parsed.data
    const existing = this.meta(runId)
    if (existing !== undefined && existing.repository !== repository) {
      return failure(409, `run ${runId} is already open for another repository`)
    }
    if (existing === undefined) {
      const paths = this.paths(runId)
      mkdirSync(paths.dir, { recursive: true })
      writeJson(paths.meta, { runId, repository, kind, openedAt: openedAt ?? new Date().toISOString(), stored: 0 })
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
   * `GET /view/{runId}/inspect.json`: the stored run evidence bundle.
   * @param runId - the run.
   */
  evidence(runId: string): Answer {
    const meta = this.meta(runId)
    if (meta === undefined) return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'no evidence for this run\n', headers: this.corsHeaders() }
    const data = readJson(this.paths(runId).evidence, evidenceSchema)
    if (data === undefined) return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'no evidence for this run\n', headers: this.corsHeaders() }
    return { status: 200, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(data)}\n`, headers: { 'Cache-Control': 'no-store', ...this.corsHeaders() } }
  }

  /**
   * `POST /runs/{runId}/evidence`: store one bundle beside the run.
   * @param runId - the run.
   * @param body - the parsed bundle.
   */
  saveEvidence(runId: string, body: unknown): Answer {
    const meta = this.meta(runId)
    if (meta === undefined) return failure(404, `no run ${runId}`)
    const parsed = evidenceSchema.safeParse(body)
    if (!parsed.success) return failure(400, `invalid evidence: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    if (!parsed.data.runs.some(run => run.runId === runId && run.manifest.runId === runId && run.manifest.migrationId === parsed.data.migrationId)) return failure(400, 'evidence does not contain the run named by the route')
    const serialized = JSON.stringify(parsed.data)
    if (Buffer.byteLength(serialized) > MAX_EVIDENCE_BYTES) return failure(413, `evidence is larger than ${String(MAX_EVIDENCE_BYTES)} bytes`)
    const existing = this.paths(runId).evidence
    if (existsSync(existing)) {
      const current = readJson(existing, evidenceSchema)
      if (current !== undefined && isDeepStrictEqual(current, parsed.data)) {
        this.markEvidence(runId)
        return json(200, { url: this.evidenceUrl(runId) })
      }
      // Upgrade a bundle written before the current-run/history format; later
      // formats remain immutable so two Actions cannot race the same run.
      if (current !== undefined && current.history === undefined && parsed.data.history !== undefined && current.migrationId === parsed.data.migrationId) {
        writeJsonCompact(existing, parsed.data)
        this.markEvidence(runId)
        return json(200, { url: this.evidenceUrl(runId) })
      }
      return failure(409, 'evidence is already stored for this run')
    }
    writeJsonCompact(existing, parsed.data)
    this.markEvidence(runId)
    return json(200, { url: this.evidenceUrl(runId) })
  }

  private markEvidence(runId: string): void {
    const meta = this.meta(runId)
    if (meta !== undefined) writeJson(this.paths(runId).meta, { ...meta, evidence: true })
  }

  page(runId: string): Answer {
    const meta = this.meta(runId)
    if (meta === undefined) return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'no such run\n' }
    const events = this.events(runId)
    const sealed = meta.finish === undefined
      ? 'The run is in progress; this page reloads every five seconds.'
      : `The run ended at ${meta.finish.at}. The Action delivered ${String(meta.finish.events)} of ${String(meta.finish.attempted)} event(s); this service stored ${String(meta.stored)}.${meta.finish.complete ? '' : ' The record is incomplete.'}`
    const evidenceExists = meta.evidence === true ? existsSync(this.paths(runId).evidence) : readJson(this.paths(runId).evidence, evidenceSchema) !== undefined
    const finishedAt = meta.finish === undefined ? undefined : Date.parse(meta.finish.at)
    const refresh = meta.finish === undefined || (!evidenceExists && finishedAt !== undefined && Number.isFinite(finishedAt) && Date.now() - finishedAt < 60_000)
    const rows = events.map(event => `<tr><td>${String(event.seq)}</td><td>${escapeHtml(event.at)}</td><td><pre>${escapeHtml(event.message)}</pre></td></tr>`).join('\n')
    const current = events
      .flatMap(event => {
        const match = /^dsh-migrate-state:\s*([a-z][A-Za-z0-9]*)\s*$/.exec(event.message)
        return match?.[1] === undefined ? [] : [{ seq: event.seq, state: match[1] }]
      })
      .sort((left, right) => left.seq - right.seq)
      .at(-1)?.state
    const body = [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8">',
      refresh ? '<meta http-equiv="refresh" content="5">' : '',
      `<title>${escapeHtml(meta.repository)} — run ${escapeHtml(meta.runId)}</title>`,
      '<style>body{font-family:sans-serif;margin:2rem}td{vertical-align:top;padding:0 .5rem}pre{margin:0;white-space:pre-wrap}</style>',
      '</head><body>',
      `<h1>${escapeHtml(meta.repository)}</h1>`,
      `<p>Run <code>${escapeHtml(meta.runId)}</code> (${escapeHtml(meta.kind)}), opened at ${escapeHtml(meta.openedAt)}. ${escapeHtml(sealed)}</p>`,
      ...(current === undefined ? [] : [`<p>State: <code>${escapeHtml(current)}</code></p>`]),
      ...(evidenceExists ? [`<p><a href="${escapeHtml(this.evidenceUrl(runId))}">Open run evidence</a></p>`] : []),
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
