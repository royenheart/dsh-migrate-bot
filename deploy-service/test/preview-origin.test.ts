import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { previewId } from '../src/previews.ts'
import { startService } from './support.ts'

function get(url: string, host: string, path: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { headers: { Host: host, Authorization: 'Bearer test-token-0123456789' } }, (res) => {
      let body = ''
      res.on('data', chunk => { body += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ...(res.headers.location === undefined ? {} : { location: res.headers.location }), body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('a preview answers on its own host and the old path redirects there', async () => {
  const service = await startService({ previewDomain: 'preview.test' })
  const key = { repository: 'acme/plugin', pullRequest: 1 }
  const id = previewId(key)
  try {
    await service.previews.seed(key)
    const plugin = await get(service.url, `p-${id}.preview.test`, '/')
    assert.equal(plugin.status, 200)
    assert.match(plugin.body, /^plugin \//)
    const safeRedirect = await get(service.url, `p-${id}.preview.test`, '/safe')
    assert.equal(safeRedirect.status, 308)
    assert.equal(safeRedirect.location, `http://p-${id}.preview.test:1/safe/`)
    const safe = await get(service.url, `p-${id}.preview.test`, '/safe/?x=1')
    assert.equal(safe.status, 200)
    assert.match(safe.body, /^safe \/\?x=1/)
    const health = await get(service.url, `p-${id}.preview.test`, '/healthz')
    assert.notEqual(health.body, '{"ok":true}')
    const unknown = await get(service.url, 'other.preview.test', '/view/anything')
    assert.equal(unknown.status, 404)
    const old = await get(service.url, 'deploy.test', `/p/${id}/?x=1`)
    assert.equal(old.status, 308)
    assert.equal(old.location, `http://p-${id}.preview.test:1/?x=1`)
  } finally {
    await service.close()
  }
})

test('the control host survives a preview suffix that is its parent', async () => {
  const service = await startService({ previewDomain: 'example.com', publicUrl: 'http://deploy.example.com' })
  try {
    const response = await get(service.url, 'deploy.example.com', '/view/missing')
    assert.match(response.body, /no such run/)
  } finally {
    await service.close()
  }
})

test('the bare path preview redirect keeps its query string when no preview domain is configured', async () => {
  const service = await startService()
  const key = { repository: 'acme/plugin', pullRequest: 2 }
  const id = previewId(key)
  try {
    await service.previews.seed(key)
    const response = await get(service.url, 'deploy.test', `/p/${id}?x=1`)
    assert.equal(response.status, 308)
    assert.equal(response.location, `/p/${id}/?x=1`)
  } finally {
    await service.close()
  }
})
