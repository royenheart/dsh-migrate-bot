import { randomInt } from 'node:crypto'
import { configSchema } from '#action/config/schema.js'
import { createDeployClient, deployRequest, parseFrozenRevision, parsePreviewState, type DeployResult, type DeployService, type PreviewKey } from '#action/deploy/client.js'
import { openLogStream } from '#action/deploy/log-stream.js'
import { externalUrl } from '#action/render/text.js'

/**
 * The deploy service contract, exercised from the Action's side.
 *
 * Every call goes through the Action's own client (`src/deploy/client.ts` and
 * `src/deploy/log-stream.ts`, compiled into this package), so a check passes
 * exactly when a consumer's run would accept the answer. The suite needs a URL
 * and a token; the preview checks also need a preview, which is either named
 * (`preview`) or seeded through `X-Conformance: seed` when the service runs in
 * conformance mode.
 */

export interface ConformanceOptions {
  service: DeployService
  /** The service runs with `--conformance`: seed a preview and check the client's refusals. */
  conformance: boolean
  /** An existing preview to exercise; it must hold a change that has not been published. */
  preview?: PreviewKey | undefined
}

export interface CheckOutcome {
  name: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
}

type Check = () => Promise<string>

class Skip extends Error {}

/** A fetch that adds `X-Conformance` to every request, so the service misbehaves on cue. */
function misbehaving(mode: string): typeof fetch {
  return async (input, init) => await fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'X-Conformance': mode } })
}

function expectOk(result: DeployResult, what: string): asserts result is Extract<DeployResult, { ok: true }> {
  if (!result.ok) throw new Error(`${what}: ${result.reason}`)
}

/**
 * Run every check and report each one.
 * @param options - where the service is, and what it may be asked to do.
 */
export async function runConformance(options: ConformanceOptions): Promise<CheckOutcome[]> {
  const { service } = options
  const outcomes: CheckOutcome[] = []
  const check = async (name: string, body: Check): Promise<void> => {
    try {
      outcomes.push({ name, status: 'pass', detail: await body() })
    } catch (error) {
      outcomes.push({ name, status: error instanceof Skip ? 'skip' : 'fail', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const suffix = `${String(Date.now())}-${String(randomInt(1_000_000))}`

  await check('a wrong token is refused with 401', async () => {
    const wrong = await deployRequest({ service: { ...service, token: `${service.token}-wrong` }, method: 'GET', path: '/previews/conformance%2Fsuite/1' })
    if (wrong.ok || !/ answered 401\b/.test(wrong.reason)) throw new Error(`expected 401, got ${wrong.ok ? 'a 2xx' : wrong.reason}`)
    const missing = await deployRequest({ service: { ...service, token: '' }, method: 'POST', path: '/runs', body: { runId: `conformance-${suffix}`, repository: 'conformance/suite', kind: 'migration' } })
    if (missing.ok || !/ answered 401\b/.test(missing.reason)) throw new Error(`expected 401 without a token, got ${missing.ok ? 'a 2xx' : missing.reason}`)
    return 'GET and POST without the right token answered 401'
  })

  const runId = `conformance-${suffix}`
  await check('POST /runs answers the page a person watches', async () => {
    const opened = await deployRequest({ service, method: 'POST', path: '/runs', body: { runId, repository: 'conformance/suite', kind: 'migration' } })
    expectOk(opened, 'POST /runs')
    const named = (opened.body as { url?: unknown } | undefined)?.url
    if (typeof named !== 'string') throw new Error('the answer has no `url`')
    if (externalUrl(named, 300) === undefined) throw new Error(`the Action will not link ${named}`)
    return named
  })

  await check('events and finish are accepted', async () => {
    for (const seq of [1, 2, 3]) {
      expectOk(await deployRequest({ service, method: 'POST', path: `/runs/${encodeURIComponent(runId)}/events`, body: { seq, at: new Date().toISOString(), message: `conformance event ${String(seq)}` }, timeoutMs: 10_000 }), `event ${String(seq)}`)
    }
    expectOk(await deployRequest({ service, method: 'POST', path: `/runs/${encodeURIComponent(runId)}/finish`, body: { events: 3, attempted: 3, complete: true } }), 'finish')
    return 'three events and a finish'
  })

  await check('the Action\'s run log stream opens, delivers, and seals', async () => {
    const config = configSchema.parse({ deploy: { enabled: true, endpoint: service.endpoint } })
    const lines: string[] = []
    const errors: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const stream = await openLogStream({
        config,
        env: { [config.deploy.tokenEnv]: service.token },
        repository: 'conformance/suite',
        runId: `${runId}-stream`,
        log: (line) => { lines.push(line) },
      })
      for (let index = 1; index <= 5; index += 1) stream.publish(`line ${String(index)}`)
      await stream.close()
      if (stream.url === undefined) throw new Error(`the stream opened without a page it would link: ${lines.join(' | ')}`)
    } finally {
      process.stderr.write = write
    }
    if (errors.length > 0) throw new Error(errors.join(' ').trim())
    return lines.join(' | ')
  })

  let preview = options.preview
  let seeded = false
  await check('a preview to exercise', async () => {
    if (preview !== undefined) return `${preview.repository}#${String(preview.pullRequest)}, as named`
    if (!options.conformance) throw new Skip('no preview: name one with --preview owner/name#N, or pass --conformance to a service started with --conformance')
    const key = { repository: 'conformance/suite', pullRequest: randomInt(1, 1_000_000_000) }
    expectOk(await deployRequest({ service, method: 'POST', path: `/previews/${encodeURIComponent(key.repository)}/${String(key.pullRequest)}`, body: {}, fetchImpl: misbehaving('seed') }), 'seeding a preview')
    preview = key
    seeded = true
    return `${key.repository}#${String(key.pullRequest)}, seeded`
  })

  const needPreview = (): PreviewKey => {
    if (preview === undefined) throw new Skip('no preview to exercise')
    return preview
  }
  const client = (key?: string) => createDeployClient(service, undefined, key)

  await check('GET a preview answers its state', async () => {
    const answer = await client().status(needPreview())
    expectOk(answer, 'status')
    const state = parsePreviewState(answer.body)
    if (state.state === undefined) throw new Error('the answer has no `state`')
    return JSON.stringify(state)
  })

  await check('the same Idempotency-Key replays the first answer and does not act again', async () => {
    const key = needPreview()
    const extend = client(`conformance-extend-${suffix}`)
    const first = await extend.extend(key, { days: 1, maxTtlDays: 365 })
    expectOk(first, 'extend')
    if (first.replayed === true) throw new Error('the first request was marked as a replay')
    const before = parsePreviewState((await client().status(key) as { body?: unknown }).body).expiresAt
    const second = await extend.extend(key, { days: 1, maxTtlDays: 365 })
    expectOk(second, 'the repeated extend')
    if (second.replayed !== true) throw new Error('the repeat did not carry Idempotency-Replayed: true')
    if (second.text !== first.text) throw new Error('the repeat answered a different body')
    const after = parsePreviewState((await client().status(key) as { body?: unknown }).body).expiresAt
    if (before !== after) throw new Error(`the repeat moved the expiry again (${String(before)} → ${String(after)})`)
    return `replayed, expiry unchanged at ${String(after)}`
  })

  let revision: string | undefined
  await check('publish freezes a revision, and a replayed publish names the same one', async () => {
    const key = needPreview()
    const publisher = client(`conformance-publish-${suffix}`)
    const first = await publisher.publish(key)
    expectOk(first, 'publish')
    const frozen = parseFrozenRevision(first.body)
    if (frozen === undefined) throw new Error('the answer froze no `revision`')
    const second = await publisher.publish(key)
    expectOk(second, 'the repeated publish')
    if (second.replayed !== true) throw new Error('the repeat did not carry Idempotency-Replayed: true')
    if (parseFrozenRevision(second.body)?.revision !== frozen.revision) throw new Error('the repeat named another revision')
    revision = frozen.revision
    return JSON.stringify(frozen)
  })

  await check('the frozen revision is served as a diff', async () => {
    const key = needPreview()
    if (revision === undefined) throw new Skip('no revision was frozen')
    const answer = await client().scratch(key, revision)
    expectOk(answer, 'scratch')
    const diff = typeof answer.body === 'object' && answer.body !== null && typeof (answer.body as { diff?: unknown }).diff === 'string'
      ? (answer.body as { diff: string }).diff
      : answer.text ?? ''
    if (diff.trim() === '') throw new Error('the revision was served as an empty diff')
    return `${String(diff.split('\n').length)} line(s)`
  })

  await check('an unknown revision is not served', async () => {
    const answer = await client().scratch(needPreview(), `conformance-unknown-${suffix}`)
    if (answer.ok) throw new Error('an unknown revision answered 2xx')
    return answer.reason
  })

  await check('publish-result is accepted', async () => {
    const key = needPreview()
    if (revision === undefined) throw new Skip('no revision was frozen')
    const answer = await client().publishResult(key, {
      revision,
      outcome: 'refused',
      branch: 'conformance',
      stage: 'checks',
      detail: 'reported by the conformance suite; nothing was pushed',
      tag: 'dsh-v0.0.0',
      checks: [{ check: 'mechanical', outcome: 'skipped' }],
    })
    expectOk(answer, 'publish-result')
    return answer.detail
  })

  await check('redeploy is accepted', async () => {
    const answer = await client(`conformance-redeploy-${suffix}`).redeploy(needPreview())
    expectOk(answer, 'redeploy')
    return answer.detail
  })

  await check('destroy removes the preview', async () => {
    const key = needPreview()
    if (!seeded) throw new Skip('the preview was named, not seeded, so the suite leaves it in place')
    expectOk(await client(`conformance-destroy-${suffix}`).destroy(key), 'destroy')
    const after = await client().status(key)
    const state = after.ok ? parsePreviewState(after.body) : {}
    if (state.url !== undefined || (state.state !== undefined && state.state !== 'none')) {
      throw new Error(`the preview is still described: ${after.ok ? after.text ?? '' : ''}`)
    }
    return 'destroyed'
  })

  const refusals: Array<[string, string, RegExp]> = [
    ['the client refuses an answer slower than its timeout', 'slow', /abort|timeout|timed out/i],
    ['the client refuses an answer larger than 2 MiB', 'oversize', /more than \d+ bytes/],
    ['the client refuses a redirect', 'redirect', /redirect/],
  ]
  await Promise.all(refusals.map(async ([name, mode, reason]) => {
    await check(name, async () => {
      if (!options.conformance) throw new Skip('needs --conformance and a service started with --conformance')
      const answer = await createDeployClient(service, misbehaving(mode)).status({ repository: 'conformance/suite', pullRequest: 1 })
      if (answer.ok) throw new Error(`the client accepted the ${mode} answer; is the service running with --conformance?`)
      if (!reason.test(answer.reason)) throw new Error(`refused for another reason: ${answer.reason}`)
      return answer.reason
    })
  }))
  return outcomes
}
