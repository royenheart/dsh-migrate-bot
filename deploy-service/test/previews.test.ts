import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewId } from '../src/previews.ts'
import { allowedCloneUrl } from '../src/webhook.ts'
import { TOKEN, pluginRepository, pullRequestEvent, startService, type TestService } from './support.ts'

const PATH = '/previews/acme%2Fplugin/7'
const KEY = { repository: 'acme/plugin', pullRequest: 7 }
const ID = previewId(KEY)
const PASS = { ok: true, detail: 'The boot check passed (fake).' }
const FAIL = { ok: false, detail: 'The boot check did not pass (fail): load: broken' }

async function state(service: TestService): Promise<Record<string, unknown>> {
  return await (await service.call('GET', PATH)).json() as Record<string, unknown>
}

async function deliver(service: TestService, input: Parameters<typeof pullRequestEvent>[0], secret?: string): Promise<Response> {
  const event = pullRequestEvent(input, secret)
  const answer = await service.call('POST', '/github/webhook', { token: null, body: event.body, headers: event.headers })
  await service.previews.settled()
  return answer
}

function work(service: TestService): string {
  return join(service.dataDir, 'previews', ID, 'work')
}

/** Send a WebSocket upgrade over a raw connection, and resolve once the answer's status line arrives. */
function upgrade(service: TestService, path: string): Promise<{ status: string; socket: ReturnType<typeof connect> }> {
  const url = new URL(service.url)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
    })
    socket.once('data', (chunk) => { resolve({ status: chunk.toString().split('\r\n')[0] ?? '', socket }) })
    socket.on('error', reject)
  })
}

test('a webhook needs a valid signature; an opened pull request builds a preview whose git directory is outside the working copy', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    assert.equal((await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin }, 'wrong-secret-0123456789')).status, 401)
    assert.deepEqual(await state(service), { state: 'none' })

    assert.equal((await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })).status, 202)
    const ready = await state(service)
    assert.deepEqual(Object.keys(ready).sort(), ['expiresAt', 'headSha', 'safeUrl', 'state', 'url'])
    assert.deepEqual([ready.state, ready.headSha, ready.url, ready.safeUrl], ['ready', repo.head, `http://127.0.0.1:1/p/${ID}/`, `http://127.0.0.1:1/p/${ID}/safe/`])
    assert.ok(existsSync(join(work(service), 'index.js')))
    assert.ok(!existsSync(join(work(service), '.git')), 'nothing of git is inside the mounted working copy')
    assert.ok(existsSync(join(service.dataDir, 'previews', ID, 'git', 'HEAD')))

    const ignored = pullRequestEvent({ action: 'labeled', number: 7, sha: repo.head, cloneUrl: repo.origin })
    assert.equal((await service.call('POST', '/github/webhook', { token: null, body: ignored.body, headers: { ...ignored.headers, 'X-GitHub-Delivery': 'other' } })).status, 202)
    assert.equal(service.provider.builds.length, 1)
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('a pull request from a fork gets no preview, and status says why', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    assert.equal((await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin, headRepository: 'stranger/plugin' })).status, 202)
    const none = await state(service)
    assert.equal(none.state, 'none')
    assert.match(String(none.detail), /stranger\/plugin, not in acme\/plugin/)
    await deliver(service, { action: 'synchronize', number: 8, sha: repo.head, cloneUrl: repo.origin, headRepository: null })
    assert.equal(service.provider.builds.length, 0)
    assert.equal(service.previews.all().length, 0)
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('local and http clone URLs are accepted only by the process provider', () => {
  assert.equal(allowedCloneUrl('https://github.com/acme/plugin.git', 'docker'), true)
  assert.equal(allowedCloneUrl('http://github.com/acme/plugin.git', 'docker'), false)
  assert.equal(allowedCloneUrl('/srv/plugin.git', 'docker'), false)
  assert.equal(allowedCloneUrl('ext::sh -c id', 'docker'), false)
  assert.equal(allowedCloneUrl('http://localhost/plugin.git', 'process'), true)
  assert.equal(allowedCloneUrl('/srv/plugin.git', 'process'), true)
  assert.equal(allowedCloneUrl('file:///srv/plugin.git', 'process'), false)
})

test('the proxy serves both entries over the instance sockets and forwards no credential', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    const plugin = await service.call('GET', `/p/${ID}/assets/app.js?x=1`, {
      headers: { Cookie: 'CF_Authorization=jwt', 'Cf-Access-Jwt-Assertion': 'jwt', 'Cf-Access-Authenticated-User-Email': 'person@example.com', 'X-Custom': 'kept' },
    })
    assert.equal(plugin.status, 200)
    assert.equal(await plugin.text(), 'plugin /assets/app.js?x=1')
    const seen = service.provider.seen.find(request => request.url === '/assets/app.js?x=1')
    assert.ok(seen !== undefined)
    assert.equal(seen.headers.authorization, undefined)
    assert.equal(seen.headers.cookie, 'dsh-auth-plugin=session')
    assert.equal(seen.headers['cf-access-jwt-assertion'], undefined)
    assert.equal(seen.headers['cf-access-authenticated-user-email'], undefined)
    assert.equal(seen.headers['x-custom'], 'kept')
    assert.equal(await (await service.call('GET', `/p/${ID}/safe/`)).text(), 'safe /')
    const bare = await service.call('GET', `/p/${ID}`)
    assert.deepEqual([bare.status, bare.headers.get('location')], [308, `/p/${ID}/`])
    assert.equal((await service.call('GET', `/p/${ID}/`, { token: null })).status, 401)
    assert.equal((await service.call('GET', '/p/0123456789abcdef/')).status, 404)

    // An idle stop, then a visit: the instance cold-starts.
    await service.previews.sweep(Date.now() + 31 * 60_000)
    assert.equal((await state(service)).state, 'stopped')
    assert.equal(await (await service.call('GET', `/p/${ID}/`)).text(), 'plugin /')
    assert.equal((await state(service)).state, 'ready')
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('an open WebSocket keeps the instance from idling out', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    const { status, socket } = await upgrade(service, `/p/${ID}/api/remote.mux`)
    assert.match(status, / 101 /)
    await service.previews.sweep(Date.now() + 31 * 60_000)
    assert.equal((await state(service)).state, 'ready')
    socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 100))
    await service.previews.sweep(Date.now() + 31 * 60_000)
    assert.equal((await state(service)).state, 'stopped')
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('a client that resets an upgrade does not take the service down', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    await service.previews.sweep(Date.now() + 31 * 60_000)
    service.provider.startDelayMs = 200
    const url = new URL(service.url)
    for (const authorization of [`Authorization: Bearer ${TOKEN}\r\n`, '']) {
      await new Promise<void>((resolve) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
          socket.write(`GET /p/${ID}/api/remote.mux HTTP/1.1\r\nHost: ${url.host}\r\n${authorization}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`, () => {
            socket.resetAndDestroy()
            resolve()
          })
        })
      })
    }
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal((await service.call('GET', '/healthz')).status, 200)
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('extend moves the expiry, never past the ceiling', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    const day = 24 * 60 * 60 * 1000
    const createdAt = Date.parse(String(service.previews.find(KEY)?.createdAt))
    const first = await service.call('POST', PATH, { body: { action: 'extend', days: 3, maxTtlDays: 8 } })
    assert.equal(first.status, 200)
    const extended = await first.json() as { expiresAt: string }
    assert.equal(Date.parse(extended.expiresAt) - createdAt, 8 * day)
    assert.equal((await state(service)).expiresAt, extended.expiresAt)
    assert.equal((await service.call('POST', PATH, { body: { action: 'extend', days: 3, maxTtlDays: 8 } })).status, 409)
    assert.equal((await service.call('POST', PATH, { body: { action: 'extend', days: 0, maxTtlDays: 8 } })).status, 400)
    assert.equal((await service.call('POST', '/previews/acme%2Fplugin/99', { body: { action: 'extend', days: 1, maxTtlDays: 8 } })).status, 404)
    // Expiry destroys.
    await service.previews.sweep(Date.now() + 9 * day)
    assert.deepEqual(await state(service), { state: 'none' })
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('publish freezes the working copy, serves it, and never serves an unknown revision', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    assert.equal((await service.call('POST', PATH, { body: { action: 'publish' } })).status, 409)

    writeFileSync(join(work(service), 'index.js'), 'export const apply = () => { return 1 }\n')
    writeFileSync(join(work(service), 'added.js'), 'export const added = true\n')
    rmSync(join(work(service), 'package.json'))
    const published = await service.call('POST', PATH, { body: { action: 'publish' }, headers: { 'Idempotency-Key': 'publish-1' } })
    assert.equal(published.status, 200)
    const frozen = await published.json() as { revision: string; headSha: string }
    assert.deepEqual(frozen, { revision: frozen.revision, headSha: repo.head })
    assert.match(frozen.revision, /^r1-[0-9a-f]{12}$/)

    // Editing on: the frozen revision does not change, and a replay names it again.
    writeFileSync(join(work(service), 'later.js'), 'export const later = true\n')
    const replay = await service.call('POST', PATH, { body: { action: 'publish' }, headers: { 'Idempotency-Key': 'publish-1' } })
    assert.equal(replay.headers.get('idempotency-replayed'), 'true')
    assert.equal((await replay.json() as { revision: string }).revision, frozen.revision)

    const scratch = await service.call('GET', `${PATH}/scratch?revision=${encodeURIComponent(frozen.revision)}`)
    assert.equal(scratch.status, 200)
    assert.match(scratch.headers.get('content-type') ?? '', /^text\/x-diff/)
    const diff = await scratch.text()
    assert.match(diff, /\+export const apply = \(\) => \{ return 1 \}/)
    assert.match(diff, /new file mode 100644\n[^\n]*\n--- \/dev\/null\n\+\+\+ b\/added\.js/)
    assert.match(diff, /deleted file mode 100644\n[^\n]*\n--- a\/package\.json/)
    assert.doesNotMatch(diff, /later\.js/)

    assert.equal((await service.call('GET', `${PATH}/scratch?revision=r9-unknown`)).status, 404)
    assert.equal((await service.call('GET', `${PATH}/scratch`)).status, 400)

    const second = await (await service.call('POST', PATH, { body: { action: 'publish' }, headers: { 'Idempotency-Key': 'publish-2' } })).json() as { revision: string }
    assert.match(second.revision, /^r2-/)
    const same = await (await service.call('POST', PATH, { body: { action: 'publish' }, headers: { 'Idempotency-Key': 'publish-3' } })).json() as { revision: string }
    assert.equal(same.revision, second.revision, 'the same change against the same base and head is the same revision')

    const result = { revision: second.revision, outcome: 'refused', branch: 'feature', stage: 'checks', detail: 'mechanical failed', tag: 'dsh-v0.2.0', checks: [{ check: 'mechanical', outcome: 'fail' }] }
    assert.equal((await service.call('POST', `${PATH}/publish-result`, { body: result })).status, 200)
    const stored = service.previews.find(KEY)?.revisions.at(-1)?.result
    assert.deepEqual([stored?.outcome, stored?.stage, stored?.tag, stored?.checks], ['refused', 'checks', 'dsh-v0.2.0', [{ check: 'mechanical', outcome: 'fail' }]])
    assert.equal((await service.call('POST', `${PATH}/publish-result`, { body: { ...result, revision: 'r9-unknown' } })).status, 404)
    assert.equal((await service.call('POST', `${PATH}/publish-result`, { body: { ...result, checks: 'no' } })).status, 400)
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('after the head moves, publishing the same change freezes a new revision for the new head', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    writeFileSync(join(work(service), 'mine.js'), 'export const mine = true\n')
    const first = await (await service.call('POST', PATH, { body: { action: 'publish' } })).json() as { revision: string; headSha: string }
    const moved = repo.commit('next.js', 'export const next = true\n')
    service.provider.results = [FAIL]
    await deliver(service, { action: 'synchronize', number: 7, sha: moved, cloneUrl: repo.origin })
    const again = await (await service.call('POST', PATH, { body: { action: 'publish' } })).json() as { revision: string; headSha: string }
    assert.notEqual(again.revision, first.revision)
    assert.deepEqual([first.headSha, again.headSha], [repo.head, moved])
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('promotion checks the head with the working copy\'s change carried onto it, and keeps the old build when that fails', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    writeFileSync(join(work(service), 'mine.js'), 'export const mine = true\n')

    const moved = repo.commit('next.js', 'export const next = true\n')
    service.provider.results = [PASS, FAIL]
    await deliver(service, { action: 'synchronize', number: 7, sha: moved, cloneUrl: repo.origin })
    const failed = await state(service)
    assert.deepEqual([failed.state, failed.headSha], ['failed', repo.head])
    assert.match(String(failed.detail), /not with the working copy's change carried onto it.*load: broken/)
    assert.deepEqual(service.provider.builds.at(-1), ['index.js', 'mine.js', 'next.js', 'package.json'], 'the second check saw the carried change')
    assert.ok(existsSync(join(work(service), 'mine.js')), 'the working copy is untouched')
    assert.ok(!existsSync(join(work(service), 'next.js')))
    assert.equal(await (await service.call('GET', `/p/${ID}/`)).text(), 'plugin /', 'the previous build serves again')

    service.provider.results = [PASS]
    assert.equal((await service.call('POST', PATH, { body: { action: 'redeploy' } })).status, 202)
    await service.previews.settled()
    const promoted = await state(service)
    assert.deepEqual([promoted.state, promoted.headSha], ['ready', moved])
    assert.equal(readFileSync(join(work(service), 'mine.js'), 'utf8'), 'export const mine = true\n')
    assert.ok(existsSync(join(work(service), 'next.js')))
    assert.deepEqual(readdirSync(join(service.dataDir, 'previews', ID)).filter(name => name.includes('.next-') || name.endsWith('.old')), [])
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('a change that does not apply to the new head is kept aside, and the clean head is promoted', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    writeFileSync(join(work(service), 'index.js'), 'export const apply = () => { return "mine" }\n')
    const moved = repo.commit('index.js', 'export const apply = () => { return "theirs" }\n')
    await deliver(service, { action: 'synchronize', number: 7, sha: moved, cloneUrl: repo.origin })
    const promoted = await state(service)
    assert.deepEqual([promoted.state, promoted.headSha], ['ready', moved])
    assert.equal(readFileSync(join(work(service), 'index.js'), 'utf8'), 'export const apply = () => { return "theirs" }\n')
    const unapplied = readdirSync(join(service.dataDir, 'previews', ID, 'unapplied'))
    assert.equal(unapplied.length, 1)
    assert.match(readFileSync(join(service.dataDir, 'previews', ID, 'unapplied', unapplied[0] ?? ''), 'utf8'), /return "mine"/)
    assert.match(String(promoted.detail), /kept as unapplied\//, 'the state says the change was set aside')
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('what a build creates is not part of the change, so a rebuild carries the edits', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    let builds = 0
    service.provider.output = (dir) => {
      builds += 1
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'index.js'), `// build ${String(builds)}\n`)
    }
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    writeFileSync(join(work(service), 'index.js'), 'export const apply = () => { return "mine" }\n')
    const frozen = await (await service.call('POST', PATH, { body: { action: 'publish' } })).json() as { revision: string }
    const diff = await (await service.call('GET', `${PATH}/scratch?revision=${encodeURIComponent(frozen.revision)}`)).text()
    assert.match(diff, /return "mine"/)
    assert.doesNotMatch(diff, /dist\//)

    const moved = repo.commit('next.js', 'export const next = true\n')
    await deliver(service, { action: 'synchronize', number: 7, sha: moved, cloneUrl: repo.origin })
    const promoted = await state(service)
    assert.deepEqual([promoted.state, promoted.headSha, promoted.detail], ['ready', moved, undefined])
    assert.equal(readFileSync(join(work(service), 'index.js'), 'utf8'), 'export const apply = () => { return "mine" }\n')
    assert.ok(!existsSync(join(service.dataDir, 'previews', ID, 'unapplied')))
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('a file that is not UTF-8 is frozen, served and carried byte for byte', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    const latin1 = Buffer.from('caf\xe9 cr\xe8me\n', 'latin1')
    writeFileSync(join(work(service), 'notes.txt'), latin1)
    const frozen = await (await service.call('POST', PATH, { body: { action: 'publish' } })).json() as { revision: string }
    const served = Buffer.from(await (await service.call('GET', `${PATH}/scratch?revision=${encodeURIComponent(frozen.revision)}`)).arrayBuffer())
    assert.ok(served.includes(Buffer.from('+caf\xe9 cr\xe8me', 'latin1')))

    const moved = repo.commit('next.js', 'export const next = true\n')
    await deliver(service, { action: 'synchronize', number: 7, sha: moved, cloneUrl: repo.origin })
    assert.equal((await state(service)).headSha, moved)
    assert.deepEqual(readFileSync(join(work(service), 'notes.txt')), latin1)
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('a closed pull request stays without a preview until it is reopened', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    assert.equal((await deliver(service, { action: 'closed', number: 7, sha: repo.head, cloneUrl: repo.origin })).status, 200)
    const moved = repo.commit('late.js', 'export const late = true\n')
    assert.equal((await deliver(service, { action: 'synchronize', number: 7, sha: moved, cloneUrl: repo.origin })).status, 202)
    assert.deepEqual(await state(service), { state: 'none', detail: 'The pull request is closed.' })
    assert.equal(service.provider.builds.length, 1)
    await deliver(service, { action: 'reopened', number: 7, sha: moved, cloneUrl: repo.origin })
    assert.deepEqual([(await state(service)).state, (await state(service)).headSha], ['ready', moved])
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('a head without a plugin is a failed build, not a promoted one', async () => {
  const repo = pluginRepository()
  const service = await startService()
  try {
    const sha = repo.commit('package.json', '{}\n')
    await deliver(service, { action: 'opened', number: 7, sha, cloneUrl: repo.origin })
    const failed = await state(service)
    assert.equal(failed.state, 'failed')
    assert.equal(failed.url, undefined)
    assert.match(String(failed.detail), /no package\.json with a name/)
    assert.equal(service.provider.builds.length, 0)
  } finally {
    await service.close()
    repo.cleanup()
  }
})

test('destroy and a closed pull request remove the preview; records survive a restart, and leftover candidates do not', async () => {
  const repo = pluginRepository()
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-deploy-test-'))
  const service = await startService({ dataDir })
  let restarted: TestService | undefined
  try {
    await deliver(service, { action: 'opened', number: 7, sha: repo.head, cloneUrl: repo.origin })
    await deliver(service, { action: 'opened', number: 8, sha: repo.head, cloneUrl: repo.origin })
    await service.close()
    mkdirSync(join(dataDir, 'previews', ID, 'work.next-9'))
    mkdirSync(join(dataDir, 'previews', ID, 'git.next-9'))

    restarted = await startService({ dataDir })
    assert.equal((await state(restarted)).state, 'stopped')
    assert.ok(!existsSync(join(dataDir, 'previews', ID, 'work.next-9')))
    assert.ok(!existsSync(join(dataDir, 'previews', ID, 'git.next-9')))
    assert.equal((await restarted.call('DELETE', PATH)).status, 200)
    assert.deepEqual(await state(restarted), { state: 'none' })
    assert.ok(!existsSync(join(dataDir, 'previews', ID)))
    assert.equal((await restarted.call('DELETE', PATH)).status, 404)

    assert.equal((await deliver(restarted, { action: 'closed', number: 8, sha: repo.head, cloneUrl: repo.origin })).status, 200)
    assert.equal((await (await restarted.call('GET', '/previews/acme%2Fplugin/8')).json() as { state: string }).state, 'none')
  } finally {
    await restarted?.close()
    repo.cleanup()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a seeded preview exists only in conformance mode', async () => {
  const plain = await startService()
  try {
    assert.equal((await plain.call('POST', PATH, { body: {}, headers: { 'X-Conformance': 'seed' } })).status, 400)
  } finally {
    await plain.close()
  }
  const conformance = await startService({ conformance: true })
  try {
    assert.equal((await conformance.call('POST', PATH, { body: {}, headers: { 'X-Conformance': 'seed' } })).status, 201)
    const frozen = await (await conformance.call('POST', PATH, { body: { action: 'publish' } })).json() as { revision: string }
    const diff = await (await conformance.call('GET', `${PATH}/scratch?revision=${frozen.revision}`)).text()
    assert.match(diff, /\+\+\+ b\/CONFORMANCE\.md/)
  } finally {
    await conformance.close()
  }
})
