import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareReleases, declaredRelease, newest, parseRelease } from '../../src/domain/release.ts'
import { resolveTarget } from '../../src/github/releases.ts'
import { classifyBaseline, describeBaseline } from '../../src/domain/outcome.ts'
import { contextOf, input } from '../support/migration.ts'

test('a tag and a version name the same release; anything else names none', () => {
  assert.deepEqual(parseRelease('dsh-v0.2.0-rc.2'), { tag: 'dsh-v0.2.0-rc.2', version: '0.2.0-rc.2' })
  assert.deepEqual(parseRelease('0.2.0-rc.2'), { tag: 'dsh-v0.2.0-rc.2', version: '0.2.0-rc.2' })
  assert.equal(parseRelease('latest'), undefined)
  assert.equal(parseRelease('dsh-v0.2'), undefined)
})

test('releases order by semver, prereleases below their release', () => {
  const order = ['0.1.7-alpha.1', '0.2.0-rc.2', '0.1.7-rc.2', '0.2.1-alpha.2', '0.2.0'].map(version => parseRelease(version)!)
  assert.deepEqual(order.sort(compareReleases).map(release => release.version), ['0.1.7-alpha.1', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.0', '0.2.1-alpha.2'])
  assert.equal(newest(order)?.version, '0.2.1-alpha.2')
})

test('the declared release is the lowest any dsh dependency range admits', () => {
  assert.equal(declaredRelease({ peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.1-rc.2', react: '^18' }, devDependencies: { '@deepseek-ai/dsh-agent': '>=0.1.0 <0.2' } })?.version, '0.1.0')
  assert.equal(declaredRelease({ dependencies: { '@deepseek-ai/dsh-tools': 'workspace:*' } }), undefined)
  assert.equal(declaredRelease(undefined), undefined)
})

test('latest is the newest dsh-v tag; a named release is used as given', async () => {
  const tags = async (): Promise<string[]> => ['dsh-v0.2.0-rc.2', 'dsh-v0.2.1-alpha.2', 'dsh-v0.1.7-rc.2', 'v1.0.0']
  assert.equal((await resolveTarget('latest', tags)).tag, 'dsh-v0.2.1-alpha.2')
  assert.equal((await resolveTarget('0.1.7-rc.2', tags)).tag, 'dsh-v0.1.7-rc.2')
  await assert.rejects(resolveTarget('next', tags), /is not `latest`/)
  await assert.rejects(resolveTarget('latest', async () => []), /no dsh-v\* tag/)
})

test('the pre-migration boot checks classify the failure', () => {
  const source = { release: { tag: 'dsh-v0.1.7', version: '0.1.7' }, origin: 'verified' as const }
  const boot = (outcome: 'pass' | 'fail') => ({ type: 'check.done' as const, result: { check: 'boot' as const, outcome, fingerprint: outcome === 'fail' ? 'x' : '', detail: '' } })
  const withBoot = input('0.2.0', { source, settings: { ...input().settings, checks: { cards: false, boot: true, web: false, e2e: false } } })
  assert.equal(classifyBaseline(contextOf(withBoot, [boot('pass'), boot('fail')])), 'regression')
  assert.equal(classifyBaseline(contextOf(withBoot, [boot('fail'), boot('fail')])), 'pre-existing')
  assert.equal(classifyBaseline(contextOf(withBoot, [boot('pass'), boot('pass')])), 'unaffected')
  assert.equal(classifyBaseline(contextOf(input(), [])), 'unknown')
  assert.match(describeBaseline(contextOf(withBoot, [boot('pass'), boot('fail')])), /boots on dsh-v0\.1\.7 \(verified\) and fails on dsh-v0\.2\.0/)
})
