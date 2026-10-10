import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'
import { hasBearer, sameSecret, validSignature } from '../src/http.ts'
import { startService } from './support.ts'
import type { IncomingMessage } from 'node:http'

test('the configuration fails fast and names every problem', () => {
  const missing = loadConfig({}, [])
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    for (const name of ['DEPLOY_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'DATA_DIR', 'PUBLIC_URL', 'PROVIDER']) {
      assert.ok(missing.problems.some(problem => problem.startsWith(name)), `${name} is reported`)
    }
  }
  const base = { DEPLOY_TOKEN: 'x'.repeat(16), GITHUB_WEBHOOK_SECRET: 'y'.repeat(16), DATA_DIR: '/tmp/data', PUBLIC_URL: 'https://deploy.example/' }
  const docker = loadConfig({ ...base, PROVIDER: 'docker' }, [])
  assert.ok(!docker.ok && docker.problems.some(problem => problem.startsWith('DSH_IMAGE')))
  const processProvider = loadConfig({ ...base, PROVIDER: 'process' }, [])
  assert.ok(!processProvider.ok && processProvider.problems.some(problem => problem.startsWith('DSH_VERSION')))
  const flag = loadConfig({ ...base, PROVIDER: 'process', DSH_VERSION: '0.2.0' }, ['--verbose'])
  assert.ok(!flag.ok && flag.problems.some(problem => problem.includes('--verbose')))
  const ok = loadConfig({ ...base, PROVIDER: 'process', DSH_VERSION: '0.2.0', IDLE_MINUTES: '5' }, ['--conformance'])
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.equal(ok.config.PUBLIC_URL, 'https://deploy.example')
    assert.equal(ok.config.IDLE_MINUTES, 5)
    assert.equal(ok.config.TTL_DAYS, 3)
    assert.equal(ok.config.conformance, true)
  }
})

test('secrets compare in constant time and only when equal', () => {
  assert.equal(sameSecret('abc', 'abc'), true)
  assert.equal(sameSecret('abc', 'abcd'), false)
  assert.equal(sameSecret('', 'abc'), false)
  const request = (authorization?: string): IncomingMessage => ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage
  assert.equal(hasBearer(request('Bearer secret-token'), 'secret-token'), true)
  assert.equal(hasBearer(request('bearer secret-token'), 'secret-token'), true)
  assert.equal(hasBearer(request('Basic secret-token'), 'secret-token'), false)
  assert.equal(hasBearer(request(), 'secret-token'), false)
})

test('a webhook signature is HMAC-SHA256 of the raw body', () => {
  const body = Buffer.from('{"a":1}')
  // printf '{"a":1}' | openssl dgst -sha256 -hmac key
  const signature = 'sha256=88a67f24bbcdaed0e6c997404bb79a743baf44c6bab2f4c27328e3009d22e342'
  assert.equal(validSignature(body, signature, 'key'), true)
  assert.equal(validSignature(body, signature, 'other key'), false)
  assert.equal(validSignature(Buffer.from('{"a":2}'), signature, 'key'), false)
  assert.equal(validSignature(body, undefined, 'key'), false)
  assert.equal(validSignature(body, 'sha1=abc', 'key'), false)
})

test('every API path needs the bearer token; health does not', async () => {
  const service = await startService()
  try {
    assert.equal((await service.call('GET', '/healthz', { token: null })).status, 200)
    for (const [method, path] of [['POST', '/runs'], ['GET', '/previews/acme%2Fplugin/1'], ['DELETE', '/previews/acme%2Fplugin/1'], ['GET', '/previews/acme%2Fplugin/1/scratch?revision=r1']] as const) {
      const none = await service.call(method, path, { token: null })
      assert.equal(none.status, 401, `${method} ${path} without a token`)
      assert.equal(none.headers.get('www-authenticate'), 'Bearer')
      assert.equal((await service.call(method, path, { token: 'wrong-token-0123456789' })).status, 401, `${method} ${path} with a wrong token`)
    }
    assert.equal((await service.call('GET', '/previews/acme%2Fplugin/1')).status, 200)
    assert.equal((await service.call('GET', '/nowhere')).status, 404)
    assert.equal((await service.call('GET', '/previews/not-a-repo/1')).status, 404)
    assert.equal((await service.call('POST', '/runs', { body: '{not json' })).status, 400)
  } finally {
    await service.close()
  }
})

test('the conformance header is ignored unless the service was started with --conformance', async () => {
  const plain = await startService()
  try {
    const answer = await plain.call('GET', '/previews/acme%2Fplugin/1', { headers: { 'X-Conformance': 'redirect' } })
    assert.equal(answer.status, 200)
    assert.deepEqual(await answer.json(), { state: 'none' })
  } finally {
    await plain.close()
  }
  const conformance = await startService({ conformance: true })
  try {
    const redirect = await conformance.call('GET', '/previews/acme%2Fplugin/1', { headers: { 'X-Conformance': 'redirect' } })
    assert.equal(redirect.status, 302)
    const oversize = await conformance.call('GET', '/previews/acme%2Fplugin/1', { headers: { 'X-Conformance': 'oversize' } })
    assert.ok((await oversize.arrayBuffer()).byteLength > 2 * 1024 * 1024)
    // The token is checked before any misbehaviour.
    assert.equal((await conformance.call('GET', '/previews/acme%2Fplugin/1', { token: null, headers: { 'X-Conformance': 'redirect' } })).status, 401)
  } finally {
    await conformance.close()
  }
})
