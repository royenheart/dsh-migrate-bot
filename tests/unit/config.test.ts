import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../../src/config/load.ts'
import { DEFAULT_CONFIG } from '../../src/config/schema.ts'

test('empty config uses defaults', () => {
  const config = parseConfig({})
  assert.equal(config.dsh.model, 'deepseek-v4-flash')
  assert.equal(config.dsh.reasoningEffort, 'max')
  assert.equal(config.dsh.mode, 'standard')
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
    dsh: { mode: 'minimal', reasoningEffort: 'high' },
    loop: { maxAttempts: 2 },
  })
  assert.equal(config.dsh.mode, 'minimal')
  assert.equal(config.dsh.reasoningEffort, 'high')
  assert.equal(config.dsh.model, DEFAULT_CONFIG.dsh.model)
  assert.equal(config.loop.maxAttempts, 2)
})

test('rejects a dsh.mode that is not a preset id', () => {
  assert.throws(() => parseConfig({ dsh: { mode: 'Standard Mode' } }), /dsh\.mode/)
})

test('names the removed anchored presets so old configs point at standard', () => {
  assert.throws(
    () => parseConfig({ dsh: { mode: 'anchored-standard' } }),
    /no longer ships; use 'standard'/,
  )
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

test('quota.limit is accepted', () => {
  const config = parseConfig({ quota: { limit: 5.5 } })
  assert.equal(config.quota.limit, 5.5)
})

test('rejects a non-positive quota.limit', () => {
  assert.throws(() => parseConfig({ quota: { limit: 0 } }), /quota.limit/)
})

test('verification layers are on by default with a watchdog', () => {
  const config = parseConfig({})
  assert.equal(config.verify.boot.enabled, true)
  assert.equal(config.verify.boot.timeoutMs, 180_000)
  assert.equal(config.verify.web.enabled, true)
})

test('a boot probe watchdog below a second is rejected', () => {
  assert.throws(() => parseConfig({ verify: { boot: { timeoutMs: 10 } } }), /verify\.boot\.timeoutMs/)
})

test('a non-boolean verify flag is rejected', () => {
  assert.throws(() => parseConfig({ verify: { boot: { enabled: 'yes' } } }), /verify\.boot\.enabled/)
})

test('the E2E suite defaults to its own branch, rebased, advisory', () => {
  const config = parseConfig({})
  assert.equal(config.e2e.enabled, true)
  assert.equal(config.e2e.branch, 'dsh-migrate/e2e')
  assert.equal(config.e2e.forceRebase, true)
  assert.equal(config.e2e.baseRef, 'migration')
  assert.equal(config.e2e.gate, 'advisory')
  assert.equal(config.e2e.subsetFirst, true)
})

test('the gate accepts blocking and nothing else', () => {
  assert.equal(parseConfig({ e2e: { gate: 'blocking' } }).e2e.gate, 'blocking')
  assert.throws(() => parseConfig({ e2e: { gate: 'warn' } }), /e2e\.gate/)
})

test('an unusable branch name is rejected before it reaches git', () => {
  assert.throws(() => parseConfig({ e2e: { branch: 'bad branch' } }), /e2e\.branch/)
  assert.throws(() => parseConfig({ e2e: { branch: 'a..b' } }), /e2e\.branch/)
  assert.equal(parseConfig({ e2e: { branch: 'ci/e2e-suite' } }).e2e.branch, 'ci/e2e-suite')
})

test('the suite directory cannot escape the repository', () => {
  assert.throws(() => parseConfig({ e2e: { dir: '../outside' } }), /e2e\.dir/)
  assert.throws(() => parseConfig({ e2e: { dir: '/abs' } }), /e2e\.dir/)
  assert.equal(parseConfig({ e2e: { dir: 'tests/e2e/' } }).e2e.dir, 'tests/e2e')
})

test('an extend that asks for more days than the ceiling is a configuration error', () => {
  const bad = () => parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { extendDays: 100, ttlDays: 7 } } })
  assert.throws(bad, /deploy.preview.extendDays \(100\) must not exceed deploy.preview.ttlDays \(7\)/)
  // Equal is fine: one command may buy the whole remaining lifetime.
  const equal = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { extendDays: 7, ttlDays: 7 } } })
  assert.equal(equal.deploy.preview.extendDays, 7)
  const sane = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { extendDays: 3, ttlDays: 21 } } })
  assert.deepEqual(
    [sane.deploy.preview.extendDays, sane.deploy.preview.ttlDays],
    [3, 21],
  )
})
