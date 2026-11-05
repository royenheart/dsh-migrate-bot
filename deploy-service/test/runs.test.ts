import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startService } from './support.ts'

test('a run is opened, receives events, and is sealed by finish', async () => {
  const service = await startService()
  try {
    const opened = await service.call('POST', '/runs', { body: { runId: '42-1', repository: 'acme/plugin', kind: 'migration' } })
    assert.equal(opened.status, 201)
    assert.deepEqual(await opened.json(), { url: 'http://127.0.0.1:1/view/42-1' })
    for (const seq of [1, 2, 3]) {
      const sent = await service.call('POST', '/runs/42-1/events', { body: { seq, at: '2026-10-10T00:00:00Z', message: seq === 2 ? '<script>alert(1)</script>' : seq === 3 ? 'dsh-migrate-state: awaitingMerge' : `line ${String(seq)}` } })
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
    assert.match(html, /http-equiv="refresh" content="5"/)
    assert.match(html, /delivered 3 of 4 event\(s\); this service stored 3\. The record is incomplete\./)
    assert.match(html, /<p>State: <code>awaitingMerge<\/code><\/p>/)
    assert.doesNotMatch(html, /<p>State: <code><img/)
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

test('the latest valid state wins and a spoofed state is not shown', async () => {
  const service = await startService()
  try {
    assert.equal((await service.call('POST', '/runs', { body: { runId: 'state-1', repository: 'acme/plugin', kind: 'migration' } })).status, 201)
    assert.equal((await service.call('POST', '/runs/state-1/events', { body: { seq: 1, at: 'x', message: 'dsh-migrate-state: checking' } })).status, 202)
    assert.equal((await service.call('POST', '/runs/state-1/events', { body: { seq: 3, at: 'x', message: 'dsh-migrate-state: awaitingMerge' } })).status, 202)
    assert.equal((await service.call('POST', '/runs/state-1/events', { body: { seq: 2, at: 'x', message: 'dsh-migrate-state: <img src=x onerror=alert(1)>' } })).status, 202)
    assert.equal((await service.call('POST', '/runs/state-1/finish', { body: { events: 3, attempted: 3, complete: true } })).status, 200)
    const html = await (await service.call('GET', '/view/state-1')).text()
    assert.match(html, /<p>State: <code>awaitingMerge<\/code><\/p>/)
    assert.doesNotMatch(html, /<img src=x/)
  } finally {
    await service.close()
  }
})

test('run evidence is stored once and served beside the run', async () => {
  const service = await startService()
  try {
    await service.call('POST', '/runs', { body: { runId: 'evidence-1', repository: 'acme/plugin', kind: 'migration' } })
    const evidence = {
      migrationId: '0.2.0',
      runs: [{ runId: 'evidence-1', manifest: { runId: 'evidence-1', migrationId: '0.2.0', startedAt: '2026-10-01T00:00:00.000Z', workflow: {}, target: {}, sessions: [{ name: 'overlap' }] }, prompts: { overlap: 'review\n' } }],
      warnings: [],
    }
    assert.equal((await service.call('POST', '/runs/evidence-1/evidence', { body: { ...evidence, runs: [{ ...evidence.runs[0]!, manifest: { ...evidence.runs[0]!.manifest, workflow: { graph: {} } } }] } })).status, 400)
    assert.equal((await service.call('POST', '/runs/evidence-1/evidence', { body: { ...evidence, runs: [{ ...evidence.runs[0]!, manifest: { ...evidence.runs[0]!.manifest, totals: { usd: 'free' } } }] } })).status, 400)
    const saved = await service.call('POST', '/runs/evidence-1/evidence', { body: evidence })
    assert.equal(saved.status, 200)
    assert.deepEqual(await saved.json(), { url: 'http://127.0.0.1:1/view/evidence-1/inspect.json' })
    const served = await service.call('GET', '/view/evidence-1/inspect.json', { token: null })
    assert.equal(served.status, 401)
    const evidenceAnswer = await service.call('GET', '/view/evidence-1/inspect.json')
    assert.equal(evidenceAnswer.status, 200)
    assert.equal(evidenceAnswer.headers.get('access-control-allow-origin'), '*')
    assert.deepEqual(await evidenceAnswer.json(), evidence)
    assert.equal((await service.call('GET', '/view/evidence-1')).status, 200)
    const evidencePage = await (await service.call('GET', '/view/evidence-1')).text()
    assert.match(evidencePage, /Open run evidence/)
    assert.equal((await service.call('POST', '/runs/evidence-1/evidence', { body: evidence })).status, 200)
    assert.equal((await service.call('POST', '/runs/evidence-1/evidence', { body: { ...evidence, warnings: ['changed'] } })).status, 409)
    assert.equal((await service.call('POST', '/runs/evidence-1/evidence', { body: { runs: [] } })).status, 400)
    assert.equal((await service.call('POST', '/runs/evidence-1/evidence', { body: { ...evidence, runs: [{ ...evidence.runs[0], manifest: { ...evidence.runs[0]!.manifest, runId: 'other' } }] } })).status, 400)
    assert.equal((await service.call('GET', '/view/..%2Fprivate/inspect.json')).status, 404)
  } finally {
    await service.close()
  }
})


test('the evidence link opens the integrated site when EVIDENCE_URL is set', async () => {
  const service = await startService({ evidenceUrl: 'https://report.example' })
  try {
    await service.call('POST', '/runs', { body: { runId: 'evidence-2', repository: 'acme/plugin', kind: 'migration' } })
    const evidence = { migrationId: '0.2.0', runs: [{ runId: 'evidence-2', manifest: { runId: 'evidence-2', migrationId: '0.2.0', startedAt: '2026-10-01T00:00:00.000Z', workflow: {}, target: {}, sessions: [{ name: 'overlap' }] }, prompts: {} }] }
    assert.equal((await service.call('POST', '/runs/evidence-2/evidence', { body: evidence })).status, 200)
    const page = await (await service.call('GET', '/view/evidence-2')).text()
    assert.match(page, /https:\/\/report\.example\/inspect\.html\?data=([^"&]+)/)
    const evidenceAnswer = await service.call('GET', '/view/evidence-2/inspect.json')
    assert.equal(evidenceAnswer.headers.get('access-control-allow-origin'), 'https://report.example')
    assert.equal(evidenceAnswer.headers.get('access-control-allow-credentials'), 'true')
    const missing = await service.call('GET', '/view/missing/inspect.json')
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('access-control-allow-origin'), 'https://report.example')
  } finally {
    await service.close()
  }
})

test('evidence accepts a legitimate zero-session run', async () => {
  const service = await startService()
  try {
    await service.call('POST', '/runs', { body: { runId: 'evidence-zero', repository: 'acme/plugin', kind: 'migration' } })
    const evidence = {
      migrationId: '0.2.0',
      runs: [{ runId: 'evidence-zero', manifest: { runId: 'evidence-zero', migrationId: '0.2.0', startedAt: '2026-10-01T00:00:00.000Z', workflow: {}, target: {}, sessions: [] }, prompts: {} }],
    }
    assert.equal((await service.call('POST', '/runs/evidence-zero/evidence', { body: evidence })).status, 200)
    assert.equal((await service.call('GET', '/view/evidence-zero/inspect.json')).status, 200)
  } finally {
    await service.close()
  }
})


test('an evidence file written before the flag is still linked and heals on re-upload', async () => {
  const service = await startService()
  try {
    await service.call('POST', '/runs', { body: { runId: 'evidence-old', repository: 'acme/plugin', kind: 'migration' } })
    const evidence = { migrationId: '0.2.0', runs: [{ runId: 'evidence-old', manifest: { runId: 'evidence-old', migrationId: '0.2.0', startedAt: '2026-10-01T00:00:00.000Z', workflow: {}, target: {}, sessions: [] }, prompts: {} }] }
    assert.equal((await service.call('POST', '/runs/evidence-old/evidence', { body: evidence })).status, 200)
    const metaPath = join(service.dataDir, 'runs', 'evidence-old', 'meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { evidence?: boolean }
    delete meta.evidence
    writeFileSync(metaPath, JSON.stringify(meta))
    assert.match(await (await service.call('GET', '/view/evidence-old')).text(), /Open run evidence/)
    assert.equal((await service.call('POST', '/runs/evidence-old/evidence', { body: evidence })).status, 200)
    assert.equal((JSON.parse(readFileSync(metaPath, 'utf8')) as { evidence?: boolean }).evidence, true)
  } finally {
    await service.close()
  }
})


test('the retention sweep deletes runs older than the window', async () => {
  const service = await startService()
  try {
    await service.call('POST', '/runs', { body: { runId: 'old-run', repository: 'acme/plugin', kind: 'migration' } })
    const metaPath = join(service.dataDir, 'runs', 'old-run', 'meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { openedAt: string }
    meta.openedAt = '2020-01-01T00:00:00.000Z'
    writeFileSync(metaPath, JSON.stringify(meta))
    const { RunStore } = await import('../src/runs.ts')
    const store = new RunStore(join(service.dataDir, 'runs'), 'http://127.0.0.1:1')
    assert.equal(store.prune(90), 1)
    assert.equal(existsSync(join(service.dataDir, 'runs', 'old-run')), false)
  } finally {
    await service.close()
  }
})

test('an evidence bundle written before the history index is upgraded in place', async () => {
  const service = await startService()
  try {
    await service.call('POST', '/runs', { body: { runId: 'evidence-upgrade', repository: 'acme/plugin', kind: 'migration' } })
    const old = { migrationId: '0.2.0', runs: [{ runId: 'evidence-upgrade', manifest: { runId: 'evidence-upgrade', migrationId: '0.2.0', startedAt: '2026-10-01T00:00:00.000Z', workflow: {}, target: {}, sessions: [] }, prompts: {} }] }
    assert.equal((await service.call('POST', '/runs/evidence-upgrade/evidence', { body: old })).status, 200)
    const next = { ...old, history: [{ runId: 'evidence-upgrade', startedAt: '2026-10-01T00:00:00.000Z' }] }
    assert.equal((await service.call('POST', '/runs/evidence-upgrade/evidence', { body: next })).status, 200)
    assert.deepEqual(await (await service.call('GET', '/view/evidence-upgrade/inspect.json')).json(), next)
  } finally {
    await service.close()
  }
})

test('a run open time must be an ISO timestamp', async () => {
  const service = await startService()
  try {
    assert.equal((await service.call('POST', '/runs', { body: { runId: 'bad-time', repository: 'acme/plugin', kind: 'migration', openedAt: 'not-a-date' } })).status, 400)
    assert.equal((await service.call('POST', '/runs', { body: { runId: 'good-time', repository: 'acme/plugin', kind: 'migration', openedAt: '2026-10-01T00:00:00.000Z' } })).status, 201)
  } finally {
    await service.close()
  }
})
