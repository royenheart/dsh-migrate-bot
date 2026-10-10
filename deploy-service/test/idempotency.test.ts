import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdempotencyStore } from '../src/idempotency.ts'
import { json } from '../src/http.ts'
import { pluginRepository, pullRequestEvent, startService } from './support.ts'

const dirs: string[] = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deploy-idem-'))
  dirs.push(dir)
  return dir
}

test('the same key replays the first answer without acting again', async () => {
  const store = new IdempotencyStore(storeDir())
  let acted = 0
  const act = async () => { acted += 1; return json(200, { acted }) }
  const first = await store.run({ method: 'POST', path: '/p', key: 'k' }, act)
  const second = await store.run({ method: 'POST', path: '/p', key: 'k' }, act)
  const otherPath = await store.run({ method: 'POST', path: '/q', key: 'k' }, act)
  assert.deepEqual([first.replayed, second.replayed, otherPath.replayed], [false, true, false])
  assert.equal(second.answer.body, first.answer.body)
  assert.equal(acted, 2)
})

test('concurrent requests with one key act once', async () => {
  const store = new IdempotencyStore(storeDir())
  let acted = 0
  const act = async () => {
    acted += 1
    await new Promise(resolve => setTimeout(resolve, 50))
    return json(200, { acted })
  }
  const results = await Promise.all([1, 2, 3].map(async () => await store.run({ method: 'POST', path: '/p', key: 'k' }, act)))
  assert.equal(acted, 1)
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true, true])
})

test('a failed answer is not stored, so a retry acts', async () => {
  const store = new IdempotencyStore(storeDir())
  let acted = 0
  const act = async () => { acted += 1; return json(acted === 1 ? 503 : 200, { acted }) }
  assert.equal((await store.run({ method: 'POST', path: '/p', key: 'k' }, act)).answer.status, 503)
  const retried = await store.run({ method: 'POST', path: '/p', key: 'k' }, act)
  assert.deepEqual([retried.answer.status, retried.replayed], [200, false])
})

test('after a failed first answer, the requests that waited on it act one at a time', async () => {
  const store = new IdempotencyStore(storeDir())
  let acted = 0
  let concurrent = 0
  let most = 0
  const act = async () => {
    acted += 1
    concurrent += 1
    most = Math.max(most, concurrent)
    const status = acted === 1 ? 503 : 200
    await new Promise(resolve => setTimeout(resolve, 30))
    concurrent -= 1
    return json(status, { acted })
  }
  const results = await Promise.all([1, 2, 3, 4].map(async () => await store.run({ method: 'POST', path: '/p', key: 'k' }, act)))
  assert.equal(most, 1)
  assert.equal(acted, 2, 'the first failed, the second acted, the rest replayed it')
  assert.deepEqual(results.map(result => [result.answer.status, result.replayed]), [[503, false], [200, false], [200, true], [200, true]])
})

test('answers survive a restart and are pruned after the retention', async () => {
  const dir = storeDir()
  await new IdempotencyStore(dir).run({ method: 'POST', path: '/p', key: 'k' }, async () => json(200, { first: true }))
  const restarted = new IdempotencyStore(dir)
  const replay = await restarted.run({ method: 'POST', path: '/p', key: 'k' }, async () => json(200, { first: false }))
  assert.equal(replay.replayed, true)
  assert.match(replay.answer.body, /"first":true/)
  const [file] = readdirSync(dir)
  const old = (Date.now() - restarted.retentionMs - 60_000) / 1000
  utimesSync(join(dir, file ?? ''), old, old)
  assert.equal(restarted.prune(), 1)
  assert.equal((await restarted.run({ method: 'POST', path: '/p', key: 'k' }, async () => json(200, {}))).replayed, false)
})

test('over HTTP: a replayed extend says so, answers the same body, and extends once', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    const event = pullRequestEvent({ action: 'opened', number: 3, sha: repo.head, cloneUrl: repo.origin })
    assert.equal((await service.call('POST', '/github/webhook', { token: null, body: event.body, headers: event.headers })).status, 202)
    await service.previews.settled()
    const extend = { action: 'extend', days: 2, maxTtlDays: 30 }
    const first = await service.call('POST', '/previews/acme%2Fplugin/3', { body: extend, headers: { 'Idempotency-Key': 'comment-1' } })
    const second = await service.call('POST', '/previews/acme%2Fplugin/3', { body: extend, headers: { 'Idempotency-Key': 'comment-1' } })
    assert.equal(first.headers.get('idempotency-replayed'), null)
    assert.equal(second.headers.get('idempotency-replayed'), 'true')
    assert.equal(await second.text(), await first.text())
    const record = service.previews.find({ repository: 'acme/plugin', pullRequest: 3 })
    assert.equal(Date.parse(String(record?.expiresAt)) - Date.parse(String(record?.createdAt)), 9 * 24 * 60 * 60 * 1000)
    // A redelivered webhook is answered, not acted on.
    const builds = service.provider.builds.length
    assert.equal((await service.call('POST', '/github/webhook', { token: null, body: event.body, headers: event.headers })).status, 202)
    await service.previews.settled()
    assert.equal(service.provider.builds.length, builds)
  } finally {
    await service.close()
    repo.cleanup()
  }
})
