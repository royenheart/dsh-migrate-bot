/**
 * Talking to the deploy target the user runs.
 *
 * Every call is best effort. The target is somebody else's service: it can be
 * down, misconfigured, rate-limited, or not exist, and none of that may fail a
 * migration that is otherwise fine. A refusal is returned as a reason for the
 * caller to report, never thrown, which is the same posture the feedback
 * channels take toward their destinations.
 */

import { inline } from '../render/text.ts'

/** Where and with which token to reach the target. */
export interface DeployTarget {
  /** Base URL, without a trailing slash. */
  endpoint: string
  token: string
}

export type DeployResult =
  | {
    ok: true
    detail: string
    body?: unknown
    /**
     * The answer as it arrived.
     *
     * A scratch revision is served as a patch, which is not JSON: without the
     * raw text the one answer this Action has to parse by hand would be lost by
     * the parser.
     */
    text?: string
    /**
     * The target recognised the key and answered with the result it already
     * gave, instead of doing the work again. Reported so the reply can say so
     * rather than implying a second rebuild happened.
     */
    replayed?: true
  }
  | { ok: false; reason: string }

/** How long one call may take before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * How much of an answer is read before it is refused.
 *
 * A timeout bounds the time, not the bytes: a target that streams forever inside
 * its twenty seconds would otherwise be buffered whole by whoever asked. The
 * reader stops pulling at this many bytes, so the cap is a bound rather than a
 * description of what was already paid for.
 */
const MAX_ANSWER_BYTES = 2 * 1024 * 1024

/** How long the outcome report may take before the reply stops waiting for it. */
const REPORT_TIMEOUT_MS = 5_000

/**
 * One request to the target.
 * @param input.target - where and with which token.
 * @param input.method - HTTP method.
 * @param input.path - path under the base URL, starting with `/`.
 * @param input.body - JSON body, when the method takes one.
 * @param input.fetchImpl - injectable fetch.
 * @param input.timeoutMs - how long to wait before abandoning the call.
 */
export async function deployRequest(input: {
  target: DeployTarget
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: unknown
  /**
   * Stable key for this command.
   *
   * Sent so a target can treat a repeat as the same command rather than a new
   * one. A redelivered webhook, a re-run workflow, or a double-posted comment
   * carries the same key, and a target that honours it cannot act twice on one
   * instruction. Only mutating methods carry it: a `GET` has nothing to
   * suppress, and sending it there would ask a target to cache a read.
   */
  idempotencyKey?: string | undefined
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /**
   * What the answer is supposed to be.
   *
   * `json` (the default) refuses an answer that is not JSON, because a page
   * where an API answer was expected is a wrong answer rather than an empty one.
   * A scratch revision is specified as a patch, so it asks for `any`.
   */
  answer?: 'json' | 'any'
  /**
   * How much of the answer to read.
   *
   * A patch is legitimately larger than a status answer, so the budget is the
   * caller's: a frozen revision that exceeds it is refused rather than applied
   * in part.
   */
  maxBytes?: number
}): Promise<DeployResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const url = `${input.target.endpoint}${input.path}`
  try {
    const response = await fetchImpl(url, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.target.token}`,
        'User-Agent': 'dsh-migrate-action',
        ...(input.idempotencyKey === undefined || input.method === 'GET'
          ? {}
          : { 'Idempotency-Key': input.idempotencyKey }),
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      // Caught rather than followed, so the reason can say what happened: a
      // redirect is an answer from something that is not the API — a login page,
      // a moved host — and reporting it as "no instance" would be wrong.
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      const where = response.headers.get('location')
      return {
        ok: false,
        reason: `${url} answered a redirect${where === null ? '' : ` to ${inline(where, 200)}`}, which is not the deploy target's API`,
      }
    }
    const read = await readBounded(response, input.maxBytes ?? MAX_ANSWER_BYTES)
    const text = read.text
    if (!response.ok) {
      // The body is somebody else's text and it reaches a reply a human reads:
      // one line, bounded, whatever the service sent — and the status is kept
      // even when the body ran past the cap.
      const detail = inline(text, 300)
      const note = read.truncated ? ' (the answer was longer than this Action reads)' : ''
      return { ok: false, reason: `${url} answered ${String(response.status)}${detail === '' ? '' : `: ${detail}`}${note}` }
    }
    if (read.truncated) {
      return {
        ok: false,
        reason: `${url} answered more than ${String(input.maxBytes ?? MAX_ANSWER_BYTES)} bytes, or stopped early`,
      }
    }
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      // A 2xx that is not JSON is a page, not an answer: an identity proxy's
      // login form arrives this way, and reporting it as "the target recorded no
      // instance" is a statement the answer does not support.
      if ((input.answer ?? 'json') === 'json') {
        return { ok: false, reason: `${url} answered 2xx with something that is not JSON` }
      }
      parsed = undefined
    }
    return {
      ok: true,
      detail: `${input.method} ${input.path} accepted`,
      text,
      ...(parsed === undefined ? {} : { body: parsed }),
      // Header values are case-insensitive, and a target that answers `True` has
      // replayed just as much as one that answers `true`.
      ...((response.headers.get('Idempotency-Replayed') ?? '').toLowerCase() === 'true'
        ? { replayed: true as const }
        : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${input.method} ${input.path} failed: ${detail}` }
  }
}

/**
 * How a publish ended, as the target is told it.
 *
 * `stage` is present only on a refusal, and names what stopped it: the remote
 * could not be read, the branch moved past the frozen revision, the diff did not
 * apply, a gate refused, or the push was rejected.
 */
export interface PublishOutcome {
  revision: string
  outcome: 'published' | 'refused'
  stage?: 'remote' | 'base' | 'apply' | 'gates' | 'push' | 'error'
  /** The commit that landed, when one did. */
  commit?: string
  /**
   * The commit was already on the branch: this delivery pushed nothing.
   *
   * Without it a preview reads `published` with an empty gate list and cannot
   * tell a fresh push from a retry of one whose reply never arrived.
   */
  alreadyPublished?: true
  branch: string
  /** The harness the gates verified against, when one was resolved. */
  tag?: string
  /** What the gates said, one entry per layer that ran. */
  gates?: { layer: string; ok: boolean; detail?: string }[]
  detail?: string
}

/**
 * Read an answer without trusting its length.
 *
 * `response.text()` buffers whatever the service sends before anything can look
 * at it, which is the opposite of a cap. This pulls chunks until the budget is
 * spent, counts bytes rather than UTF-16 code units, and reports that it stopped
 * rather than pretending the answer ended.
 * @param response - the answer to read.
 */
async function readBounded(
  response: Response,
  budget: number = MAX_ANSWER_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return { text: text + decoder.decode(), truncated: false }
      bytes += chunk.value.byteLength
      if (bytes > budget) {
        await reader.cancel()
        return { text, truncated: true }
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    // A stream that failed mid-answer delivered part of an answer, and a partial
    // answer that is accepted as a whole one is how a truncated patch reaches a
    // branch: it is treated exactly like an answer that ran past the cap.
    return { text, truncated: true }
  }
}

/** The preview's own state, as much of it as a caller can rely on. */
export interface PreviewState {
  /** The target's word for what the instance is doing: `running`, `stopped`, `none`, … */
  state?: string
  url?: string
  safeUrl?: string
  /** The commit the serving build was made from. */
  headSha?: string
  /** When the instance stops being served, ISO 8601, when the target knows. */
  expiresAt?: string
  /** How many days the last `extend` bought, when the target reports it. */
  extendedDays?: number
  /** The revision a publish froze, when the target is holding one. */
  revision?: string
}

function asString(value: unknown): string | undefined {
  // Whitespace is not a value: rendering it produces an empty code span and a
  // dangling comma in a sentence a maintainer reads.
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read a preview's state out of whatever the target answered.
 *
 * Lenient by design: the target is somebody else's service and this is a report,
 * so a field it spells differently is a field that goes unreported rather than a
 * refusal. An answer that is not an object at all yields nothing, which the
 * caller renders as "the target described no instance".
 * @param body - the parsed JSON body of `GET /previews/{repository}/{pullRequest}`.
 */
export function parsePreviewState(body: unknown): PreviewState {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {}
  const record = body as Record<string, unknown>
  const state: PreviewState = {}
  const state_ = asString(record.state) ?? asString(record.status)
  if (state_ !== undefined) state.state = state_
  const url = asString(record.url)
  if (url !== undefined) state.url = url
  const safeUrl = asString(record.safeUrl) ?? asString(record.safe_url)
  if (safeUrl !== undefined) state.safeUrl = safeUrl
  const headSha = asString(record.headSha) ?? asString(record.head_sha)
  if (headSha !== undefined) state.headSha = headSha
  const expiresAt = asString(record.expiresAt) ?? asString(record.expires_at)
  if (expiresAt !== undefined) state.expiresAt = expiresAt
  const extendedDays = record.extendedDays ?? record.extended_days
  if (typeof extendedDays === 'number' && Number.isFinite(extendedDays)) state.extendedDays = extendedDays
  const revision = asString(record.revision)
  if (revision !== undefined) state.revision = revision
  return state
}

/**
 * The four fields a publish must answer with for the hand-back to continue.
 *
 * A target that only acknowledges the request has not frozen anything, and the
 * Action says so rather than pretending a publish happened.
 * @param body - the parsed JSON body of the publish call.
 */
export function parseFrozenRevision(body: unknown): { revision: string; baseSha?: string; headSha?: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const revision = asString(record.revision)
  if (revision === undefined) return undefined
  return {
    revision,
    ...(asString(record.baseSha) === undefined ? {} : { baseSha: asString(record.baseSha) as string }),
    ...(asString(record.headSha) === undefined ? {} : { headSha: asString(record.headSha) as string }),
  }
}

/** What identifies the pull request a command is about. */
export interface PreviewKey {
  repository: string
  pullRequest: number
}

/**
 * The deploy target's preview API, as this Action uses it.
 * @param target - where and with which token.
 * @param fetchImpl - injectable fetch.
 */
export function createDeployClient(
  target: DeployTarget,
  fetchImpl?: typeof fetch,
  idempotencyKey?: string,
): {
  redeploy(key: PreviewKey, headSha?: string): Promise<DeployResult>
  destroy(key: PreviewKey): Promise<DeployResult>
  /**
   * Ask for the preview's expiry to move out.
   *
   * The numbers travel with the request because the target is what enforces
   * them: `days` is what this one command asks for, and `maxTtlDays` is the
   * ceiling the user configured, past which the target must refuse however many
   * commands arrive.
   */
  extend(key: PreviewKey, request: { days: number; maxTtlDays: number }): Promise<DeployResult>
  publish(key: PreviewKey): Promise<DeployResult>
  /**
   * Tell the target how a publish ended.
   *
   * The hand-back is otherwise one-way: the target froze a revision and never
   * learns whether the change reached the branch or which gate refused it, so a
   * preview can only say "published" or nothing at all. Best effort like every
   * other call here — a target that does not implement it is a logged skip.
   */
  publishResult(key: PreviewKey, result: PublishOutcome): Promise<DeployResult>
  status(key: PreviewKey): Promise<DeployResult>
  /** The frozen scratch revision as a diff the Action can apply. */
  scratch(key: PreviewKey, revision: string): Promise<DeployResult>
} {
  const path = (key: PreviewKey): string => `/previews/${encodeURIComponent(key.repository)}/${String(key.pullRequest)}`
  const call = (method: 'GET' | 'POST' | 'DELETE', key: PreviewKey, body?: unknown): Promise<DeployResult> =>
    deployRequest({
      target,
      method,
      path: path(key),
      ...(body === undefined ? {} : { body }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
  return {
    redeploy: (key, headSha) => call('POST', key, { action: 'redeploy', ...(headSha === undefined ? {} : { headSha }) }),
    destroy: key => call('DELETE', key),
    extend: (key, request) => call('POST', key, { action: 'extend', ...request }),
    publish: key => call('POST', key, { action: 'publish' }),
    publishResult: (key, result) =>
      deployRequest({
        target,
        method: 'POST',
        path: `${path(key)}/publish-result`,
        body: result,
        // A report is best effort and it is on the path of the reply, so it gets
        // a shorter budget than a request whose answer the run needs.
        timeoutMs: REPORT_TIMEOUT_MS,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      }),
    status: key => call('GET', key),
    // A read, so it carries no idempotency key: there is nothing to suppress.
    scratch: (key, revision) => deployRequest({
      target,
      method: 'GET',
      path: `${path(key)}/scratch?revision=${encodeURIComponent(revision)}`,
      // A patch is what this call answers with, not JSON.
      answer: 'any',
      // A frozen tree can be a large patch; the answer is still bounded.
      maxBytes: 8 * 1024 * 1024,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  }
}
