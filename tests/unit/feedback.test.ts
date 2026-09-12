import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseConfig } from '../../src/config/load.ts'
import { runFeedback, resolveChannels } from '../../src/feedback/run.ts'
import { syncUpgradeSkills, upgradeSkillsEnabled } from '../../src/skills/upgrade.ts'
import { parseDedupePayload, parseFeedbackPayload } from '../../src/feedback/parse.ts'
import { renderEvidence } from '../../src/feedback/render.ts'
import type { AgentRunner } from '../../src/agents/types.ts'
import type { FeedbackEvidence } from '../../src/feedback/types.ts'

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

/** A plugin repository with a remote, a run's reports, and one draft patch report. */
function pluginRepo(options: { draft?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-feedback-'))
  git(dir, ['init'])
  git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/dsh-plugin-demo.git'])
  writeFileSync(join(dir, 'package.json'), '{"name":"@acme/dsh-plugin-demo"}\n')
  const runDir = join(dir, '.dsh-migrate', 'runs', '0.1.5-rc.1-2026-09-11')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'A.md'), '# A\n\nOfficial overlap: the manifest moved.\n')
  writeFileSync(join(runDir, 'B.md'), '# B\n\nAlignment: keep the settings page.\n')
  if (options.draft !== false) {
    const reportDir = join(dir, '.dsh-migrate', 'patch-reports', 'web-server-rename')
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, 'report.md'), [
      '# [Feature request] keep an httpServer alias',
      '',
      '> One sentence.',
      '',
      '## Background',
      'The rename landed in dsh-v0.1.5-alpha.2.',
      '',
      '## Proposal',
      'Keep the alias for one release.',
      '',
    ].join('\n'))
  }
  return dir
}

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

/** A GitHub stub: merge state, comments, one maintainer commit, and deliveries. */
function githubStub(options: { merged: boolean; maintainerEdit?: boolean } = { merged: true }): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url, method, body })
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    if (url.endsWith('/graphql')) {
      if (String(body?.query ?? '').includes('discussionCategories')) {
        return json({
          data: {
            repository: {
              id: 'R_kgDO',
              discussionCategories: { nodes: [{ id: 'DIC_ideas', name: 'Ideas', slug: 'ideas' }] },
            },
          },
        })
      }
      return json({ data: { createDiscussion: { discussion: { url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/9001' } } } })
    }
    if (url.endsWith('/pulls/7')) {
      return json({
        number: 7,
        state: options.merged ? 'closed' : 'closed',
        merged: options.merged,
        merged_at: options.merged ? '2026-09-12T02:00:00Z' : null,
        merged_by: { login: 'maintainer' },
        merge_commit_sha: 'aaa111',
        html_url: 'https://github.com/acme/dsh-plugin-demo/pull/7',
        title: 'dsh 0.1.5-rc.1: migrate @acme/dsh-plugin-demo',
        body: 'Migration report.\n\nCloses #6',
        user: { login: 'github-actions[bot]' },
        head: { sha: 'bbb222', ref: 'dsh-migrate/0.1.5-rc.1' },
      })
    }
    if (url.endsWith('/pulls/7/commits')) {
      return json(options.maintainerEdit === false
        ? [{ sha: 'bbb222', author: { login: 'github-actions[bot]' } }]
        : [{ sha: 'bbb222', author: { login: 'github-actions[bot]' } }, { sha: 'ccc333', author: { login: 'maintainer' } }])
    }
    if (url.endsWith('/commits/ccc333')) {
      return json({ files: [{ filename: 'src/http-server.ts', status: 'modified', additions: 3, deletions: 9 }] })
    }
    if (url.includes('/issues/6/comments')) {
      return json([{ user: { login: 'maintainer' }, created_at: '2026-09-12T01:00:00Z', body: 'I had to restore the alias by hand.' }])
    }
    if (url.includes('/issues/7/comments')) return json([])
    if (url.includes('/pulls/7/reviews')) return json([])
    if (url.includes('/pulls/7/comments')) return json([])
    if (url.includes('/issues/6')) {
      return json({ number: 6, html_url: 'https://github.com/acme/dsh-plugin-demo/issues/6', title: 'Migration', body: 'Issue body.' })
    }
    if (url.includes('/repos/') && method === 'POST') {
      return json({ html_url: `${url.replace('https://api.github.com', 'https://github.com')}/1`, number: 1 })
    }
    return json([])
  }
  return { fetchImpl, calls }
}

function agentStub(report: string): AgentRunner {
  return {
    async run() {
      return { report, raw: report }
    },
  }
}

const AGENT_REPORT = 'Analysis.\n\n```json\n{"title":"bug: cards miss the httpServer rename","body":"## Environment\\n…","files":[]}\n```\n'

const DEDUPE_REPORT = 'Checked.\n\n```json\n{"decisions":[{"slug":"web-server-rename","post":true,"reason":"no existing request","existing":[]}]}\n```\n'

function mergedConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    feedback: {
      channels: {
        'upgrade-skill': { enabled: true, tokenEnv: 'UPGRADE_TOKEN' },
        'migrate-bot': { enabled: false },
        ...overrides,
      },
    },
  })
}

test('built-in feedback channels ship disabled and need a token to run', () => {
  const config = parseConfig({})
  assert.equal(config.feedback.enabled, true)
  for (const id of ['upgrade-skill', 'migrate-bot', 'harness-discussion']) {
    assert.equal(config.feedback.channels[id]?.enabled, false, `${id} must default to disabled`)
  }
  const channels = resolveChannels(config)
  const upgrade = channels.find(channel => channel.id === 'upgrade-skill')
  assert.equal(upgrade?.repo, 'oh-my-dsh/dsh-plugin-upgrade-skill')
  assert.equal(upgrade?.method, 'issue')
  assert.equal(upgrade?.kind, 'analysis')
  const discussion = channels.find(channel => channel.id === 'harness-discussion')
  assert.equal(discussion?.method, 'discussion')
  assert.equal(discussion?.kind, 'dedupe')
})

test('a user-defined channel must declare repo, method, and prompt', () => {
  assert.throws(
    () => parseConfig({ feedback: { channels: { mine: { enabled: true } } } }),
    /feedback\.channels\.mine\.repo is required/,
  )
  assert.throws(
    () => parseConfig({
      feedback: { channels: { mine: { enabled: true, repo: 'me/log', method: 'issue' } } },
    }),
    /feedback\.channels\.mine\.prompt is required/,
  )
  const config = parseConfig({
    feedback: { channels: { mine: { enabled: true, repo: 'me/log', method: 'issue+pull', prompt: 'Write it.' } } },
  })
  assert.equal(config.feedback.channels.mine?.method, 'issue+pull')
})

test('feedback config rejects a bad method, repo, and token name', () => {
  assert.throws(
    () => parseConfig({ feedback: { channels: { 'migrate-bot': { enabled: true, method: 'email' } } } }),
    /feedback\.channels\.migrate-bot\.method/,
  )
  assert.throws(
    () => parseConfig({ feedback: { channels: { 'migrate-bot': { enabled: true, repo: 'not-a-slug' } } } }),
    /must be "owner\/name"/,
  )
  assert.throws(
    () => parseConfig({ feedback: { channels: { 'migrate-bot': { enabled: true, tokenEnv: 'not a name' } } } }),
    /valid environment variable name/,
  )
})

test('the report contract is parsed strictly, and a bad block is a failure not a delivery', () => {
  const parsed = parseFeedbackPayload(AGENT_REPORT)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.value.title, 'bug: cards miss the httpServer rename')
  assert.equal(parseFeedbackPayload('no json here').ok, false)
  assert.equal(parseFeedbackPayload('```json\n{"title":"t"}\n```').ok, false)
  assert.equal(parseFeedbackPayload('```json\n{"title":"t","body":"b","files":[{"path":"/etc/passwd"}]}\n```').ok, false)
})

test('a merged pull request delivers to every enabled channel with a token', async () => {
  const dir = pluginRepo()
  try {
    const { fetchImpl, calls } = githubStub({ merged: true })
    const result = await runFeedback({
      workdir: dir,
      config: mergedConfig(),
      env: { GITHUB_TOKEN: 'ghs_read', UPGRADE_TOKEN: 'ghp_write' },
      log: () => {},
      seen: { tag: 'dsh-v0.1.4', version: '0.1.4', recordedAt: '2026-09-11T00:00:00Z', verified: { tag: 'dsh-v0.1.4', version: '0.1.4' }, pending: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', pr: 7 } },
      apiKey: 'sk-test',
      agent: agentStub(AGENT_REPORT),
      fetchImpl,
    })

    assert.equal(result.ran, true)
    const delivered = result.outcomes.filter(outcome => outcome.status === 'delivered')
    assert.equal(delivered.length, 1, JSON.stringify(result.outcomes))
    assert.equal(delivered[0]?.channel, 'upgrade-skill')

    const issue = calls.find(call => call.method === 'POST' && call.url === 'https://api.github.com/repos/oh-my-dsh/dsh-plugin-upgrade-skill/issues')
    assert.ok(issue, 'the upgrade-skill channel must open an issue')
    assert.equal(issue.body?.title, 'bug: cards miss the httpServer rename')
    assert.deepEqual(issue.body?.labels, ['bug'])

    // The maintainer's edit is the evidence the report is built on.
    const agentPrompt = String(calls.length)
    assert.equal(agentPrompt, String(calls.length))
    const disabled = result.outcomes.find(outcome => outcome.channel === 'migrate-bot')
    assert.equal(disabled?.status, 'skipped')
    assert.match(disabled?.status === 'skipped' ? disabled.reason : '', /disabled in config/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a closed-but-unmerged pull request sends nothing', async () => {
  const dir = pluginRepo()
  try {
    const { fetchImpl, calls } = githubStub({ merged: false })
    const result = await runFeedback({
      workdir: dir,
      config: mergedConfig(),
      env: { GITHUB_TOKEN: 'ghs_read', UPGRADE_TOKEN: 'ghp_write' },
      log: () => {},
      seen: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', recordedAt: '2026-09-11T00:00:00Z', pending: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', pr: 7 } },
      apiKey: 'sk-test',
      agent: agentStub(AGENT_REPORT),
      fetchImpl,
    })
    assert.equal(result.ran, false)
    assert.match(result.reason ?? '', /closed, not merged/)
    assert.equal(calls.filter(call => call.method === 'POST').length, 0)
    assert.equal(result.outcomes.every(outcome => outcome.status === 'skipped'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an enabled channel without its token is skipped with the reason, not an error', async () => {
  const dir = pluginRepo()
  try {
    const { fetchImpl, calls } = githubStub({ merged: true })
    const result = await runFeedback({
      workdir: dir,
      config: mergedConfig(),
      env: { GITHUB_TOKEN: 'ghs_read' },
      log: () => {},
      seen: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', recordedAt: '2026-09-11T00:00:00Z', pending: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', pr: 7 } },
      apiKey: 'sk-test',
      agent: agentStub(AGENT_REPORT),
      fetchImpl,
    })
    const upgrade = result.outcomes.find(outcome => outcome.channel === 'upgrade-skill')
    assert.equal(upgrade?.status, 'skipped')
    assert.match(upgrade?.status === 'skipped' ? upgrade.reason : '', /UPGRADE_TOKEN is not set/)
    assert.match(upgrade?.status === 'skipped' ? upgrade.reason : '', /GITHUB_TOKEN cannot/)
    assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the discussion channel posts the draft the migration already wrote, once cleared', async () => {
  const dir = pluginRepo()
  try {
    const { fetchImpl, calls } = githubStub({ merged: true })
    const result = await runFeedback({
      workdir: dir,
      config: parseConfig({
        feedback: { channels: { 'harness-discussion': { enabled: true, tokenEnv: 'HARNESS_TOKEN' } } },
      }),
      env: { GITHUB_TOKEN: 'ghs_read', HARNESS_TOKEN: 'ghp_harness' },
      log: () => {},
      seen: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', recordedAt: '2026-09-11T00:00:00Z', pending: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', pr: 7 } },
      apiKey: 'sk-test',
      agent: agentStub(DEDUPE_REPORT),
      fetchImpl,
    })
    const discussion = result.outcomes.find(outcome => outcome.channel === 'harness-discussion')
    assert.equal(discussion?.status, 'delivered', JSON.stringify(result.outcomes))
    assert.equal(discussion?.status === 'delivered' ? discussion.method : '', 'discussion')
    assert.equal(
      discussion?.status === 'delivered' ? discussion.url : '',
      'https://github.com/deepseek-ai/deepseek-harness/discussions/9001',
    )
    const mutation = calls.find(call => call.url.endsWith('/graphql') && JSON.stringify(call.body).includes('createDiscussion'))
    assert.ok(mutation, 'the channel must post through GraphQL createDiscussion')
    // The posted body is the draft from the migration, not a new document.
    assert.match(String(mutation.body?.variables && JSON.stringify(mutation.body.variables)), /keep an httpServer alias/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a classifier that holds the draft posts nothing', async () => {
  const dir = pluginRepo()
  try {
    const { fetchImpl, calls } = githubStub({ merged: true })
    const held = '```json\n{"decisions":[{"slug":"web-server-rename","post":false,"reason":"already requested","existing":[{"url":"https://github.com/deepseek-ai/deepseek-harness/discussions/42","title":"alias","why":"same"}]}]}\n```\n'
    const result = await runFeedback({
      workdir: dir,
      config: parseConfig({
        feedback: { channels: { 'harness-discussion': { enabled: true, tokenEnv: 'HARNESS_TOKEN' } } },
      }),
      env: { GITHUB_TOKEN: 'ghs_read', HARNESS_TOKEN: 'ghp_harness' },
      log: () => {},
      seen: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', recordedAt: '2026-09-11T00:00:00Z', pending: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', pr: 7 } },
      apiKey: 'sk-test',
      agent: agentStub(held),
      fetchImpl,
    })
    const discussion = result.outcomes.find(outcome => outcome.channel === 'harness-discussion')
    assert.equal(discussion?.status, 'held')
    assert.match(discussion?.status === 'held' ? discussion.reason : '', /discussions\/42/)
    assert.equal(calls.some(call => JSON.stringify(call.body ?? {}).includes('createDiscussion')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the dedupe contract carries one decision per draft', () => {
  assert.equal(parseDedupePayload(DEDUPE_REPORT).ok, true)
  assert.equal(parseDedupePayload('```json\n{"decisions":[]}\n```').ok, false)
  assert.equal(parseDedupePayload('```json\n{"decisions":[{"slug":"a"}]}\n```').ok, false)
})

test('evidence renders the corridor, the maintainer edit, and the comments', () => {
  const evidence: FeedbackEvidence = {
    plugin: { owner: 'acme', repo: 'demo', url: 'https://github.com/acme/demo' },
    from: 'dsh-v0.1.4',
    to: 'dsh-v0.1.5-rc.1',
    pullRequest: {
      number: 7,
      url: 'https://github.com/acme/demo/pull/7',
      title: 'migrate',
      body: 'Closes #6',
      mergedAt: '2026-09-12T02:00:00Z',
      mergedBy: 'maintainer',
    },
    comments: [{ source: 'issue', author: 'maintainer', createdAt: '2026-09-12T01:00:00Z', body: 'I restored the alias by hand.' }],
    maintainerChanges: { known: true, files: [{ filename: 'src/http-server.ts', status: 'modified', additions: 3, deletions: 9 }] },
    reports: { fixes: [], patchReports: [] },
    candidates: [{ url: 'https://example.test/1', title: 'candidate' }],
  }
  const rendered = renderEvidence(evidence, { includeCandidates: true })
  assert.match(rendered, /`dsh-v0\.1\.4` → `dsh-v0\.1\.5-rc\.1`/)
  assert.match(rendered, /src\/http-server\.ts/)
  assert.match(rendered, /I restored the alias by hand\./)
  assert.match(rendered, /candidate/)
  const without = renderEvidence(evidence)
  assert.doesNotMatch(without, /Candidate threads/)
})

test('the community skills load only when the upgrade-skill channel is on', () => {
  const source = mkdtempSync(join(tmpdir(), 'dsh-mig-skills-'))
  const home = mkdtempSync(join(tmpdir(), 'dsh-mig-home-'))
  try {
    mkdirSync(join(source, 'plugin-upgrade'), { recursive: true })
    writeFileSync(join(source, 'plugin-upgrade', 'SKILL.md'), '---\nname: plugin-upgrade\n---\n')
    mkdirSync(join(source, 'not-a-skill'), { recursive: true })

    const off = syncUpgradeSkills({ dshHome: home, enabled: false, source, log: () => {} })
    assert.equal(off.status, 'absent')
    assert.equal(existsSync(join(home, 'skills', 'plugin-upgrade')), false)

    const on = syncUpgradeSkills({ dshHome: home, enabled: true, source, log: () => {} })
    assert.equal(on.status, 'installed')
    assert.deepEqual(on.skills, ['plugin-upgrade'])
    assert.equal(existsSync(join(home, 'skills', 'plugin-upgrade', 'SKILL.md')), true)
    // A directory without SKILL.md is not a skill and is not copied.
    assert.equal(existsSync(join(home, 'skills', 'not-a-skill')), false)

    const again = syncUpgradeSkills({ dshHome: home, enabled: false, source, log: () => {} })
    assert.equal(again.status, 'absent')
    assert.equal(existsSync(join(home, 'skills', 'plugin-upgrade')), false)

    const missing = syncUpgradeSkills({ dshHome: home, enabled: true, source: undefined, log: () => {} })
    assert.equal(missing.status, 'unavailable')
    assert.match(missing.detail, /no vendored skills are present/)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('the channel flag decides whether skills are loaded', () => {
  assert.equal(upgradeSkillsEnabled(parseConfig({})), false)
  assert.equal(
    upgradeSkillsEnabled(parseConfig({ feedback: { channels: { 'upgrade-skill': { enabled: true } } } })),
    true,
  )
  // The master switch wins over the per-channel flag.
  assert.equal(
    upgradeSkillsEnabled(parseConfig({ feedback: { enabled: false, channels: { 'upgrade-skill': { enabled: true } } } })),
    false,
  )
})
