import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createFileTokenStore,
  createOAuthProvider,
  tokenStorePath,
} from '../src/host/oauth.js'

function memoryDeps() {
  const files = new Map()
  const calls = []
  const missing = (path) => {
    const error = new Error(`ENOENT: ${path}`)
    error.code = 'ENOENT'
    return error
  }
  return {
    calls,
    files,
    deps: {
      async readFile(path) {
        calls.push(['readFile', path])
        if (!files.has(path)) throw missing(path)
        return files.get(path)
      },
      async writeFile(path, data) {
        calls.push(['writeFile', path, data])
        files.set(path, data)
      },
      async rename(from, to) {
        calls.push(['rename', from, to])
        if (!files.has(from)) throw missing(from)
        files.set(to, files.get(from))
        files.delete(from)
      },
      async mkdir(path, options) {
        calls.push(['mkdir', path, options])
      },
      async chmod(path, mode) {
        calls.push(['chmod', path, mode])
      },
    },
  }
}

const HOME = '/home/test/.dsh'
const TOKENS_PATH = `${HOME}/mcp-auth/tokens.json`
const TEMP_PATH = `${TOKENS_PATH}.tmp`

test('tokenStorePath resolves the DSH home, env override, and fallback', () => {
  assert.equal(tokenStorePath({ env: { DSH_HOME: '/data/dsh' } }), '/data/dsh/mcp-auth/tokens.json')
  assert.equal(
    tokenStorePath({ home: '/custom/home', env: {} }),
    '/custom/home/mcp-auth/tokens.json',
  )
  assert.equal(tokenStorePath({ home: HOME, env: {} }), TOKENS_PATH)
})

test('roundtrips records keyed by Server name', async () => {
  const { deps, files } = memoryDeps()
  const store = createFileTokenStore({ home: HOME, deps })

  assert.equal(await store.get('remote'), undefined)
  assert.equal(await store.has('remote'), false)

  const record = {
    url: 'https://mcp.example.test/api',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: 1234567890,
    scope: 'read write',
    clientInformation: { client_id: 'client-1' },
  }
  assert.deepEqual(await store.set('remote', record), record)
  assert.equal(await store.has('remote'), true)
  assert.deepEqual(await store.get('remote'), record)
  assert.deepEqual(JSON.parse(files.get(TOKENS_PATH)), { remote: record })
})

test('strips undefined fields and rejects bad inputs', async () => {
  const { deps, files } = memoryDeps()
  const store = createFileTokenStore({ home: HOME, deps })

  await store.set('remote', { url: 'https://mcp.example.test', accessToken: 'at', extra: undefined })
  assert.deepEqual(JSON.parse(files.get(TOKENS_PATH)).remote, {
    url: 'https://mcp.example.test',
    accessToken: 'at',
  })

  await assert.rejects(() => store.get(''), /non-empty Server name/)
  await assert.rejects(() => store.set('remote', 'nope'), /plain objects/)
})

test('writes atomically through a temp file with restrictive modes', async () => {
  const { calls, files, deps } = memoryDeps()
  const store = createFileTokenStore({ home: HOME, deps })

  await store.set('remote', { url: 'https://mcp.example.test', accessToken: 'at-1' })

  const kinds = calls.map(([kind]) => kind)
  assert.deepEqual(kinds, ['readFile', 'mkdir', 'writeFile', 'chmod', 'rename', 'chmod'])
  assert.deepEqual(calls[1], ['mkdir', `${HOME}/mcp-auth`, { recursive: true, mode: 0o700 }])
  assert.equal(calls[2][0], 'writeFile')
  assert.equal(calls[2][1], TEMP_PATH)
  assert.deepEqual(JSON.parse(calls[2][2]), {
    remote: { url: 'https://mcp.example.test', accessToken: 'at-1' },
  })
  assert.deepEqual(calls[3], ['chmod', TEMP_PATH, 0o600])
  assert.deepEqual(calls[4], ['rename', TEMP_PATH, TOKENS_PATH])
  assert.deepEqual(calls[5], ['chmod', TOKENS_PATH, 0o600])
  assert.equal(files.has(TEMP_PATH), false, 'temp file is renamed away')
})

test('reads a pre-existing file and deletes entries', async () => {
  const { deps, files } = memoryDeps()
  files.set(
    TOKENS_PATH,
    JSON.stringify({ remote: { url: 'https://a.test', accessToken: 'kept' } }),
  )
  const store = createFileTokenStore({ home: HOME, deps })

  assert.deepEqual(await store.get('remote'), { url: 'https://a.test', accessToken: 'kept' })
  assert.equal(await store.delete('remote'), true)
  assert.equal(await store.has('remote'), false)
  assert.equal(await store.delete('remote'), false)
  assert.deepEqual(JSON.parse(files.get(TOKENS_PATH)), {})
})

test('treats a missing or corrupt file as empty and recovers on write', async () => {
  const { deps, files } = memoryDeps()
  const store = createFileTokenStore({ home: HOME, deps })

  assert.equal(await store.get('remote'), undefined)

  files.set(TOKENS_PATH, '{not json')
  assert.equal(await store.get('remote'), undefined)
  assert.equal(await store.has('remote'), false)

  await store.set('remote', { url: 'https://a.test', accessToken: 'at' })
  assert.deepEqual(await store.get('remote'), { url: 'https://a.test', accessToken: 'at' })
  assert.equal(JSON.parse(files.get(TOKENS_PATH)).remote.accessToken, 'at')
})

test('tolerates mkdir and chmod failures on restrictive filesystems', async () => {
  const calls = []
  const files = new Map()
  const store = createFileTokenStore({
    home: HOME,
    deps: {
      readFile: async (path) => {
        if (!files.has(path)) {
          const error = new Error('ENOENT')
          error.code = 'ENOENT'
          throw error
        }
        return files.get(path)
      },
      writeFile: async (path, data) => {
        calls.push(['writeFile', path])
        files.set(path, data)
      },
      rename: async (from, to) => {
        calls.push(['rename', to])
        files.set(to, files.get(from))
        files.delete(from)
      },
      mkdir: async () => {
        throw new Error('read-only filesystem')
      },
      chmod: async () => {
        throw new Error('chmod not supported')
      },
    },
  })

  await store.set('remote', { url: 'https://a.test', accessToken: 'at' })
  assert.deepEqual(calls.map(([kind, target]) => `${kind}:${target}`), [
    `writeFile:${TEMP_PATH}`,
    `rename:${TOKENS_PATH}`,
  ])
  assert.deepEqual(await store.get('remote'), { url: 'https://a.test', accessToken: 'at' })
})

test('serializes concurrent writes so no update is lost', async () => {
  const { deps, files } = memoryDeps()
  const store = createFileTokenStore({ home: HOME, deps })

  await Promise.all([
    store.set('a', { url: 'https://a.test', accessToken: 'at-a' }),
    store.set('b', { url: 'https://b.test', accessToken: 'at-b' }),
    store.set('c', { url: 'https://c.test', accessToken: 'at-c' }),
  ])

  const data = JSON.parse(files.get(TOKENS_PATH))
  assert.deepEqual(Object.keys(data).sort(), ['a', 'b', 'c'])
})

test('provider consumers refuse tokens bound to a different Server URL', async () => {
  const { deps, files } = memoryDeps()
  const store = createFileTokenStore({ home: HOME, deps })
  const config = { url: 'https://mcp.example.test/api', auth: 'oauth', scopes: ['read'] }

  await store.set('remote', {
    url: 'https://other.example.test/api',
    accessToken: 'stale-token',
  })
  const provider = createOAuthProvider('remote', config, { store, now: () => 1_000_000 })
  assert.equal(await provider.tokens(), undefined)
  assert.equal(await provider.clientInformation(), undefined)

  await store.set('remote', {
    url: config.url,
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: 61_000_000,
    scope: 'read',
    clientInformation: { client_id: 'client-1' },
  })
  assert.deepEqual(await provider.tokens(), {
    access_token: 'at-1',
    token_type: 'Bearer',
    refresh_token: 'rt-1',
    expires_in: 60_000,
    scope: 'read',
  })
  assert.deepEqual(await provider.clientInformation(), { client_id: 'client-1' })
})
