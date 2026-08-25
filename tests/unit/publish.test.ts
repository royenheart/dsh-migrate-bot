import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { detectBaseBranch, parseGithubRepo } from '../../src/github/publish.ts'

test('parseGithubRepo strips .git and accepts SSH or HTTPS', () => {
  assert.deepEqual(
    parseGithubRepo('git@github.com:royenheart/dsh-migrate-bot.git', {}),
    { owner: 'royenheart', repo: 'dsh-migrate-bot' },
  )
  assert.deepEqual(
    parseGithubRepo('https://github.com/royenheart/dsh-migrate-bot.git', {}),
    { owner: 'royenheart', repo: 'dsh-migrate-bot' },
  )
})

test('GITHUB_REPOSITORY wins over origin URL', () => {
  assert.deepEqual(
    parseGithubRepo('https://example.test/other/repo.git', { GITHUB_REPOSITORY: 'acme/plugin' }),
    { owner: 'acme', repo: 'plugin' },
  )
})

test('detectBaseBranch prefers GITHUB_BASE_REF then scheduled ref', () => {
  assert.equal(detectBaseBranch(process.cwd(), { GITHUB_BASE_REF: 'main' }), 'main')
  assert.equal(
    detectBaseBranch(tmpdir(), { GITHUB_EVENT_NAME: 'schedule', GITHUB_REF_NAME: 'master' }),
    'master',
  )
})
