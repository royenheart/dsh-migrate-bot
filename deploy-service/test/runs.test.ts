import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './support.ts'

test('a run is opened, receives events, and is sealed by finish', async () => {
  const service = await startService()
  try {
    const opened = await service.call('POST', '/runs', { body: { runId: '42-1', repository: 'acme/plugin', kind: 'migration' } })
    assert.equal(opened.status, 201)
    assert.deepEqual(await opened.json(), { url: 'http://127.0.0.1:1/view/42-1' })
    for (const seq of [1, 2, 3]) {
      const sent = await service.call('POST', '/runs/42-1/events', { body: { seq, at: '2026-10-10T00:00:00Z', message: seq === 2 ? '<script>alert(1)</script>' : `line ${String(seq)}` } })
      assert.equal(sent.status, 202)
    }
    const finished = await service.call('POST', '/runs/42-1/finish', { body: { events: 3, attempted: 4, complete: false } })
    assert.equal(finished.status, 200)
    const record = await finished.json() as { stored: number; finish: { events: number; attempted: number; complete: boolean } }
    assert.equal(record.stored, 3)
    assert.deepEqual([record.finish.events, record.finish.attempted, record.finish.complete], [3, 4, false])
    // Sealed: a late event is refused rather than appended to a closed record.
    assert.equal((await service.call('POST', '/runs/42-1/events', { body: { seq: 4, at: 'x', message: 'late' } })).status, 409)

    const page = await service.call('GET', '/view/42-1')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /delivered 3 of 4 event\(s\); this service stored 3\. The record is incomplete\./)
  } finally {
    await service.close()
  }
})

test('a run id is a file name, and a run belongs to one repository', async () => {
  const service = await startService()
  try {
    assert.equal((await service.call('POST', '/runs', { body: { runId: '../escape', repository: 'acme/plugin', kind: 'migration' } })).status, 400)
    assert.equal((await service.call('POST', '/runs', { body: { runId: 'r1', repository: 'acme/plugin', kind: 'migration' } })).status, 201)
    assert.equal((await service.call('POST', '/runs', { body: { runId: 'r1', repository: 'acme/plugin', kind: 'migration' } })).status, 201)
    assert.equal((await service.call('POST', '/runs', { body: { runId: 'r1', repository: 'other/plugin', kind: 'migration' } })).status, 409)
    assert.equal((await service.call('POST', '/runs/unknown/events', { body: { seq: 1, at: 'x', message: 'm' } })).status, 404)
    assert.equal((await service.call('POST', '/runs/r1/events', { body: { seq: 0, at: 'x', message: 'm' } })).status, 400)
  } finally {
    await service.close()
  }
})

test('the run page needs the token unless PUBLIC_VIEWS is set', async () => {
  const closed = await startService()
  try {
    await closed.call('POST', '/runs', { body: { runId: 'r1', repository: 'acme/plugin', kind: 'migration' } })
    assert.equal((await closed.call('GET', '/view/r1', { token: null })).status, 401)
    assert.equal((await closed.call('GET', '/view/r1')).status, 200)
  } finally {
    await closed.close()
  }
  const open = await startService({ publicViews: true })
  try {
    await open.call('POST', '/runs', { body: { runId: 'r1', repository: 'acme/plugin', kind: 'migration' } })
    assert.equal((await open.call('GET', '/view/r1', { token: null })).status, 200)
    assert.equal((await open.call('GET', '/view/missing', { token: null })).status, 404)
    // The API is not a page: PUBLIC_VIEWS never opens it.
    assert.equal((await open.call('POST', '/runs', { token: null, body: { runId: 'r2', repository: 'acme/plugin', kind: 'migration' } })).status, 401)
  } finally {
    await open.close()
  }
})
