import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDshVersion } from '../../src/watch/dsh-version.ts'

test('pins pass through as dsh-v tags', async () => {
  const resolved = await resolveDshVersion('0.1.0-rc.8')
  assert.equal(resolved.tag, 'dsh-v0.1.0-rc.8')
  assert.equal(resolved.version, '0.1.0-rc.8')
})

test('latest reads the first dsh-v release', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([
    { tag_name: 'landlock-run-v1' },
    { tag_name: 'dsh-v0.1.1-rc.2' },
  ]), { status: 200 })
  const resolved = await resolveDshVersion('latest', fetchImpl)
  assert.equal(resolved.version, '0.1.1-rc.2')
})
