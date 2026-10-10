import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJson, writeJson } from './files.ts'
import type { Answer } from './http.ts'

/**
 * Answers already given, by `Idempotency-Key`.
 *
 * The same key on the same method and path is one instruction: the first
 * successful answer is stored in the data directory, and every later request
 * with that key receives it again without the service acting a second time.
 * Only a 2xx answer is stored, so a request that failed can be retried and act.
 * Requests with the same key are handled one at a time: each waits for the one
 * before it, then replays its answer if it was stored, or acts itself if it was
 * not. However many arrive together, at most one acts at a time.
 *
 * Entries are kept for `retentionMs` (seven days by default) and pruned by the
 * service's periodic sweep, which bounds the store by the request rate rather
 * than letting it grow for the life of the deployment.
 */

const DAY_MS = 24 * 60 * 60 * 1000

const entrySchema = z.object({
  createdAt: z.string(),
  method: z.string(),
  path: z.string(),
  answer: z.object({
    status: z.number().int(),
    contentType: z.string(),
    body: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
})

export class IdempotencyStore {
  private readonly turns = new Map<string, Promise<unknown>>()

  /**
   * @param dir - where entries are stored, one file each.
   * @param retentionMs - how long an answer stays replayable.
   */
  constructor(private readonly dir: string, readonly retentionMs: number = 7 * DAY_MS) {
    mkdirSync(dir, { recursive: true })
  }

  /** The file name an instruction is stored under: a hash, so a key is never a path. */
  private file(method: string, path: string, key: string): string {
    const digest = createHash('sha256').update(`${method}\n${path}\n${key}`).digest('hex')
    return join(this.dir, `${digest}.json`)
  }

  /**
   * Run an instruction once per key.
   * @param input.method - the HTTP method.
   * @param input.path - the request path, without the query.
   * @param input.key - the `Idempotency-Key` header.
   * @param act - what the instruction does when it has not been done.
   * @returns the answer, and whether it is a replay of an earlier one.
   */
  async run(input: { method: string; path: string; key: string }, act: () => Promise<Answer>): Promise<{ answer: Answer; replayed: boolean }> {
    const file = this.file(input.method, input.path, input.key)
    const previous = this.turns.get(file) ?? Promise.resolve()
    const turn = previous.catch(() => undefined).then(async () => {
      const stored = this.lookup(file)
      if (stored !== undefined) return { answer: stored, replayed: true }
      const answer = await act()
      if (answer.status >= 200 && answer.status < 300) {
        writeJson(file, { createdAt: new Date().toISOString(), method: input.method, path: input.path, answer })
      }
      return { answer, replayed: false }
    })
    this.turns.set(file, turn)
    try {
      return await turn
    } finally {
      if (this.turns.get(file) === turn) this.turns.delete(file)
    }
  }

  private lookup(file: string): Answer | undefined {
    const entry = readJson(file, entrySchema)
    if (entry === undefined) return undefined
    if (Date.now() - Date.parse(entry.createdAt) > this.retentionMs) return undefined
    const { headers, ...rest } = entry.answer
    return headers === undefined ? rest : { ...rest, headers }
  }

  /**
   * Remove entries older than the retention.
   * @param now - the current time, in milliseconds.
   * @returns how many entries were removed.
   */
  prune(now: number = Date.now()): number {
    let removed = 0
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name)
      try {
        if (now - statSync(path).mtimeMs > this.retentionMs) {
          rmSync(path, { force: true })
          removed += 1
        }
      } catch {
        // Removed by a concurrent prune.
      }
    }
    return removed
  }
}
