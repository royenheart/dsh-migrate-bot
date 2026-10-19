import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { openLogStream } from '../../src/deploy/log-stream.ts'
import { parseConfig } from '../../src/config/load.ts'
import { deployRequest } from '../../src/deploy/client.ts'

const CONFIG = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
const ENV = { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' }

interface Call {
  path: string
  body: string
  /** When the service received it, in ms since the epoch. */
  at: number
}

/**
 * A deploy service that answers `/runs` and records every request in order. It
 * listens in a thread of its own, so it keeps answering while the test's
 * thread is blocked, as a run's thread is during a check.
 */
async function service(options: { openStatus?: number; eventStatus?: number; finishStatus?: number; url?: unknown } = {}): Promise<{
  config: ReturnType<typeof parseConfig>
  calls: () => Promise<Call[]>
  stop: () => Promise<void>
}> {
  const worker = new Worker(`
    const { parentPort, workerData: o } = require('node:worker_threads')
    const calls = []
    const server = require('node:http').createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        calls.push({ path: request.url, body, at: Date.now() })
        const opening = request.url === '/runs'
        const status = opening ? (o.openStatus ?? 200) : request.url.endsWith('/finish') ? (o.finishStatus ?? 200) : (o.eventStatus ?? 200)
        const answer = opening && status === 200 ? JSON.stringify({ url: 'url' in o ? o.url : 'https://deploy.test/view/abc' }) : status === 200 ? '{}' : 'nope'
        response.writeHead(status, { 'content-type': status === 200 ? 'application/json' : 'text/plain' })
        response.end(answer)
      })
    })
    server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }))
    parentPort.on('message', message => {
      if (message === 'calls') parentPort.postMessage({ calls })
      else server.close(() => parentPort.close())
    })
  `, { eval: true, workerData: options })
  const next = async (): Promise<Record<string, unknown>> => await new Promise(resolve => worker.once('message', resolve))
  const { port } = await next() as { port: number }
  return {
    config: parseConfig({ deploy: { enabled: true, endpoint: `http://127.0.0.1:${String(port)}` } }),
    calls: async () => { worker.postMessage('calls'); return (await next()).calls as Call[] },
    stop: async () => { await worker.terminate() },
  }
}

/** Run `body` with stderr captured, and return what it wrote. */
async function captureStderr(body: () => Promise<void>): Promise<string[]> {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    await body()
  } finally {
    process.stderr.write = original
  }
  return written
}

const unreachable: typeof fetch = async () => { throw new Error('the deploy service must not be reached') }

test('no deploy service means a silent stream, and no noise about it', async () => {
  const logs: string[] = []
  const stream = await openLogStream({
    config: parseConfig({}),
    env: {},
    repository: 'me/plugin',
    runId: 'run-1',
    fetchImpl: unreachable,
    log: message => logs.push(message),
  })
  assert.equal(stream.url, undefined)
  stream.publish('anything')
  await stream.close()
  // A consumer that never configured a deploy service did not ask for a stream.
  assert.deepEqual(logs, [])
})

test('a stream turned off on its own reaches nothing', async () => {
  const logs: string[] = []
  const stream = await openLogStream({
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', logStream: false } }),
    env: ENV,
    repository: 'me/plugin',
    runId: 'run-1',
    fetchImpl: unreachable,
    log: message => logs.push(message),
  })
  assert.equal(stream.url, undefined)
  stream.publish('anything')
  await stream.close()
  assert.deepEqual(logs, [])
})

test('an enabled stream with no token is a skip, not a failure', async () => {
  const logs: string[] = []
  const stream = await openLogStream({
    config: CONFIG,
    env: {},
    repository: 'me/plugin',
    runId: 'run-1',
    fetchImpl: unreachable,
    log: message => logs.push(message),
  })
  assert.equal(stream.url, undefined)
  stream.publish('anything')
  await stream.close()
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /DSH_MIGRATE_DEPLOY_TOKEN/)
})

test('a deploy service that refuses the run leaves the migration alone', async () => {
  const logs: string[] = []
  const svc = await service({ openStatus: 500 })
  try {
    const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: 'run-1', log: message => logs.push(message) })
    assert.equal(stream.url, undefined)
    assert.match(logs[0] ?? '', /answered 500/)
    // The stream is silent from then on: no event and no finish reach a service
    // that has no record to put them in.
    stream.publish('anything')
    await stream.close()
    assert.equal((await svc.calls()).length, 1)
  } finally {
    await svc.stop()
  }
})

test('lines stream in order with increasing sequence numbers, and close finishes the run', async () => {
  const logs: string[] = []
  const svc = await service()
  try {
    const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: 'run-7', log: message => logs.push(message) })
    assert.equal(stream.url, 'https://deploy.test/view/abc')
    assert.match(logs.join('\n'), /log stream: https:\/\/deploy\.test\/view\/abc/)
    stream.publish('stage: harness checkout')
    stream.publish('dsh: 3 steps')
    await stream.close()

    const calls = await svc.calls()
    assert.deepEqual(calls.map(call => call.path), ['/runs', '/runs/run-7/events', '/runs/run-7/events', '/runs/run-7/finish'])
    assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { runId: 'run-7', repository: 'me/plugin', kind: 'migration' })
    const events = calls.filter(call => call.path.endsWith('/events')).map(call => JSON.parse(call.body) as { seq: number; message: string })
    assert.deepEqual(events.map(event => event.seq), [1, 2])
    assert.deepEqual(events.map(event => event.message), ['stage: harness checkout', 'dsh: 3 steps'])
    assert.deepEqual(JSON.parse(calls[calls.length - 1]?.body ?? '{}'), { events: 2, attempted: 2, complete: true })
  } finally {
    await svc.stop()
  }
})

test('events go out while the run thread is blocked, as it is while a check runs', async () => {
  const svc = await service()
  try {
    const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: 'run-8', log: () => {} })
    stream.publish('boot check (source release)')
    const blocked = Date.now()
    spawnSync('sleep', ['1.5'])
    const released = Date.now()
    await stream.close()
    const event = (await svc.calls()).find(call => call.path.endsWith('/events'))
    assert.ok(event !== undefined && event.at < released, 'the event reached the service before the block ended')
    assert.ok(event.at >= blocked - 100)
  } finally {
    await svc.stop()
  }
})

test('a run id is one path segment, whatever it contains', async () => {
  const svc = await service()
  try {
    const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: '12/attempt 2', log: () => {} })
    stream.publish('one')
    await stream.close()
    assert.deepEqual((await svc.calls()).slice(1).map(call => call.path), ['/runs/12%2Fattempt%202/events', '/runs/12%2Fattempt%202/finish'])
  } finally {
    await svc.stop()
  }
})

test('the first stream failure reports once and ends the stream', async () => {
  const svc = await service({ eventStatus: 503, finishStatus: 503 })
  try {
    const written = await captureStderr(async () => {
      const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: 'run-9', log: () => {} })
      stream.publish('one')
      stream.publish('two')
      stream.publish('three')
      await stream.close()
    })
    const calls = await svc.calls()
    // A deploy service that refused once keeps refusing, so the stream stops
    // rather than burning a timeout per event for the rest of the run.
    assert.equal(calls.filter(call => call.path.endsWith('/events')).length, 1)
    const reported = written.filter(line => line.includes('stream stopped'))
    assert.equal(reported.length, 1)
    assert.match(reported[0] ?? '', /503/)
    // The finish call this stub also refuses is reported too: a record that was
    // not sealed is exactly the failure a reader needs to hear about.
    assert.match(written.join(''), /not sealed/)
    // The record is still sealed, and says what actually arrived.
    const finish = calls.find(call => call.path.endsWith('/finish'))
    assert.ok(finish, 'a stopped stream still finishes the run')
    assert.deepEqual(JSON.parse(finish.body), { events: 0, attempted: 3, complete: false })
  } finally {
    await svc.stop()
  }
})

test('a stream that never failed seals quietly', async () => {
  const svc = await service()
  try {
    const written = await captureStderr(async () => {
      const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: 'run-10', log: () => {} })
      stream.publish('one')
      await stream.close()
    })
    assert.deepEqual(written.filter(line => line.includes('log stream')), [])
  } finally {
    await svc.stop()
  }
})

test('closing seals the record once, and nothing published after it is sent', async () => {
  const svc = await service()
  try {
    const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: 'run-11', log: () => {} })
    stream.publish('one')
    await Promise.all([stream.close(), stream.close()])
    await stream.close()
    stream.publish('after close')
    // Give a queued post the chance to go out, if one had been queued.
    await new Promise(resolve => setTimeout(resolve, 50))
    const calls = await svc.calls()
    assert.equal(calls.filter(call => call.path.endsWith('/events')).length, 1)
    assert.equal(calls.filter(call => call.path.endsWith('/finish')).length, 1)
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/finish'))?.body ?? '{}'), { events: 1, attempted: 1, complete: true })
  } finally {
    await svc.stop()
  }
})

test('a request to the deploy service never throws, whatever it answers', async () => {
  const failing: typeof fetch = async () => {
    throw new Error('connection refused')
  }
  const result = await deployRequest({
    service: { endpoint: 'https://deploy.test', token: 'x' },
    method: 'POST',
    path: '/runs',
    body: {},
    fetchImpl: failing,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /connection refused/)
})

test('the page a deploy service names is exposed only when it is a page', async () => {
  const open = async (url: unknown): Promise<{ url: string | undefined; logs: string[] }> => {
    const logs: string[] = []
    const svc = await service({ url })
    try {
      const stream = await openLogStream({ config: svc.config, env: ENV, repository: 'me/plugin', runId: 'run-12', log: message => logs.push(message) })
      await stream.close()
      return { url: stream.url, logs }
    } finally {
      await svc.stop()
    }
  }

  // A `)` would end a markdown link early wherever the URL is linked.
  assert.equal((await open('https://deploy.test/view/a)b')).url, 'https://deploy.test/view/a%29b')

  // A credential would be republished and a scheme that is not a page is not
  // one: none is exposed, and the log says a page was refused. A value that is
  // not a string is no URL at all.
  for (const refused of ['https://user:s3cr3t@deploy.test/view', 'javascript:alert(1)']) {
    const { url, logs } = await open(refused)
    assert.equal(url, undefined, refused)
    assert.deepEqual(logs, ['log stream: the deploy service named a page this Action will not link', 'log stream: open'])
    assert.equal(logs.join('\n').includes('s3cr3t'), false)
  }
  const notAString = await open(42)
  assert.deepEqual([notAString.url, notAString.logs], [undefined, ['log stream: open']])

  // No URL at all is a stream that still runs.
  const { url, logs } = await open(undefined)
  assert.equal(url, undefined)
  assert.deepEqual(logs, ['log stream: open'])
})
