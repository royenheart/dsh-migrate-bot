import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runReportChannel, type ReportDeps } from '../../src/merge-reports/run.ts'
import { lastFencedBlock, parsePayload, reportPayloadSchema } from '../../src/merge-reports/parse.ts'
import { GitHubClient } from '../../src/github/client.ts'
import { parseConfig } from '../../src/config/load.ts'
import { FakeGitHub } from '../support/github.ts'
import { contextOf, input, proposal, proposedEvents, settings } from '../support/migration.ts'
import type { AgentRequest, AgentRunner } from '../../src/agents/types.ts'
import { buildRunManifest, serializeManifest, sha256 } from '../../src/observability/manifest.ts'

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

const REPORT = 'Findings.\n\n```json\n' + JSON.stringify({
  title: 'The repair missed a renamed export',
  findings: [
    { stage: 'mechanical', severity: 'high', finding: 'The mechanical check missed a renamed export.', evidence: 'The maintainer renamed it by hand in index.js.', fix: 'Add the export to the unit test.', attribution: 'action' },
    { stage: 'web check', severity: 'low', finding: 'The web check only waited for the ready line.', evidence: 'The role picker was never clicked.', fix: 'Assert the preset is registered.', attribution: 'pre-existing' },
  ],
  limits: ['The evidence did not carry the raw diff.'],
}, null, 2) + '\n```\n'

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
  assert.match(prompt, /"findings"/)
  assert.match(prompt, /Action version: `1\.0\.0-rc\.2`/)
  assert.match(prompt, /Model: `deepseek-official\/deepseek-v4-flash`/)
  const body = github.external[0]?.body ?? ''
  assert.match(body, /## Findings/)
  assert.match(body, /### 1\. \[high\] mechanical:/)
  assert.match(body, /\*\*Attribution\.\*\* Pre-existing\./)
  assert.doesNotMatch(body, /not a defect|not scored|not just/)
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

test('a GitHub call that fails is a failure of this channel, not an error of the migration', async () => {
  const { deps, migration } = fixture(REPORT)
  const failing: typeof fetch = async (url, init) => String(url).includes('dsh-migrate-bot/issues') ? new Response('{"message":"Resource not accessible"}', { status: 403 }) : (deps.fetchImpl as typeof fetch)(url, init)
  const outcome = await runReportChannel('migrate-bot', migration, { ...deps, fetchImpl: failing }, 'deliver')
  assert.equal(outcome.outcome, 'failed')
  assert.match(outcome.detail, /403|not accessible/i)
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
  // A body that quotes code holds backticks inside a JSON string, never on a line of their own.
  const quoting = '```json\n{"title":"t","body":"Steps:\\n```ts\\nfoo()\\n```\\nend"}\n```\n'
  assert.deepEqual(parsePayload(quoting, reportPayloadSchema), { ok: true, value: { title: 't', body: 'Steps:\n```ts\nfoo()\n```\nend' } })
  assert.equal(lastFencedBlock('no fence'), undefined)
  assert.equal(parsePayload('```json\n{"title":" ","body":"b"}\n```', reportPayloadSchema).ok, false)
})

test('the changed-file table survives an unreachable proposal head', async () => {
  const { github, deps, prompts, migration } = fixture(REPORT)
  const base = github.fetch
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/compare/')) return new Response('{"message":"Not Found"}', { status: 404 })
    if (url.includes(`/pulls/${String(OPEN.pullRequest.number)}/files`)) {
      return new Response(JSON.stringify([{ filename: 'index.js', status: 'modified', additions: 2, deletions: 1 }]), { status: 200 })
    }
    return await base(input, init)
  }
  const outcome = await runReportChannel('migrate-bot', migration, {
    ...deps,
    github: new GitHubClient('workflow-token', ENV, fetchImpl),
  }, 'deliver')
  assert.equal(outcome.outcome, 'delivered', outcome.detail)
  assert.match(prompts[0]?.prompt ?? '', /\| `index\.js` \| modified \| 2 \| 1 \|/)
})

test('the proposal check lines reach the rendered report', async () => {
  const { github, deps, migration } = fixture(REPORT)
  const pull = github.pulls.get(OPEN.pullRequest.number)
  if (pull !== undefined) pull.body = '## Checks\n\n- Boot check: skipped\n- Web check: pass\n\n## Before merging\n\n- [ ] Merge\n'
  const outcome = await runReportChannel('migrate-bot', migration, deps, 'deliver')
  assert.equal(outcome.outcome, 'delivered', outcome.detail)
  const body = github.external[0]?.body ?? ''
  assert.match(body, /- Checks:\n  - Boot check: skipped\n  - Web check: pass/)
})


test('manifest metrics reach the report evidence and the delivered body', async () => {
  const { deps, migration, prompts, github } = fixture(REPORT)
  const manifest = buildRunManifest({
    runId: '123-1',
    migrationId: '0.2.0',
    plugin: ['plugin'],
    target: { tag: 'dsh-v0.2.0', version: '0.2.0' },
    agent: { provider: 'deepseek-official', model: 'deepseek-v4-flash', thinking: 'enabled', reasoningEffort: 'max', upgradeSkills: true },
    sessions: [{
      kind: 'overlap',
      name: 'overlap',
      prompt: 'review',
      promptSha256: sha256('review'),
      startedAt: '2026-10-27T13:00:00.000Z',
      endedAt: '2026-10-27T13:05:00.000Z',
      outcome: 'completed',
      usage: { inputTokens: 100, outputTokens: 20, cacheHitTokens: 30, usd: 0.01 },
      progress: { turns: 3, steps: 7, elapsedSeconds: 300 },
      toolCalls: 4,
      observations: [],
    }],
    checks: [],
    outcome: 'accepted',
    startedAt: '2026-10-27T13:00:00.000Z',
    endedAt: '2026-10-27T13:06:00.000Z',
  })
  const path = 'migrations/0.2.0/runs/123-1/manifest.json'
  const files = {
    list: (dir: string) => [...deps.files.list(dir), ...(dir === 'migrations/0.2.0/runs' ? [path] : [])],
    readFile: (file: string) => file === path ? serializeManifest(manifest) : deps.files.readFile(file),
  }
  const outcome = await runReportChannel('migrate-bot', migration, { ...deps, files }, 'deliver')
  assert.equal(outcome.outcome, 'delivered', outcome.detail)
  assert.match(prompts[0]?.prompt ?? '', /Agent work: 1 run\(s\), 1 session\(s\), 3 turns, 7 steps, 4 tool calls/)
  assert.match(prompts[0]?.prompt ?? '', /Agent cost: \$0\.010000/)
  assert.match(github.external[0]?.body ?? '', /Agent work: 1 run/)
})
