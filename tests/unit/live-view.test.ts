import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openLiveView } from '../../src/deploy/live.ts'
import { parseConfig } from '../../src/config/load.ts'
import { deployRequest } from '../../src/deploy/client.ts'

const CONFIG = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
const ENV = { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' }

interface Call {
  url: string
  body: string
}

/** A target that answers `/runs` with a URL and records everything else. */
function target(options: { openStatus?: number; eventStatus?: number } = {}): {
  fetchImpl: typeof fetch
  calls: Call[]
  logs: string[]
} {
  const calls: Call[] = []
  const logs: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    // The repository resolution reads the git remote, not the network.
    if (url.endsWith('/runs')) {
      const status = options.openStatus ?? 200
      return status === 200
        ? new Response(JSON.stringify({ url: 'https://deploy.test/view/abc' }), { status })
        : new Response('nope', { status })
    }
    calls.push({ url, body })
    return new Response('{}', { status: options.eventStatus ?? 200 })
  }
  return { fetchImpl, calls, logs }
}

test('no deploy target means no view, and saying so once', async () => {
  const logs: string[] = []
  const view = await openLiveView({
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    runId: 'run-1',
    log: message => logs.push(message),
  })
  assert.equal(view.enabled, false)
  view.publish('anything')
  await view.close()
  assert.match(logs[0] ?? '', /deploy\.enabled/)
})

test('a view turned off on its own says which switch to look at', async () => {
  const logs: string[] = []
  const view = await openLiveView({
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', liveView: false } }),
    env: ENV,
    workdir: process.cwd(),
    runId: 'run-1',
    log: message => logs.push(message),
  })
  assert.equal(view.enabled, false)
  assert.match(logs[0] ?? '', /deploy\.liveView/)
})

test('an enabled view with no token is a skip, not a failure', async () => {
  const logs: string[] = []
  const view = await openLiveView({
    config: CONFIG,
    env: {},
    workdir: process.cwd(),
    runId: 'run-1',
    log: message => logs.push(message),
  })
  assert.equal(view.enabled, false)
  assert.match(logs[0] ?? '', /DSH_MIGRATE_DEPLOY_TOKEN/)
})

test('a target that refuses the run leaves the migration alone', async () => {
  const logs: string[] = []
  const view = await openLiveView({
    config: CONFIG,
    env: ENV,
    workdir: process.cwd(),
    runId: 'run-1',
    fetchImpl: target({ openStatus: 500 }).fetchImpl,
    log: message => logs.push(message),
  })
  assert.equal(view.enabled, false)
  assert.match(logs[0] ?? '', /answered 500/)
})

test('lines stream in order with increasing sequence numbers, and close finishes the run', async () => {
  const { fetchImpl, calls, logs } = target()
  const view = await openLiveView({
    config: CONFIG,
    env: ENV,
    workdir: process.cwd(),
    runId: 'run-7',
    fetchImpl,
    log: message => logs.push(message),
  })
  assert.equal(view.enabled, true)
  assert.equal(view.url, 'https://deploy.test/view/abc')
  view.publish('stage: harness checkout')
  view.publish('dsh: 3 steps')
  await view.close()

  const events = calls.filter(call => call.url.endsWith('/events'))
  assert.equal(events.length, 2)
  assert.deepEqual(events.map(call => JSON.parse(call.body).seq), [1, 2])
  assert.match(events[0]?.body ?? '', /harness checkout/)
  assert.equal(calls.filter(call => call.url.endsWith('/finish')).length, 1)
  assert.equal(JSON.parse(calls[calls.length - 1]?.body ?? '{}').events, 2)
})

test('the first stream failure reports once and ends the stream', async () => {
  const { fetchImpl, calls } = target({ eventStatus: 503 })
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const view = await openLiveView({
      config: CONFIG,
      env: ENV,
      workdir: process.cwd(),
      runId: 'run-9',
      fetchImpl,
      log: () => {},
    })
    view.publish('one')
    view.publish('two')
    view.publish('three')
    await view.close()
  } finally {
    process.stderr.write = original
  }
  // A target that refused once keeps refusing, so the stream stops rather than
  // burning a timeout per event for the rest of the run.
  assert.equal(calls.filter(call => call.url.endsWith('/events')).length, 1)
  const reported = written.filter(line => line.includes('stream stopped'))
  assert.equal(reported.length, 1)
  assert.match(reported[0] ?? '', /503/)
  // The finish call this stub also refuses is reported too: a record that was
  // not sealed is exactly the failure a viewer needs to hear about.
  assert.match(written.join(''), /not sealed/)
  // The record is still sealed, and says what actually arrived.
  const finish = calls.find(call => call.url.endsWith('/finish'))
  assert.ok(finish, 'a stopped stream still finishes the run')
  assert.deepEqual(JSON.parse(finish.body), { events: 0, attempted: 3, complete: false })
})

test('closing twice seals the record once', async () => {
  const { fetchImpl, calls } = target()
  const view = await openLiveView({
    config: CONFIG,
    env: ENV,
    workdir: process.cwd(),
    runId: 'run-11',
    fetchImpl,
    log: () => {},
  })
  view.publish('one')
  await view.close()
  await view.close()
  view.publish('after close')
  await view.close()
  assert.equal(calls.filter(call => call.url.endsWith('/finish')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/events')).length, 1)
  assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/finish'))?.body ?? '{}'), {
    events: 1,
    attempted: 1,
    complete: true,
  })
})

test('a request to the target never throws, whatever it answers', async () => {
  const failing: typeof fetch = async () => {
    throw new Error('connection refused')
  }
  const result = await deployRequest({
    target: { endpoint: 'https://deploy.test', token: 'x' },
    method: 'POST',
    path: '/runs',
    body: {},
    fetchImpl: failing,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /connection refused/)
})

test('the run page is posted on the thread once, and never at the cost of the run', async () => {
  const { announceLiveView, liveViewAnnouncement } = await import('../../src/deploy/announce.ts')
  const posted: Array<{ issue: number; body: string }> = []
  const lines: string[] = []
  const comment = async (issue: number, body: string): Promise<void> => {
    posted.push({ issue, body })
  }

  await announceLiveView({ url: 'https://deploy.test/view/abc', issueNumber: 12, workdir: '.', comment, log: m => lines.push(m) })
  assert.equal(posted.length, 1)
  assert.equal(posted[0]?.issue, 12)
  assert.match(posted[0]?.body ?? '', /https:\/\/deploy\.test\/view\/abc/)
  assert.equal(posted[0]?.body, liveViewAnnouncement('https://deploy.test/view/abc'))
  assert.match(lines.join('\n'), /link posted on #12/)

  // Nothing to say: no page, or no thread.
  await announceLiveView({ issueNumber: 12, workdir: '.', comment, log: m => lines.push(m) })
  await announceLiveView({ url: 'https://deploy.test/view/abc', workdir: '.', comment, log: m => lines.push(m) })
  assert.equal(posted.length, 1)

  // A refused comment is a line, never a failed migration.
  const refusing = async (): Promise<void> => {
    throw new Error('GitHub POST failed: 403')
  }
  await announceLiveView({ url: 'https://deploy.test/view/abc', issueNumber: 12, workdir: '.', comment: refusing, log: m => lines.push(m) })
  assert.match(lines.join('\n'), /could not be posted on #12: GitHub POST failed: 403/)
})

test('the announcement answers the question its message asks', async () => {
  const { announceLiveView, liveViewAnnouncement } = await import('../../src/deploy/announce.ts')
  const posted: string[] = []
  const logs: string[] = []
  await announceLiveView({
    url: 'https://deploy.test/view/abc',
    issueNumber: 12,
    workdir: '.',
    comment: async (_issue, body) => { posted.push(body) },
    log: message => logs.push(message),
  })
  // A literal, not the function compared with itself: the wording is what a
  // maintainer reads, and it has to say why the link is worth opening.
  assert.equal(
    posted[0],
    'This run can be watched at https://deploy.test/view/abc — read-only, and the target keeps the log after the run ends.',
  )
  assert.equal(liveViewAnnouncement('https://deploy.test/view/abc'), posted[0])

  // No thread: the skip says so rather than staying silent.
  await announceLiveView({
    url: 'https://deploy.test/view/abc',
    workdir: '.',
    comment: async () => { throw new Error('never called') },
    log: message => logs.push(message),
  })
  assert.match(logs.join('\n'), /no issue was opened, so the link stays in the step summary/)
})

/**
 * The run's ending is a unit (`pipeline/finish.ts`) precisely so that this is
 * reachable: a test that spawns a whole migration needs an API key, a harness
 * install and an agent session, which is why "the run names its own page" was
 * the one behaviour nothing pinned.
 */
test('the summary names the run page when there is one', async () => {
  const { renderStepSummary } = await import('../../src/github/summary.ts')
  const base = {
    status: 'compatible' as const,
    target: { tag: 'dsh-v0.1.6', version: '0.1.6' },
    pluginName: 'plugin',
    runDir: '/tmp/run',
    result: {
      mechanical: { ok: true, errors: '', log: '', checks: 1 },
      fixAttempts: 0,
      skippedReview: true,
    },
  }
  const withView = renderStepSummary({ ...base, liveViewUrl: 'https://deploy.test/a%29b' } as never)
  assert.match(withView, /\[Watch this run\]\(https:\/\/deploy\.test\/a%29b\)/)
  const without = renderStepSummary(base as never)
  assert.doesNotMatch(without, /Watch this run/)
})

test('a finished run names its page on the run page and on the thread', async () => {
  const { finishRun } = await import('../../src/pipeline/finish.ts')
  const summaries: string[] = []
  const posted: Array<{ issue: number; body: string }> = []
  const logs: string[] = []
  const result = {
    status: 'migrated' as const,
    mechanical: { ok: true, errors: '', log: '', checks: 1 },
    fixAttempts: 0,
    skippedReview: false,
    published: { issueNumber: 12, issueUrl: 'https://github.com/me/plugin/issues/12', pullRequestUrl: 'https://github.com/me/plugin/pull/13' },
  } as never

  const summary = await finishRun({
    view: { url: 'https://deploy.test/view/abc' },
    result,
    target: { tag: 'dsh-v0.1.6', version: '0.1.6' },
    pluginName: 'plugin',
    runDir: '/tmp/run',
    workdir: '.',
    token: 'ghs_read',
    writeSummary: markdown => { summaries.push(markdown); return true },
    comment: async (issue, body) => { posted.push({ issue, body }) },
    log: message => logs.push(message),
  })

  assert.match(summary, /\[Watch this run\]\(https:\/\/deploy\.test\/view\/abc\)/)
  assert.equal(summaries[0], summary)
  assert.equal(posted.length, 1)
  assert.equal(posted[0]?.issue, 12)
  assert.match(posted[0]?.body ?? '', /https:\/\/deploy\.test\/view\/abc/)
  assert.match(logs.join('\n'), /link posted on #12/)

  // A run with no target served no page: the summary simply has no link, and
  // nothing is posted.
  posted.length = 0
  const bare = await finishRun({
    view: {},
    result,
    target: { tag: 'dsh-v0.1.6', version: '0.1.6' },
    pluginName: 'plugin',
    runDir: '/tmp/run',
    workdir: '.',
    token: 'ghs_read',
    writeSummary: () => true,
    comment: async (issue, body) => { posted.push({ issue, body }) },
    log: () => {},
  })
  assert.doesNotMatch(bare, /Watch this run/)
  assert.equal(posted.length, 0)

  // A run that may not comment posts nothing, and the summary still carries the
  // page it can name.
  const noToken = await finishRun({
    view: { url: 'https://deploy.test/view/abc' },
    result,
    target: { tag: 'dsh-v0.1.6', version: '0.1.6' },
    pluginName: 'plugin',
    runDir: '/tmp/run',
    workdir: '.',
    token: undefined,
    writeSummary: () => true,
    comment: async (issue, body) => { posted.push({ issue, body }) },
    log: () => {},
  })
  assert.match(noToken, /Watch this run/)
  assert.equal(posted.length, 0)

  // A summary that cannot be written is logged, not thrown.
  const logs2: string[] = []
  await finishRun({
    view: { url: 'https://deploy.test/view/abc' },
    result,
    target: { tag: 'dsh-v0.1.6', version: '0.1.6' },
    pluginName: 'plugin',
    runDir: '/tmp/run',
    workdir: '.',
    token: undefined,
    writeSummary: () => false,
    comment: undefined,
    log: message => logs2.push(message),
  })
  assert.match(logs2.join('\n'), /Watch this run/)
})

test('a run page that cannot be rendered does not fail the run, and the thread still gets the link', async () => {
  const { finishRun } = await import('../../src/pipeline/finish.ts')
  const posted: Array<{ issue: number; body: string }> = []
  const logs: string[] = []
  // A result the renderer cannot read: the run itself finished.
  const broken = { status: 'migrated', published: { issueNumber: 12 } } as never
  const summary = await finishRun({
    view: { url: 'https://deploy.test/view/abc' },
    result: broken,
    target: { tag: 'dsh-v0.1.6', version: '0.1.6' },
    pluginName: 'plugin',
    runDir: '/tmp/run',
    workdir: '.',
    token: 'ghs_read',
    writeSummary: () => true,
    comment: async (issue, body) => { posted.push({ issue, body }) },
    log: message => logs.push(message),
  })
  assert.equal(summary, '')
  assert.match(logs.join('\n'), /the run page could not be rendered/)
  // The page the run streamed is still named where a person is.
  assert.equal(posted.length, 1)
  assert.match(posted[0]?.body ?? '', /https:\/\/deploy\.test\/view\/abc/)
})
