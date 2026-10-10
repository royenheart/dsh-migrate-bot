import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadConfigFile, parseConfig } from '../../src/config/load.ts'
import { appRootFrom } from '../../src/paths.ts'

test('an empty file yields the defaults', () => {
  for (const raw of [undefined, null, {}]) {
    const config = parseConfig(raw)
    assert.equal(config.target, 'latest')
    assert.equal(config.agent.model, 'deepseek-v4-flash')
    assert.equal(config.agent.reasoningEffort, 'max')
    assert.equal(config.review.policy, 'always')
    assert.equal(config.repair.maxAttempts, 5)
    assert.equal(config.secrets.apiKeyEnv, 'DEEPSEEK_API_KEY_DSH_MIGRATE_BOT')
    assert.equal(config.checks.boot.timeoutMs, 180_000)
    assert.equal(config.checks.e2e.failurePolicy, 'advisory')
    assert.equal(config.deploy.enabled, false)
    assert.equal(config.deploy.preview.extendDays, 7)
    assert.deepEqual(config.reports.channels, {})
  }
})

test('an unknown key is rejected rather than ignored', () => {
  assert.throws(() => parseConfig({ reveiw: { policy: 'always' } }), /reveiw/)
  assert.throws(() => parseConfig({ agent: { modle: 'x' } }), /modle/)
})

test('a key renamed in 1.0 names its replacement', () => {
  assert.throws(() => parseConfig({ dshVersion: 'latest' }), /dshVersion was renamed to `target`/)
  assert.throws(() => parseConfig({ loop: { maxAttempts: 2 } }), /repair\.maxAttempts/)
  assert.throws(() => parseConfig({ issuePr: { language: 'en' } }), /issuePr was removed/)
  assert.throws(() => parseConfig({ prompts: { fix: 'x' } }), /prompts\.fix was renamed to `prompts\.repair`/)
  assert.throws(() => parseConfig({ review: { policy: 'skip-if-mechanical-pass' } }), /when-checks-fail/)
})

test('values are validated with the key path in the message', () => {
  assert.throws(() => parseConfig({ review: { policy: 'never' } }), /review\.policy/)
  assert.throws(() => parseConfig({ tests: { commands: [] } }), /tests\.commands/)
  assert.throws(() => parseConfig({ secrets: { apiKeyEnv: 'not-a-name' } }), /secrets\.apiKeyEnv/)
  assert.throws(() => parseConfig({ quota: { limit: 0 } }), /quota\.limit/)
  assert.throws(() => parseConfig({ checks: { boot: { timeoutMs: 10 } } }), /checks\.boot\.timeoutMs/)
  assert.throws(() => parseConfig({ checks: { e2e: { failurePolicy: 'warn' } } }), /checks\.e2e\.failurePolicy/)
})

test('an unusable suite branch or directory is rejected before it reaches git', () => {
  assert.throws(() => parseConfig({ checks: { e2e: { branch: 'bad branch' } } }), /checks\.e2e\.branch/)
  assert.throws(() => parseConfig({ checks: { e2e: { branch: 'a..b' } } }), /checks\.e2e\.branch/)
  assert.throws(() => parseConfig({ checks: { e2e: { dir: '../outside' } } }), /checks\.e2e\.dir/)
  assert.equal(parseConfig({ checks: { e2e: { dir: './tests/e2e/' } } }).checks.e2e.dir, 'tests/e2e')
})

test('a partial section keeps the defaults of its other keys', () => {
  const config = parseConfig({ agent: { reasoningEffort: 'high' }, checks: { web: { enabled: false } } })
  assert.equal(config.agent.reasoningEffort, 'high')
  assert.equal(config.agent.model, 'deepseek-v4-flash')
  assert.equal(config.checks.web.enabled, false)
  assert.equal(config.checks.boot.enabled, true)
})

test('the deploy service needs an endpoint once enabled', () => {
  assert.throws(() => parseConfig({ deploy: { enabled: true } }), /deploy\.endpoint/)
  assert.throws(() => parseConfig({ deploy: { endpoint: 'ftp://x' } }), /deploy\.endpoint/)
  assert.equal(parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test/' } }).deploy.endpoint, 'https://deploy.test')
})

test('an extend may ask for at most the preview lifetime, which is also its default', () => {
  const endpoint = 'https://deploy.test'
  assert.throws(
    () => parseConfig({ deploy: { enabled: true, endpoint, preview: { extendDays: 100, ttlDays: 7 } } }),
    /deploy\.preview\.extendDays/,
  )
  assert.equal(parseConfig({ deploy: { preview: { ttlDays: 3 } } }).deploy.preview.extendDays, 3)
  assert.equal(parseConfig({ deploy: { preview: { ttlDays: 21, extendDays: 3 } } }).deploy.preview.extendDays, 3)
})

test('a built-in report channel needs only enabled; another channel must say where, how and what', () => {
  const builtin = parseConfig({ reports: { channels: { 'migrate-bot': { enabled: true } } } })
  assert.equal(builtin.reports.channels['migrate-bot']?.enabled, true)
  assert.throws(
    () => parseConfig({ reports: { channels: { mine: { enabled: true, repo: 'me/notes' } } } }),
    /reports\.channels\.mine\.method is required/,
  )
  const own = parseConfig({ reports: { channels: { mine: { enabled: true, repo: 'me/notes', method: 'issue', prompt: 'Summarize.' } } } })
  assert.equal(own.reports.channels.mine?.method, 'issue')
  assert.throws(() => parseConfig({ reports: { channels: { mine: { method: 'pull' } } } }), /method/)
})

test('the shipped example configuration validates', () => {
  const config = loadConfigFile(join(appRootFrom(import.meta.url), 'examples', 'dsh-migrate.yml'))
  assert.equal(config.target, 'latest')
})
