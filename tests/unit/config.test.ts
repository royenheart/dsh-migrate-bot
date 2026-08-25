import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../../src/config/load.ts'
import { DEFAULT_CONFIG } from '../../src/config/schema.ts'

test('empty config uses defaults', () => {
  const config = parseConfig({})
  assert.equal(config.dsh.model, 'deepseek-v4-pro')
  assert.equal(config.dsh.reasoningEffort, 'max')
  assert.equal(config.dsh.mode, 'anchored-standard')
  assert.equal(config.review.policy, 'always')
  assert.equal(config.issuePr.language, 'en')
  assert.equal(config.watch.enabled, true)
  assert.equal(config.secrets.apiKeyEnv, 'DEEPSEEK_API_KEY_DSH_MIGRATE_BOT')
})

test('rejects unknown review policy', () => {
  assert.throws(() => parseConfig({ review: { policy: 'never' } }), /review.policy/)
})

test('user test commands replace the default suite', () => {
  const config = parseConfig({ tests: { commands: ['npm test', 'npm run typecheck'] } })
  assert.deepEqual(config.tests?.commands, ['npm test', 'npm run typecheck'])
})

test('rejects empty test command list', () => {
  assert.throws(() => parseConfig({ tests: { commands: [] } }), /tests.commands/)
})

test('defaults stay intact when only language is set', () => {
  const config = parseConfig({ issuePr: { language: 'zh' } })
  assert.equal(config.issuePr.language, 'zh')
  assert.equal(config.dsh.model, DEFAULT_CONFIG.dsh.model)
})

test('dsh overrides and loop bounds are accepted', () => {
  const config = parseConfig({
    dsh: { mode: 'zero-anchored-standard', reasoningEffort: 'high' },
    loop: { maxAttempts: 2 },
  })
  assert.equal(config.dsh.mode, 'zero-anchored-standard')
  assert.equal(config.dsh.reasoningEffort, 'high')
  assert.equal(config.dsh.model, DEFAULT_CONFIG.dsh.model)
  assert.equal(config.loop.maxAttempts, 2)
})

test('watch.enabled can be turned off', () => {
  const config = parseConfig({ watch: { enabled: false } })
  assert.equal(config.watch.enabled, false)
})

test('rejects non-boolean watch.enabled', () => {
  assert.throws(() => parseConfig({ watch: { enabled: 'yes' } }), /watch.enabled/)
})

test('secrets.apiKeyEnv can be overridden', () => {
  const config = parseConfig({ secrets: { apiKeyEnv: 'MY_DEEPSEEK_KEY' } })
  assert.equal(config.secrets.apiKeyEnv, 'MY_DEEPSEEK_KEY')
})

test('rejects an invalid secrets.apiKeyEnv name', () => {
  assert.throws(() => parseConfig({ secrets: { apiKeyEnv: 'not-a-name' } }), /secrets.apiKeyEnv/)
})
