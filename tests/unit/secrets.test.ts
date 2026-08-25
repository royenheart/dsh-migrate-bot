import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_API_KEY_ENV, loadSecrets } from '../../src/secrets.ts'

test('reads the default migrate-bot env name first', () => {
  const secrets = loadSecrets([], {
    env: {
      [DEFAULT_API_KEY_ENV]: 'from-default',
      DEEPSEEK_API_KEY: 'from-legacy',
    },
  })
  assert.equal(secrets.apiKey, 'from-default')
})

test('falls back to DEEPSEEK_API_KEY when the configured name is empty', () => {
  const secrets = loadSecrets([], {
    env: { DEEPSEEK_API_KEY: 'from-legacy' },
  })
  assert.equal(secrets.apiKey, 'from-legacy')
})

test('uses a custom apiKeyEnv from the environment', () => {
  const secrets = loadSecrets([], {
    apiKeyEnv: 'MY_DEEPSEEK_KEY',
    env: {
      MY_DEEPSEEK_KEY: 'from-custom',
      [DEFAULT_API_KEY_ENV]: 'from-default',
    },
  })
  assert.equal(secrets.apiKey, 'from-custom')
})

test('reads the configured key from .secrets.local.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-secrets-'))
  try {
    writeFileSync(join(dir, '.secrets.local.json'), JSON.stringify({
      MY_DEEPSEEK_KEY: 'from-file',
    }))
    const secrets = loadSecrets([dir], { apiKeyEnv: 'MY_DEEPSEEK_KEY', env: {} })
    assert.equal(secrets.apiKey, 'from-file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JSON still accepts DEEPSEEK_API_KEY as a local fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-secrets-'))
  try {
    writeFileSync(join(dir, '.secrets.local.json'), JSON.stringify({
      DEEPSEEK_API_KEY: 'from-legacy-file',
    }))
    const secrets = loadSecrets([dir], { env: {} })
    assert.equal(secrets.apiKey, 'from-legacy-file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
