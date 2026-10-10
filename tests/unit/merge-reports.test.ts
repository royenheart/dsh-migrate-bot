import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runReportChannel, type ReportDeps } from '../../src/merge-reports/run.ts'
import { lastFencedBlock, parsePayload, reportPayloadSchema } from '../../src/merge-reports/parse.ts'
import { GitHubClient } from '../../src/github/client.ts'
import { parseConfig } from '../../src/config/load.ts'
import { FakeGitHub } from '../support/github.ts'
import { contextOf, input, proposal, proposedEvents, settings } from '../support/migration.ts'
import type { AgentRequest, AgentRunner } from '../../src/agents/types.ts'

const ENV = { GITHUB_API_URL: 'https://api.test', DSH_MIGRATE_REPORT_BOT_TOKEN: 'bot-token', DSH_MIGRATE_REPORT_HARNESS_TOKEN: 'harness-token' }
const OPEN = proposal(9)

function fixture(agentOutput: string) {
  const github = new FakeGitHub()
  github.addIssue({ number: OPEN.issue.number, comments: [{ body: 'I renamed the export by hand', user: 'maintainer', created_at: '2026-10-10T02:00:00Z' }, { body: 'bot noise', user: 'github-actions[bot]', created_at: '2026-10-10T01:00:00Z' }] })
  github.addPull({ number: OPEN.pullRequest.number, title: 'Migrate', merged: true, state: 'closed', head: { ref: 'dsh-migrate/proposal', sha: 'e'.repeat(40) } })
  github.comparisons.set(`${OPEN.headSha}...${'e'.repeat(40)}`, [{ filename: 'index.js', status: 'modified', additions: 1, deletions: 1 }])
  const files = new Map<string, string>([
    ['migrations/0.2.0/reports/overlap.md', '# Overlap\nDecision: keep'],
    ['migrations/0.2.0/patch-reports/pre-step.md', '# [Feature request] pre-step hook\n\n## Proposal\nadd it\n'],
  ])
  const prompts: AgentRequest[] = []
  const agent: AgentRunner = { run: async (request) => { prompts.push(request); return { report: agentOutput, raw: agentOutput } } }
  const migration = {
    id: '0.2.0',
    context: contextOf(input('0.2.0', { settings: settings({ reportChannels: ['migrate-bot', 'harness-discussion'] }) }), [...proposedEvents(OPEN), { type: 'pull-request.closed', number: 9, merged: true }]),
  }
  const deps: ReportDeps = {
    config: parseConfig({ reports: { channels: { 'migrate-bot': { enabled: true }, 'harness-discussion': { enabled: true } } } }),
    env: ENV,
    repository: { owner: 'acme', name: 'plugin' },
    github: new GitHubClient('workflow-token', ENV, github.fetch),
    files: { list: dir => [...files.keys()].filter(path => path.startsWith(`${dir}/`)), readFile: path => files.get(path) },
    agent,
    apiKey: 'sk-test',
    workdir: '/tmp',
    syncSkills: () => {},
    fetchImpl: github.fetch,
  }
  return { github, deps, prompts, migration }
}

const REPORT = 'Findings.\n\n```json\n{"title":"The repair missed a renamed export","body":"## Run\\n…"}\n```\n'

test('an analysis channel reasons over the merge and delivers one issue to its repository', async () => {
  const { github, deps, prompts, migration } = fixture(REPORT)
  const outcome = await runReportChannel('migrate-bot', migration, deps, 'deliver')
  assert.equal(outcome.outcome, 'delivered', outcome.detail)
  assert.deepEqual(github.external.map(issue => [issue.repo, issue.title]), [['royenheart/dsh-migrate-bot', 'The repair missed a renamed export']])
  const prompt = prompts[0]?.prompt ?? ''
  assert.match(prompt, /I renamed the export by hand/)
  assert.doesNotMatch(prompt, /bot noise/)
  assert.match(prompt, /\| `index\.js` \| modified \| 1 \| 1 \|/)
  assert.match(prompt, /Decision: keep/)
  assert.equal(prompts[0]?.kind, 'report')
})

test('a channel without its token, or without an API key, is skipped with the reason', async () => {
  const { deps, migration, prompts } = fixture(REPORT)
  const noToken = await runReportChannel('migrate-bot', migration, { ...deps, env: { GITHUB_API_URL: 'https://api.test' } }, 'deliver')
  assert.deepEqual(noToken, { outcome: 'skipped', detail: '`DSH_MIGRATE_REPORT_BOT_TOKEN` is not set' })
  const noKey = await runReportChannel('migrate-bot', migration, { ...deps, apiKey: undefined }, 'deliver')
  assert.equal(noKey.outcome, 'skipped')
  assert.equal(prompts.length, 0)
})

test('output that breaks the contract is a failure, never a half-written issue', async () => {
  const { deps, migration, github } = fixture('no json at all')
  const outcome = await runReportChannel('migrate-bot', migration, deps, 'deliver')
  assert.equal(outcome.outcome, 'failed')
  assert.equal(github.external.length, 0)
})

test('a dry run produces the payload and delivers nothing', async () => {
  const { deps, migration, github } = fixture(REPORT)
  const outcome = await runReportChannel('migrate-bot', migration, deps, 'dry-run')
  assert.equal(outcome.outcome, 'dry-run')
  assert.match(outcome.detail, /^The repair missed a renamed export/)
  assert.equal(github.external.length, 0)
})

test('the duplicate check posts a cleared draft as a discussion and holds one already asked', async () => {
  const post = '```json\n{"decisions":[{"slug":"pre-step","post":true,"reason":"no thread","existing":[]}]}\n```\n'
  const cleared = fixture(post)
  assert.equal((await runReportChannel('harness-discussion', cleared.migration, cleared.deps, 'deliver')).outcome, 'delivered')
  assert.deepEqual(cleared.github.discussions.map(discussion => discussion.title), ['[Feature request] pre-step hook'])
  // The search ran, so the classifier judged real candidates rather than none.
  assert.ok(cleared.github.requests.some(request => request.path.startsWith('/search/issues')))

  const hold = '```json\n{"decisions":[{"slug":"pre-step","post":false,"reason":"already requested","existing":[{"url":"https://github.com/deepseek-ai/deepseek-harness/issues/1","title":"t","why":"same"}]}]}\n```\n'
  const held = fixture(hold)
  const outcome = await runReportChannel('harness-discussion', held.migration, held.deps, 'deliver')
  assert.equal(outcome.outcome, 'held')
  assert.match(outcome.detail, /pre-step: already requested \(https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/issues\/1\)/)
  assert.equal(held.github.discussions.length, 0)
})

test('the payload is read from the last fenced block only', () => {
  assert.equal(lastFencedBlock('```json\n{"a":1}\n```\ntext\n```json\n{"b":2}\n```'), '{"b":2}')
  assert.equal(lastFencedBlock('no fence'), undefined)
  assert.equal(parsePayload('```json\n{"title":" ","body":"b"}\n```', reportPayloadSchema).ok, false)
})
