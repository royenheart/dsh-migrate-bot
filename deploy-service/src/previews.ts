import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJson, writeJson } from './files.ts'
import { failure, json, type Answer } from './http.ts'
import { carry, checkout, freeze, git, type Tree } from './working-copy.ts'
import type { InstanceProvider, InstanceSpec, RunningInstance } from './providers/types.ts'

/**
 * The preview manager: one record per pull request, its working copy, its
 * frozen revisions, and its lifecycle.
 *
 * A preview is created and rebuilt from GitHub `pull_request` events; the
 * Action's verbs act on one that exists. A build checks the head out into a
 * candidate and lets the provider install and boot-check it. Promotion then
 * happens under the preview's lock with the instance stopped: the working
 * copy's change is carried onto the candidate and, when there is one, the
 * candidate is installed and checked again, so what is promoted is exactly
 * what passed. Only then are the directories swapped. A build that fails
 * leaves the working copy and the previous build as they were, and the instance
 * restarts either way.
 *
 * On disk, under `DATA_DIR/previews/<id>/`: `preview.json` (the record),
 * `work/` (the working copy, mounted into the instance), `git/` (its git
 * directory, mounted nowhere), `home/` (the instance's dsh home), `state/` (the
 * launcher's ready file), `sockets/` (the instance's Unix sockets),
 * `revisions/<revision>.diff`, and `unapplied/` (changes that did not carry onto
 * a new head). `DATA_DIR/pull-requests/<id>.json` remembers a pull request that
 * was closed or refused, so a late event does not bring its preview back.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** Frozen revisions, and unapplied changes, kept per preview; older ones are removed. */
export const KEPT = 20
/** The largest diff the Action fetches; a larger change is refused when it is frozen, not when it is fetched. */
const MAX_DIFF_BYTES = 8 * 1024 * 1024

export const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/name')
export const shaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full commit id')
const revisionIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)

const checkSchema = z.object({ check: z.string().max(40), outcome: z.string().max(40) })

export const publishResultSchema = z.object({
  revision: revisionIdSchema,
  outcome: z.enum(['published', 'refused']),
  branch: z.string().max(255),
  commit: z.string().max(64).optional(),
  alreadyPublished: z.literal(true).optional(),
  stage: z.enum(['remote', 'base', 'apply', 'checks', 'push', 'error']).optional(),
  detail: z.string().max(2000).optional(),
  tag: z.string().max(100).optional(),
  checks: z.array(checkSchema).max(20).optional(),
})

const revisionSchema = z.object({
  revision: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  digest: z.string(),
  createdAt: z.string(),
  result: publishResultSchema.extend({ at: z.string() }).optional(),
})

const recordSchema = z.object({
  id: z.string(),
  repository: z.string(),
  pullRequest: z.number().int(),
  cloneUrl: z.string(),
  /** The pull request head, as the last event named it. */
  headSha: z.string(),
  /** The commit the promoted working copy was built from. */
  builtSha: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  building: z.boolean(),
  lastBuild: z.object({ ok: z.boolean(), detail: z.string(), sha: z.string(), at: z.string() }).optional(),
  /** How many revisions this preview has frozen; the next one is numbered after it. */
  revisionCount: z.number().int(),
  revisions: z.array(revisionSchema),
})

export type PreviewRecord = z.output<typeof recordSchema>

/** A pull request that has no preview on purpose. */
const markerSchema = z.object({ closed: z.boolean(), detail: z.string() })

export interface PreviewKey {
  repository: string
  pullRequest: number
}

/** What a `pull_request` event says about a pull request. */
export interface Announcement extends PreviewKey {
  headSha: string
  cloneUrl: string
}

/**
 * The id a preview is known by in paths, container names and URLs.
 *
 * A hash of the pull request, so nothing a repository name contains reaches a
 * path or a command line.
 * @param key - the pull request.
 */
export function previewId(key: PreviewKey): string {
  return createHash('sha256').update(`${key.repository.toLowerCase()}#${String(key.pullRequest)}`).digest('hex').slice(0, 16)
}

export interface PreviewManagerOptions {
  dataDir: string
  publicUrl: string
  ttlDays: number
  idleMinutes: number
  provider: InstanceProvider
  log: (message: string) => void
}

export const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('redeploy'), headSha: z.string().optional() }),
  z.object({ action: z.literal('extend'), days: z.number().int().min(1).max(365), maxTtlDays: z.number().int().min(1).max(365) }),
  z.object({ action: z.literal('publish') }),
])

export class PreviewManager {
  private readonly records = new Map<string, PreviewRecord>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly generations = new Map<string, number>()
  private readonly lastRequest = new Map<string, number>()
  private readonly openSockets = new Map<string, number>()
  private readonly builds = new Set<Promise<void>>()
  private readonly root: string
  private readonly markers: string

  constructor(private readonly options: PreviewManagerOptions) {
    this.root = join(options.dataDir, 'previews')
    this.markers = join(options.dataDir, 'pull-requests')
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.markers, { recursive: true })
  }

  /**
   * Load every record, and reconcile with the provider.
   *
   * Nothing is running after a restart as far as the service knows, so every
   * instance is stopped and starts again on its next visit; a build a restart
   * interrupted is recorded as failed rather than resumed, and its candidate is
   * removed.
   */
  async load(): Promise<void> {
    for (const id of readdirSync(this.root)) {
      const record = readJson(join(this.root, id, 'preview.json'), recordSchema)
      if (record === undefined) continue
      for (const entry of readdirSync(join(this.root, id))) {
        if (entry.includes('.next-') || entry.endsWith('.old')) rmSync(join(this.root, id, entry), { recursive: true, force: true })
      }
      this.records.set(id, record.building
        ? { ...record, building: false, lastBuild: { ok: false, detail: 'The build was interrupted by a restart of the deploy service; redeploy to build again.', sha: record.headSha, at: new Date().toISOString() } }
        : record)
      await this.options.provider.stop(id)
    }
  }

  private dirs(id: string): { root: string; home: string; state: string; sockets: string; revisions: string; unapplied: string } {
    const root = join(this.root, id)
    return { root, home: join(root, 'home'), state: join(root, 'state'), sockets: join(root, 'sockets'), revisions: join(root, 'revisions'), unapplied: join(root, 'unapplied') }
  }

  /** The working copy, or the candidate of one build generation. */
  private tree(id: string, generation?: number): Tree {
    const suffix = generation === undefined ? '' : `.next-${String(generation)}`
    return { gitDir: join(this.root, id, `git${suffix}`), workTree: join(this.root, id, `work${suffix}`) }
  }

  private spec(id: string): InstanceSpec {
    const dirs = this.dirs(id)
    return { id, workDir: this.tree(id).workTree, homeDir: dirs.home, stateDir: dirs.state, socketDir: dirs.sockets }
  }

  private save(record: PreviewRecord): PreviewRecord {
    mkdirSync(this.dirs(record.id).root, { recursive: true })
    writeJson(join(this.dirs(record.id).root, 'preview.json'), record)
    this.records.set(record.id, record)
    return record
  }

  private marker(id: string): z.output<typeof markerSchema> | undefined {
    return readJson(join(this.markers, `${id}.json`), markerSchema)
  }

  /** Run `work` after every earlier locked operation on the same preview. */
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }

  /** The record of a pull request, if it has a preview. */
  find(key: PreviewKey): PreviewRecord | undefined {
    return this.records.get(previewId(key))
  }

  /** The record with this id, if any. */
  byId(id: string): PreviewRecord | undefined {
    return this.records.get(id)
  }

  /** Every record. */
  all(): PreviewRecord[] {
    return [...this.records.values()]
  }

  /** Builds still running; tests wait on them. */
  async settled(): Promise<void> {
    while (this.builds.size > 0) await Promise.all([...this.builds])
  }

  /**
   * A pull request was opened, reopened, or pushed to: record its head and build it.
   *
   * A pull request that was closed stays without a preview until it is reopened.
   * @param event - what the event said.
   * @param reopened - the event was `reopened`.
   * @returns the record, or nothing when the pull request is closed.
   */
  announce(event: Announcement, reopened: boolean): PreviewRecord | undefined {
    const id = previewId(event)
    if (reopened) rmSync(join(this.markers, `${id}.json`), { force: true })
    else if (this.marker(id)?.closed === true) return undefined
    const existing = this.records.get(id)
    const now = new Date()
    const record = this.save(existing === undefined
      ? {
          id,
          repository: event.repository,
          pullRequest: event.pullRequest,
          cloneUrl: event.cloneUrl,
          headSha: event.headSha,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.options.ttlDays * DAY_MS).toISOString(),
          building: false,
          revisionCount: 0,
          revisions: [],
        }
      : { ...existing, cloneUrl: event.cloneUrl, headSha: event.headSha })
    this.rebuild(id)
    return record
  }

  /**
   * A pull request the service will not preview, and why; `status` reports the reason.
   * @param key - the pull request.
   * @param reason - one sentence.
   */
  refuse(key: PreviewKey, reason: string): void {
    const id = previewId(key)
    if (this.marker(id)?.closed === true) return
    writeJson(join(this.markers, `${id}.json`), { closed: false, detail: reason })
    this.options.log(`pull request ${key.repository}#${String(key.pullRequest)}: no preview: ${reason}`)
  }

  /**
   * The pull request was closed: remember that, and remove its preview.
   * @param key - the pull request.
   * @returns whether there was a preview to remove.
   */
  async close(key: PreviewKey): Promise<boolean> {
    const id = previewId(key)
    writeJson(join(this.markers, `${id}.json`), { closed: true, detail: 'The pull request is closed.' })
    if (!this.records.has(id)) return false
    await this.remove(id, 'removed because the pull request was closed')
    return true
  }

  /** Start a build in the background; a newer build supersedes an older one. */
  private rebuild(id: string): void {
    const build = this.build(id).catch((error: unknown) => {
      this.options.log(`preview ${id}: build failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.builds.add(build)
    void build.finally(() => this.builds.delete(build))
  }

  private async build(id: string): Promise<void> {
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    const current = (): boolean => this.generations.get(id) === generation && this.records.has(id)
    const initial = this.records.get(id)
    if (initial === undefined) return
    this.save({ ...initial, building: true })
    const sha = initial.headSha
    const candidate = this.tree(id, generation)
    let outcome: { ok: boolean; detail: string } = { ok: false, detail: 'The build stopped.' }
    this.options.log(`preview ${id}: building ${initial.repository}#${String(initial.pullRequest)} at ${sha.slice(0, 12)}`)
    try {
      const checkedOut = await checkout(candidate, initial.cloneUrl, sha)
      if (!checkedOut.ok) {
        outcome = { ok: false, detail: `Could not check out ${sha.slice(0, 12)}: ${checkedOut.detail}` }
      } else if (!namedPackage(candidate.workTree)) {
        outcome = { ok: false, detail: `Commit ${sha.slice(0, 12)} has no package.json with a name, so there is no plugin to load.` }
      } else {
        outcome = await this.options.provider.build(this.spec(id), candidate.workTree)
      }
      if (!current()) return
      if (outcome.ok) {
        const checked = outcome.detail
        const promoted = await this.locked(id, async () => {
          if (!current()) return undefined
          const result = await this.promote(id, candidate, sha)
          try {
            await this.startLocked(id)
            return result
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            return { ok: false, detail: result.ok ? `The instance did not start: ${why}` : `${result.detail} The previous build did not start again: ${why}` }
          }
        })
        if (promoted === undefined) return
        outcome = promoted.ok ? { ok: true, detail: `${checked}${promoted.detail}` } : promoted
      }
    } catch (error) {
      outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) }
    } finally {
      rmSync(candidate.workTree, { recursive: true, force: true })
      rmSync(candidate.gitDir, { recursive: true, force: true })
      const latest = this.records.get(id)
      if (latest !== undefined && current()) {
        this.save({ ...latest, building: false, lastBuild: { ...outcome, sha, at: new Date().toISOString() } })
        this.options.log(`preview ${id}: ${outcome.ok ? 'promoted' : 'build failed'}: ${outcome.detail}`)
      }
    }
  }

  /**
   * Under the preview's lock: carry the working copy's change onto a checked
   * candidate, check the result again when there was a change, and swap it in.
   *
   * The instance is stopped first, so nothing edits the working copy while its
   * change is read.
   * @returns whether the candidate was promoted, and a sentence about the change.
   */
  private async promote(id: string, candidate: Tree, sha: string): Promise<{ ok: boolean; detail: string }> {
    await this.options.provider.stop(id)
    const work = this.tree(id)
    const record = this.records.get(id)
    let detail = ''
    if (record?.builtSha !== undefined && existsSync(work.workTree)) {
      const frozen = await freeze(work, record.builtSha)
      if (!frozen.ok) return { ok: false, detail: `The working copy's change could not be read, so the new head was not promoted: ${frozen.detail}` }
      if (frozen.diff !== '') {
        const carried = await carry(candidate, frozen.diff)
        if (!carried.ok) {
          detail = ` The working copy's change did not apply to the new head; it is kept as unapplied/${this.keepUnapplied(id, frozen.diff)}.`
          // A three-way apply that conflicted leaves markers in the files and
          // the change in the index; resetting the index and the tracked files
          // returns the candidate to the head that passed the check, and keeps
          // what the install created.
          const reset = await git(candidate, ['reset', '--quiet', '--hard', sha])
          if (!reset.ok) return { ok: false, detail: `The new head could not be restored after a failed apply: ${reset.detail}` }
        } else {
          const checked = await this.options.provider.build(this.spec(id), candidate.workTree)
          if (!checked.ok) {
            return { ok: false, detail: `The new head passed the boot check, but not with the working copy's change carried onto it, so the previous build keeps serving. ${checked.detail}` }
          }
          detail = ' The working copy\'s change was carried onto the new head and checked with it.'
        }
      }
    }
    for (const [from, to] of [[candidate.workTree, work.workTree], [candidate.gitDir, work.gitDir]] as const) {
      rmSync(`${to}.old`, { recursive: true, force: true })
      if (existsSync(to)) renameSync(to, `${to}.old`)
      renameSync(from, to)
      rmSync(`${to}.old`, { recursive: true, force: true })
    }
    const latest = this.records.get(id)
    if (latest !== undefined) this.save({ ...latest, builtSha: sha })
    return { ok: true, detail }
  }

  /** Write a change that did not carry onto a new head, keeping the last `KEPT`; returns its file name. */
  private keepUnapplied(id: string, diff: string): string {
    const dir = this.dirs(id).unapplied
    mkdirSync(dir, { recursive: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.diff`
    writeFileSync(join(dir, name), diff)
    const kept = readdirSync(dir).sort()
    for (const old of kept.slice(0, Math.max(0, kept.length - KEPT))) rmSync(join(dir, old), { force: true })
    return name
  }

  /**
   * Start the instance when it is not running.
   *
   * Under the preview's lock, so a start never overlaps a promotion or a removal.
   * @param id - the preview.
   */
  async ensureRunning(id: string): Promise<RunningInstance> {
    this.lastRequest.set(id, Date.now())
    return this.options.provider.running(id) ?? await this.locked(id, async () => await this.startLocked(id))
  }

  /** `ensureRunning` for a caller that holds the lock. */
  private async startLocked(id: string): Promise<RunningInstance> {
    const running = this.options.provider.running(id)
    if (running !== undefined) return running
    const record = this.records.get(id)
    if (record?.builtSha === undefined || !existsSync(this.tree(id).workTree)) throw new Error('this preview has no build to serve')
    this.lastRequest.set(id, Date.now())
    return await this.options.provider.start(this.spec(id))
  }

  /** Note a request through the proxy, which is what keeps an instance from idling out. */
  touch(id: string): void {
    this.lastRequest.set(id, Date.now())
  }

  /**
   * Note an open WebSocket to the instance; the instance does not idle out while one is open.
   * @param id - the preview.
   * @returns what to call when the socket closes.
   */
  socketOpened(id: string): () => void {
    this.openSockets.set(id, (this.openSockets.get(id) ?? 0) + 1)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.openSockets.set(id, (this.openSockets.get(id) ?? 1) - 1)
      this.touch(id)
    }
  }

  /** The instance's state as the Action's `status` reads it. */
  private state(record: PreviewRecord): Record<string, unknown> {
    const state = record.building
      ? 'building'
      : record.lastBuild?.ok === false
        ? 'failed'
        : this.options.provider.running(record.id) !== undefined ? 'ready' : 'stopped'
    const base = `${this.options.publicUrl}/p/${record.id}/`
    return {
      state,
      ...(record.builtSha === undefined ? {} : { url: base, safeUrl: `${base}safe/`, headSha: record.builtSha }),
      expiresAt: record.expiresAt,
      ...(record.lastBuild?.ok === false ? { detail: record.lastBuild.detail } : {}),
    }
  }

  /**
   * `GET /previews/{repository}/{pullRequest}`.
   *
   * A pull request without a preview answers `{ state: 'none' }` rather than
   * 404, with the reason when it has none on purpose: the Action's `status`
   * then says there is none instead of saying the service could not be asked.
   */
  status(key: PreviewKey): Answer {
    const record = this.find(key)
    if (record !== undefined) return json(200, this.state(record))
    const marker = this.marker(previewId(key))
    return json(200, { state: 'none', ...(marker === undefined ? {} : { detail: marker.detail }) })
  }

  /**
   * `POST /previews/{repository}/{pullRequest}`: redeploy, extend or publish.
   * @param key - the pull request.
   * @param body - the parsed request body.
   */
  async request(key: PreviewKey, body: unknown): Promise<Answer> {
    const parsed = requestSchema.safeParse(body)
    if (!parsed.success) return failure(400, `invalid request: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    const record = this.find(key)
    if (record === undefined) {
      return failure(404, `no preview for ${key.repository}#${String(key.pullRequest)}; the deploy service creates one from the pull request's webhook event`)
    }
    const request = parsed.data
    if (request.action === 'redeploy') {
      // The head is the one the last pull_request event named, never one the
      // caller supplies: a command handler has no checkout of the branch.
      this.rebuild(record.id)
      return json(202, { state: 'building', headSha: record.headSha })
    }
    if (request.action === 'extend') return this.extend(record, request.days, request.maxTtlDays)
    return await this.locked(record.id, async () => await this.publish(record.id))
  }

  private extend(record: PreviewRecord, days: number, maxTtlDays: number): Answer {
    const expires = Date.parse(record.expiresAt)
    const ceiling = Date.parse(record.createdAt) + maxTtlDays * DAY_MS
    const next = Math.min(expires + days * DAY_MS, ceiling)
    if (next <= expires) {
      return failure(409, `the preview already expires at ${record.expiresAt}, the ceiling of ${String(maxTtlDays)} day(s) after it was created`)
    }
    const saved = this.save({ ...record, expiresAt: new Date(next).toISOString() })
    return json(200, { expiresAt: saved.expiresAt })
  }

  private async publish(id: string): Promise<Answer> {
    const record = this.records.get(id)
    const work = this.tree(id)
    const revisionsDir = this.dirs(id).revisions
    if (record?.builtSha === undefined || !existsSync(work.workTree)) return failure(409, 'this preview has no working copy yet')
    const frozen = await freeze(work, record.builtSha)
    if (!frozen.ok) return failure(500, `the working copy could not be frozen: ${frozen.detail}`)
    if (frozen.diff === '') return failure(409, `the working copy has no changes against ${record.builtSha.slice(0, 12)}`)
    if (Buffer.byteLength(frozen.diff) > MAX_DIFF_BYTES) return failure(413, `the working copy's change is larger than the ${String(MAX_DIFF_BYTES / 1024 / 1024)} MiB the Action reads`)
    const digest = createHash('sha256').update(frozen.diff).digest('hex')
    // Re-read: an `extend` may have saved the record while the diff was taken.
    const latestRecord = this.records.get(id) ?? record
    const latest = latestRecord.revisions.at(-1)
    if (latest !== undefined && latest.digest === digest && latest.baseSha === record.builtSha && latest.headSha === latestRecord.headSha && existsSync(join(revisionsDir, `${latest.revision}.diff`))) {
      return json(200, { revision: latest.revision, headSha: latest.headSha })
    }
    const count = latestRecord.revisionCount + 1
    const revision = `r${String(count)}-${digest.slice(0, 12)}`
    mkdirSync(revisionsDir, { recursive: true })
    writeFileSync(join(revisionsDir, `${revision}.diff`), frozen.diff)
    const revisions = [...latestRecord.revisions, { revision, baseSha: record.builtSha, headSha: latestRecord.headSha, digest, createdAt: new Date().toISOString() }]
    for (const pruned of revisions.slice(0, Math.max(0, revisions.length - KEPT))) {
      rmSync(join(revisionsDir, `${pruned.revision}.diff`), { force: true })
    }
    this.save({ ...latestRecord, revisionCount: count, revisions: revisions.slice(-KEPT) })
    return json(200, { revision, headSha: latestRecord.headSha })
  }

  /**
   * `GET /previews/{repository}/{pullRequest}/scratch?revision=`: a frozen revision as a patch.
   * @param key - the pull request.
   * @param revision - the revision id a publish answered.
   */
  scratch(key: PreviewKey, revision: string | null): Answer {
    const record = this.find(key)
    if (record === undefined) return failure(404, 'no preview for this pull request')
    if (revision === null || !revisionIdSchema.safeParse(revision).success) return failure(400, 'name a revision with ?revision=')
    const file = join(this.dirs(record.id).revisions, `${revision}.diff`)
    if (!record.revisions.some(entry => entry.revision === revision) || !existsSync(file)) {
      return failure(404, `revision ${revision} is unknown or has been pruned`)
    }
    return { status: 200, contentType: 'text/x-diff; charset=utf-8', body: readFileSync(file, 'utf8') }
  }

  /**
   * `POST /previews/{repository}/{pullRequest}/publish-result`: how a publish
   * ended, stored with its revision in the preview record.
   * @param key - the pull request.
   * @param body - the parsed request body.
   */
  publishResult(key: PreviewKey, body: unknown): Answer {
    const record = this.find(key)
    if (record === undefined) return failure(404, 'no preview for this pull request')
    const parsed = publishResultSchema.safeParse(body)
    if (!parsed.success) return failure(400, `invalid publish result: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    const result = parsed.data
    if (!record.revisions.some(entry => entry.revision === result.revision)) return failure(404, `revision ${result.revision} is unknown or has been pruned`)
    this.save({
      ...record,
      revisions: record.revisions.map(entry => entry.revision === result.revision ? { ...entry, result: { ...result, at: new Date().toISOString() } } : entry),
    })
    return json(200, { stored: true })
  }

  /**
   * Remove a preview: its instance, its working copy and its revisions.
   * @param key - the pull request.
   */
  async destroy(key: PreviewKey): Promise<Answer> {
    const id = previewId(key)
    if (!this.records.has(id)) return failure(404, `no preview for ${key.repository}#${String(key.pullRequest)}`)
    await this.remove(id, 'destroyed')
    return json(200, { destroyed: true })
  }

  private async remove(id: string, why: string): Promise<void> {
    // A build in progress sees a newer generation and discards its candidate.
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    await this.locked(id, async () => {
      await this.options.provider.destroy(id)
      this.records.delete(id)
      this.lastRequest.delete(id)
      rmSync(this.dirs(id).root, { recursive: true, force: true })
    })
    this.options.log(`preview ${id}: ${why}`)
  }

  /**
   * Stop instances nobody has used for `idleMinutes` and that hold no open
   * WebSocket, and destroy expired previews.
   * @param now - the current time, in milliseconds.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    for (const record of this.all()) {
      if (Date.parse(record.expiresAt) <= now) {
        await this.remove(record.id, `expired at ${record.expiresAt}`)
        continue
      }
      const idle = (): boolean => this.options.provider.running(record.id) !== undefined
        && (this.openSockets.get(record.id) ?? 0) === 0
        && now - (this.lastRequest.get(record.id) ?? 0) > this.options.idleMinutes * 60_000
      if (!idle()) continue
      const stopped = await this.locked(record.id, async () => {
        if (!idle()) return false
        await this.options.provider.stop(record.id)
        return true
      })
      if (stopped) this.options.log(`preview ${record.id}: stopped after ${String(this.options.idleMinutes)} idle minute(s)`)
    }
  }

  /**
   * Create a preview whose working copy holds one change, without GitHub or an instance.
   *
   * Only reachable with `--conformance`, through `X-Conformance: seed`: it lets
   * the conformance suite exercise publish, scratch and publish-result against
   * a service that has no pull request to preview. A redeploy of it fetches
   * from its own git directory and fails, because the seed is not a plugin.
   * @param key - the pull request the seeded preview stands for.
   */
  async seed(key: PreviewKey): Promise<Answer> {
    const id = previewId(key)
    if (this.records.has(id)) await this.remove(id, 'replaced by a seeded preview')
    return await this.locked(id, async () => {
      const work = this.tree(id)
      mkdirSync(work.workTree, { recursive: true })
      writeFileSync(join(work.workTree, 'README.md'), 'A preview seeded by the conformance suite.\n')
      for (const args of [['init', '--quiet'], ['add', '-A'], ['commit', '--quiet', '-m', 'conformance base']]) {
        const result = await git(work, args)
        if (!result.ok) return failure(500, `seeding failed at git ${args[0] ?? ''}: ${result.detail}`)
      }
      const sha = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim()
      writeFileSync(join(work.workTree, 'CONFORMANCE.md'), 'A change for the conformance suite to publish.\n')
      const now = new Date()
      const record = this.save({
        id,
        repository: key.repository,
        pullRequest: key.pullRequest,
        cloneUrl: work.gitDir,
        headSha: sha,
        builtSha: sha,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.options.ttlDays * DAY_MS).toISOString(),
        building: false,
        lastBuild: { ok: true, detail: 'Seeded by the conformance suite; no instance was built.', sha, at: now.toISOString() },
        revisionCount: 0,
        revisions: [],
      })
      return json(201, this.state(record))
    })
  }
}

/** Whether a checkout has a `package.json` with a name, which every plugin has. */
function namedPackage(dir: string): boolean {
  try {
    const name: unknown = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name
    return typeof name === 'string' && name !== ''
  } catch {
    return false
  }
}
