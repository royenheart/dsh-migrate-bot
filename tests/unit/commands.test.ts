import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, mayRunCommands, type ParsedCommand } from '../../src/commands/parse.ts'
import { COMMANDS, renderCommandHelp } from '../../src/commands/table.ts'
import { commandKey, resolveDeployService, runCommand, type CommandOutcome, type CommandRunInput } from '../../src/commands/run.ts'
import { parseConfig } from '../../src/config/load.ts'
import { GitHubClient } from '../../src/github/client.ts'
import { project, type MigrationView, type Projection } from '../../src/workflow/projection.ts'
import type { LogEntry, MigrationEvent, MigrationInput } from '../../src/workflow/model.ts'

const DEPLOY = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
const TOKEN = { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' }
const REPOSITORY = { owner: 'me', name: 'plugin' }

function command(body: string): ParsedCommand {
  const parsed = parseCommand(body)
  if (!parsed.ok) throw new Error(`not a command: ${body}`)
  return parsed.command
}

/**
 * Run one command with every dependency that a test does not name set to
 * something that fails loudly when it is reached.
 */
async function run(body: string, overrides: Partial<CommandRunInput> = {}): Promise<CommandOutcome> {
  return await runCommand({
    command: command(body),
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    repository: REPOSITORY,
    github: undefined,
    issueNumber: undefined,
    commentId: '55',
    log: () => {},
    status: () => project(new Map()),
    report: async () => { throw new Error('report must not be called') },
    reportDryRun: async () => { throw new Error('reportDryRun must not be called') },
    checkTree: undefined,
    treeDir: '/nonexistent',
    fetchImpl: async () => { throw new Error('the deploy service must not be reached') },
    ...overrides,
  })
}

const AT = '2026-09-14T00:00:00.000Z'

/**
 * The log of one migration, replayed by the real machine. With every check but
 * the mechanical one off and `when-checks-fail`, one passing check reaches the
 * tree inspection; a changed tree is published and waits for a merge, an
 * unchanged one is compatible. `events` are appended after that.
 */
function migrationLog(options: {
  version: string
  tag?: string
  changed?: boolean
  pullRequest?: number
  issue?: number
  channels?: string[]
  events?: MigrationEvent[]
}): LogEntry[] {
  const input: MigrationInput = {
    target: { tag: options.tag ?? `dsh-v${options.version}`, version: options.version },
    settings: {
      reviewPolicy: 'when-checks-fail',
      maxAttempts: 1,
      e2eFailurePolicy: 'advisory',
      checks: { boot: false, web: false, e2e: false },
      e2eSubsetFirst: false,
      publish: true,
      reportChannels: options.channels ?? [],
    },
  }
  const pullRequest = options.pullRequest ?? 13
  const issue = options.issue ?? 12
  const changed = options.changed ?? true
  const events: MigrationEvent[] = [
    { type: 'check.done', result: { check: 'mechanical', outcome: 'pass', fingerprint: '', detail: '' } },
    { type: 'tree.inspected', changed, files: changed ? 1 : 0 },
    ...(changed
      ? [{
        type: 'proposal.published' as const,
        proposal: {
          branch: `dsh-migrate/${options.version}`,
          headSha: 'abcdef1234567890',
          issue: { number: issue, url: `https://github.com/me/plugin/issues/${String(issue)}` },
          pullRequest: { number: pullRequest, url: `https://github.com/me/plugin/pull/${String(pullRequest)}` },
        },
      }]
      : []),
    ...(options.events ?? []),
  ]
  return [
    { kind: 'started', at: AT, run: 'run-1', input },
    ...events.map(event => ({ kind: 'event' as const, at: AT, event })),
  ]
}

function projectionOf(logs: Record<string, LogEntry[]>): Projection {
  return project(new Map(Object.entries(logs)))
}

/** The one migration of a projection that has one. */
function only(projection: Projection): MigrationView {
  const view = projection.migrations[0]
  if (view === undefined || projection.migrations.length !== 1) throw new Error('expected one migration')
  return view
}

test('a command is read out of the prose around it', () => {
  const parsed = parseCommand('Looks good to me.\n\n/dsh-migrate status\n\nthanks!')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.command.spec.verb, 'status')
})

test('flags are accepted only where the verb declares them', () => {
  const dry = parseCommand('/dsh-migrate report --dry-run')
  assert.equal(dry.ok, true)
  assert.deepEqual(dry.ok && dry.command.flags, ['--dry-run'])
  const wrong = parseCommand('/dsh-migrate status --dry-run')
  assert.equal(wrong.ok, false)
  assert.match(wrong.ok ? '' : wrong.reason, /does not take/)
})

test('an unknown verb answers with the vocabulary, not silence', () => {
  const parsed = parseCommand('/dsh-migrate teleport')
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok ? '' : parsed.reason, /not a command/)
  assert.match(parsed.ok ? '' : parsed.reason, /redeploy/)
  // The verb `report` replaced is not a command any more.
  const old = parseCommand('/dsh-migrate feedback')
  assert.match(old.ok ? '' : old.reason, /`feedback` is not a command/)
})

test('the prefix alone asks for help, and text without it is not a command', () => {
  const help = parseCommand('/dsh-migrate')
  assert.equal(help.ok, false)
  assert.equal(help.ok ? '' : help.reason, 'help')
  assert.equal(parseCommand('no command here').ok, false)
})

test('only a writer may run commands, and never a bot', () => {
  assert.equal(mayRunCommands({ authorAssociation: 'OWNER', authorLogin: 'maintainer' }), true)
  assert.equal(mayRunCommands({ authorAssociation: 'MEMBER', authorLogin: 'maintainer' }), true)
  assert.equal(mayRunCommands({ authorAssociation: 'COLLABORATOR', authorLogin: 'maintainer' }), true)
  assert.equal(mayRunCommands({ authorAssociation: 'CONTRIBUTOR', authorLogin: 'stranger' }), false)
  assert.equal(mayRunCommands({ authorAssociation: 'NONE', authorLogin: 'stranger' }), false)
  assert.equal(mayRunCommands({ authorAssociation: 'OWNER', authorLogin: 'dependabot[bot]' }), false)
  assert.equal(mayRunCommands({ authorAssociation: 'OWNER', authorLogin: 'me' }), true)
  assert.equal(mayRunCommands({ authorAssociation: 'OWNER', authorLogin: 'me', selfLogin: 'me' }), false)
})

test('the published vocabulary covers every verb the executor branches on', () => {
  const verbs = COMMANDS.map(spec => spec.verb)
  assert.deepEqual(verbs, ['status', 'report', 'redeploy', 'destroy', 'extend', 'publish'])
  // The verbs that act on a preview deployment are the ones that need a deploy service.
  assert.deepEqual(COMMANDS.filter(spec => spec.needsDeployService).map(spec => spec.verb), ['redeploy', 'destroy', 'extend', 'publish'])
  assert.match(renderCommandHelp(), /dsh-migrate publish/)
})

test('a deploy service needs an endpoint and a token', () => {
  const off = resolveDeployService(parseConfig({}), {})
  assert.equal('reason' in off, true)
  assert.match('reason' in off ? off.reason : '', /deploy.enabled/)

  const noToken = resolveDeployService(DEPLOY, {})
  assert.equal('reason' in noToken, true)
  assert.match('reason' in noToken ? noToken.reason : '', /DSH_MIGRATE_DEPLOY_TOKEN.*is not set/)

  const ready = resolveDeployService(DEPLOY, TOKEN)
  assert.deepEqual(ready, { endpoint: 'https://deploy.test', token: 'secret' })

  // The token variable is configurable, and the configured one is the one read.
  const renamed = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', tokenEnv: 'MY_DEPLOY_TOKEN' } })
  assert.deepEqual(resolveDeployService(renamed, { MY_DEPLOY_TOKEN: 'other' }), { endpoint: 'https://deploy.test', token: 'other' })
  const missing = resolveDeployService(renamed, TOKEN)
  assert.match('reason' in missing ? missing.reason : '', /MY_DEPLOY_TOKEN/)
})

test('a deploy verb without a deploy service refuses and says why', async () => {
  const outcome = await run('/dsh-migrate destroy', { issueNumber: 7 })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /deploy.enabled/)
})

test('a deploy verb reaches the deploy service at the preview path for this pull request', async () => {
  const calls: Array<{ url: string; method: string; body: string | undefined; key: string | null }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      key: new Headers(init?.headers).get('Idempotency-Key'),
    })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const outcome = await run('/dsh-migrate redeploy', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /`redeploy` accepted/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'POST')
  assert.match(calls[0]?.url ?? '', /\/previews\/[^/]+\/7$/)
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { action: 'redeploy' })
})

test('each deploy verb carries a key that names the comment, so a redelivery is one command', async () => {
  assert.equal(commandKey('me/plugin', 7, 'destroy', '55'), 'me/plugin#7:destroy:comment=55')
  const seen: Array<{ method: string; key: string | null }> = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push({ method: init?.method ?? 'GET', key: new Headers(init?.headers).get('Idempotency-Key') })
    return new Response('{}', { status: 200 })
  }
  for (const verb of ['redeploy', 'destroy', 'extend']) {
    await run(`/dsh-migrate ${verb}`, { config: DEPLOY, env: TOKEN, issueNumber: 7, commentId: '55', fetchImpl })
  }
  assert.deepEqual(seen, [
    { method: 'POST', key: 'me/plugin#7:redeploy:comment=55' },
    { method: 'DELETE', key: 'me/plugin#7:destroy:comment=55' },
    { method: 'POST', key: 'me/plugin#7:extend:comment=55' },
  ])
})

test('status reports the migration state and every report channel, on or off', async () => {
  const projection = projectionOf({
    '0.1.5': migrationLog({ version: '0.1.5', changed: false }),
    '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13 }),
  })
  const outcome = await run('/dsh-migrate status', {
    config: parseConfig({
      reports: { channels: { 'upgrade-skill': { enabled: true }, 'migrate-bot': { enabled: false } } },
    }),
    status: () => projection,
  })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /- Processed release: `dsh-v0\.1\.6` \(awaitingMerge\)/)
  assert.match(outcome.reply, /- Verified release: `dsh-v0\.1\.5`/)
  assert.match(outcome.reply, /- Open proposal: #13 for `dsh-v0\.1\.6` \(awaitingMerge\)/)
  assert.match(outcome.reply, /`upgrade-skill`: on, but `DSH_MIGRATE_REPORT_UPGRADE_SKILL_TOKEN` is not set/)
  assert.match(outcome.reply, /`migrate-bot`: off/)
  assert.match(outcome.reply, /`harness-discussion`: off/)
  // No deploy service is configured, so the reply does not pretend to have asked one.
  assert.doesNotMatch(outcome.reply, /Deploy service|Preview deployment/)
  assert.match(outcome.reply, /<summary>Commands<\/summary>/)
})

test('status of a consumer with no migration says so rather than inventing one', async () => {
  const outcome = await run('/dsh-migrate status')
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /- Processed release: —/)
  assert.match(outcome.reply, /- Verified release: —/)
  assert.match(outcome.reply, /- Open proposal: none/)
})

test('a report channel is on only when reports are, and its token is looked for', async () => {
  const config = parseConfig({ reports: { channels: { 'upgrade-skill': { enabled: true }, 'harness-discussion': { enabled: true } } } })
  const withToken = await run('/dsh-migrate status', { config, env: { DSH_MIGRATE_REPORT_UPGRADE_SKILL_TOKEN: 't' } })
  assert.match(withToken.reply, /- `upgrade-skill`: on\n/)
  assert.match(withToken.reply, /`harness-discussion`: on, but `DSH_MIGRATE_REPORT_HARNESS_TOKEN` is not set/)

  const reportsOff = await run('/dsh-migrate status', {
    config: parseConfig({ reports: { enabled: false, channels: { 'upgrade-skill': { enabled: true } } } }),
    env: { DSH_MIGRATE_REPORT_UPGRADE_SKILL_TOKEN: 't' },
  })
  assert.match(reportsOff.reply, /`upgrade-skill`: off/)
})

test('a dry run reports what each channel would send', async () => {
  const projection = projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13, channels: ['upgrade-skill', 'migrate-bot'] }) })
  const asked: string[] = []
  const outcome = await run('/dsh-migrate report --dry-run', {
    issueNumber: 13,
    status: () => projection,
    reportDryRun: async (view) => {
      asked.push(view.id)
      return [
        { channel: 'upgrade-skill', result: { outcome: 'dry-run', detail: 'bug: a card is stale\n\nbody' } },
        { channel: 'migrate-bot', result: { outcome: 'skipped', detail: '`DSH_MIGRATE_REPORT_BOT_TOKEN` is not set' } },
      ]
    },
  })
  assert.deepEqual(asked, ['0.1.6'])
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /\*\*Report dry run\*\*/)
  assert.match(outcome.reply, /- `upgrade-skill`: dry-run\n/)
  assert.match(outcome.reply, /bug: a card is stale/)
  assert.match(outcome.reply, /- `migrate-bot`: skipped — DSH_MIGRATE_REPORT_BOT_TOKEN is not set/)
})

test('a dry run with no channel enabled says so', async () => {
  const projection = projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13 }) })
  const outcome = await run('/dsh-migrate report --dry-run', { issueNumber: 13, status: () => projection, reportDryRun: async () => [] })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /No report channel is enabled/)
})

test('a commenter is never refused for being the actor who triggered the run', () => {
  // The bug this pins: `GITHUB_ACTOR` on an `issue_comment` event IS the
  // commenter, so passing it as the Action's own login refused every real
  // command from every real user.
  assert.equal(mayRunCommands({ authorAssociation: 'OWNER', authorLogin: 'maintainer' }), true)
})

test('a deploy verb with no pull request or no repository is refused, not guessed', async () => {
  let reached = false
  const fetchImpl: typeof fetch = async () => { reached = true; return new Response('{}', { status: 200 }) }
  const noPull = await run('/dsh-migrate destroy', { config: DEPLOY, env: TOKEN, fetchImpl })
  // Without a pull request there is nothing to act on, and the reason says so.
  assert.equal(noPull.ok, false)
  assert.match(noPull.reply, /names no pull request of a known repository/)
  const noRepository = await run('/dsh-migrate destroy', { config: DEPLOY, env: TOKEN, issueNumber: 7, repository: undefined, fetchImpl })
  assert.equal(noRepository.ok, false)
  assert.match(noRepository.reply, /names no pull request of a known repository/)
  assert.equal(reached, false)
})

test('the preview verbs respect the preview switch', async () => {
  const outcome = await run('/dsh-migrate redeploy', {
    config: parseConfig({
      deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { enabled: false } },
    }),
    env: TOKEN,
    issueNumber: 3,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /deploy\.preview\.enabled/)
})

test('a deploy service that refuses a command is reported, not thrown', async () => {
  const outcome = await run('/dsh-migrate destroy', {
    config: DEPLOY,
    env: TOKEN,
    issueNumber: 3,
    fetchImpl: async () => { throw new Error('connection refused') },
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /destroy.*failed/s)
  assert.match(outcome.reply, /connection refused/)
})

test('a dry run shows the payload it would send, not only its title', async () => {
  const projection = projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13, channels: ['upgrade-skill'] }) })
  const outcome = await run('/dsh-migrate report --dry-run', {
    issueNumber: 13,
    status: () => projection,
    reportDryRun: async () => [
      { channel: 'upgrade-skill', result: { outcome: 'dry-run', detail: 'bug: a card is stale\n\n## Environment\n\n- plugin: acme/demo' } },
    ],
  })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /<summary>Would send<\/summary>/)
  assert.match(outcome.reply, /- plugin: acme\/demo/)
})

test('status says why the last preview build failed', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ state: 'failed', detail: 'the boot check failed: plugin @acme/plugin threw on activate' }), { status: 200 })
  const outcome = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.match(outcome.reply, /- Preview deployment: failed\n  - the boot check failed: plugin @acme\/plugin threw on activate/)
})

test('status reports the preview deployment the deploy service knows about, not just the request', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async input => {
    calls.push(String(input))
    return new Response(JSON.stringify({
      state: 'running',
      url: 'https://preview.test/abc',
      safeUrl: 'https://preview.test/abc/safe',
      headSha: 'abcdef1234567890',
      expiresAt: '2026-09-22T00:00:00Z',
      extendedDays: 7,
      revision: 'rev-7',
    }), { status: 200 })
  }
  const outcome = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? '', /\/previews\/me%2Fplugin\/7$/)
  assert.match(outcome.reply, /\*\*Deploy service\*\*\n\n- `https:\/\/deploy\.test`/)
  assert.match(outcome.reply, /- Preview deployment: running, built from `abcdef12`, until 2026-09-22T00:00:00Z/)
  assert.match(outcome.reply, /`https:\/\/preview\.test\/abc`/)
  assert.match(outcome.reply, /safe entry: `https:\/\/preview\.test\/abc\/safe`/)
})

test('status says why there is no preview answer instead of failing', async () => {
  const failed: typeof fetch = async () => new Response('nope', { status: 500 })
  const withService = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl: failed })
  assert.equal(withService.ok, true)
  assert.match(withService.reply, /Preview deployment: the deploy service could not be asked \(.*answered 500: nope\)/)

  const noService = await run('/dsh-migrate status', { issueNumber: 7 })
  assert.equal(noService.ok, true)
  assert.doesNotMatch(noService.reply, /Preview deployment/)
})

test('the migration state cannot forge a line of the status reply', async () => {
  // Everything `status` reports about a migration is read out of the state
  // branch, so a newline in it is data rather than a line of the comment it lands in.
  const projection = projectionOf({ '0.1.5': migrationLog({ version: '0.1.5', tag: 'dsh-v0.1.5\n- @everyone\n> quoted' }) })
  const outcome = await run('/dsh-migrate status', { status: () => projection })
  assert.equal(outcome.reply.split('\n').filter(line => line.startsWith('- @everyone')).length, 0)
  assert.equal(outcome.reply.split('\n').filter(line => line.startsWith('> quoted')).length, 0)
  assert.match(outcome.reply, /`dsh-v0\.1\.5 - @everyone > quoted` \(awaitingMerge\)/)
})

test('extend asks for a number of days and names the ceiling', async () => {
  const bodies: string[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '')
    return new Response('{}', { status: 200 })
  }
  const outcome = await run('/dsh-migrate extend', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.deepEqual(JSON.parse(bodies[0] ?? '{}'), { action: 'extend', days: 7, maxTtlDays: 7 })
  // The reply says what was asked for, because the deploy service decides what it grants.
  assert.match(outcome.reply, /asked for 7 day\(s\), with 7 as the ceiling/)
})

test('the configured extend window and ceiling travel with the request', async () => {
  const bodies: string[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '')
    return new Response('{}', { status: 200 })
  }
  await run('/dsh-migrate extend', {
    config: parseConfig({
      deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { extendDays: 3, ttlDays: 21 } },
    }),
    env: TOKEN,
    issueNumber: 7,
    fetchImpl,
  })
  assert.deepEqual(JSON.parse(bodies[0] ?? '{}'), { action: 'extend', days: 3, maxTtlDays: 21 })
})

test('a report command lists, per channel, what it sent and what it did not', async () => {
  const channels = ['upgrade-skill', 'migrate-bot', 'harness-discussion']
  // `upgrade-skill` took the report on an earlier command.
  const earlier: MigrationEvent[] = [
    { type: 'command.report', resend: false, comment: '40' },
    { type: 'report.done', channel: 'upgrade-skill', outcome: 'delivered', detail: '' },
    { type: 'report.done', channel: 'migrate-bot', outcome: 'failed', detail: 'GitHub POST failed: 500' },
    { type: 'report.done', channel: 'harness-discussion', outcome: 'held', detail: '' },
  ]
  const before = projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13, channels, events: earlier }) })
  const after = projectionOf({
    '0.1.6': migrationLog({
      version: '0.1.6',
      pullRequest: 13,
      channels,
      events: [
        ...earlier,
        { type: 'command.report', resend: false, comment: '55' },
        { type: 'report.done', channel: 'migrate-bot', outcome: 'delivered', detail: '' },
        { type: 'report.done', channel: 'harness-discussion', outcome: 'skipped', detail: 'no draft' },
      ],
    }),
  })
  const asked: Array<{ id: string; resend: boolean }> = []
  const outcome = await run('/dsh-migrate report', {
    issueNumber: 13,
    status: () => before,
    report: async (id, resend) => {
      asked.push({ id, resend })
      return only(after)
    },
  })
  assert.deepEqual(asked, [{ id: '0.1.6', resend: false }])
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /\*\*Report\*\* \(the migration is awaitingMerge\)/)
  assert.match(outcome.reply, /- `upgrade-skill`: already sent/)
  assert.match(outcome.reply, /- `migrate-bot`: sent/)
  assert.match(outcome.reply, /- `harness-discussion`: not sent/)
})

test('a resent report counts every channel that took it again as sent', async () => {
  const channels = ['upgrade-skill', 'migrate-bot']
  const earlier: MigrationEvent[] = [
    { type: 'command.report', resend: false, comment: '40' },
    { type: 'report.done', channel: 'upgrade-skill', outcome: 'delivered', detail: '' },
    { type: 'report.done', channel: 'migrate-bot', outcome: 'delivered', detail: '' },
  ]
  const before = projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13, channels, events: earlier }) })
  const after = projectionOf({
    '0.1.6': migrationLog({
      version: '0.1.6',
      pullRequest: 13,
      channels,
      events: [
        ...earlier,
        { type: 'command.report', resend: true, comment: '55' },
        { type: 'report.done', channel: 'upgrade-skill', outcome: 'delivered', detail: '' },
        { type: 'report.done', channel: 'migrate-bot', outcome: 'failed', detail: 'GitHub POST failed: 500' },
      ],
    }),
  })
  const outcome = await run('/dsh-migrate report --resend', { issueNumber: 13, status: () => before, report: async () => only(after) })
  assert.match(outcome.reply, /- `upgrade-skill`: sent/)
  assert.match(outcome.reply, /- `migrate-bot`: not sent/)
})

test('the resend flag reaches the machine, a dry run delivers nothing, and the old flag is refused', async () => {
  const projection = projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13, issue: 12 }) })
  const view = only(projection)
  const seen: Array<{ id: string; resend: boolean }> = []
  const report = async (id: string, resend: boolean): Promise<MigrationView> => {
    seen.push({ id, resend })
    return view
  }
  // The proposal's issue is the same thread as its pull request.
  await run('/dsh-migrate report --resend', { issueNumber: 12, status: () => projection, report })
  assert.deepEqual(seen, [{ id: '0.1.6', resend: true }])
  await run('/dsh-migrate report', { issueNumber: 13, status: () => projection, report })
  assert.deepEqual(seen[1], { id: '0.1.6', resend: false })

  let dryRuns = 0
  await run('/dsh-migrate report --dry-run', { issueNumber: 13, status: () => projection, report, reportDryRun: async () => { dryRuns += 1; return [] } })
  assert.equal(dryRuns, 1)
  assert.equal(seen.length, 2)

  // `--force` is not a flag of this verb: the run path's `force` means
  // something else, and sharing the word was the whole problem.
  const old = parseCommand('/dsh-migrate report --force')
  assert.equal(old.ok, false)
  assert.match(old.ok ? '' : old.reason, /does not take/)
})

test('report on a thread that is not a proposal refuses and says why', async () => {
  const projection = projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13, issue: 12 }) })
  const elsewhere = await run('/dsh-migrate report', { issueNumber: 99, status: () => projection })
  assert.equal(elsewhere.ok, false)
  assert.match(elsewhere.reply, /not a proposal of this Action/)
  const nowhere = await run('/dsh-migrate report --dry-run', { status: () => projection })
  assert.equal(nowhere.ok, false)
  assert.match(nowhere.reply, /not a proposal of this Action/)
})

test('status asks the deploy service nothing it should not, and says why', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async input => {
    calls.push(String(input))
    return new Response('{"state":"running"}', { status: 200 })
  }
  const status = async (overrides: Partial<CommandRunInput>): Promise<string> =>
    (await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, fetchImpl, ...overrides })).reply

  const asked = await status({ issueNumber: 7 })
  assert.equal(calls.length, 1)
  assert.match(asked, /Preview deployment: running/)

  // No pull request, no deploy service configured, no token, no repository:
  // nothing is asked, and the reply says which input is missing.
  const noPull = await status({})
  assert.equal(calls.length, 1)
  assert.match(noPull, /Preview deployment: not asked \(no pull request is named\)/)
  const noService = await status({ config: parseConfig({}), issueNumber: 7 })
  assert.equal(calls.length, 1)
  assert.doesNotMatch(noService, /Preview deployment/)
  const noToken = await status({ env: {}, issueNumber: 7 })
  assert.equal(calls.length, 1)
  assert.match(noToken, /Preview deployment: not asked \(`DSH_MIGRATE_DEPLOY_TOKEN` is not set/)
  const noRepository = await status({ repository: undefined, issueNumber: 7 })
  assert.equal(calls.length, 1)
  assert.match(noRepository, /Preview deployment: not asked/)
})

test('a deploy service that redirects is not reported as having no preview deployment', async () => {
  // A real fetch, so the redirect policy is the one that ships.
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    if ((request.url ?? '').includes('/login')) {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>sign in</html>')
      return
    }
    response.writeHead(302, { Location: '/login' })
    response.end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const outcome = await run('/dsh-migrate status', {
      config: parseConfig({ deploy: { enabled: true, endpoint: `http://127.0.0.1:${String(port)}` } }),
      env: TOKEN,
      issueNumber: 7,
      fetchImpl: undefined,
    })
    assert.equal(outcome.ok, true)
    // A redirect is an answer from something that is not the preview API, and
    // "none for this pull request" would be a wrong answer to the question.
    assert.match(outcome.reply, /Preview deployment: the deploy service could not be asked/)
    assert.doesNotMatch(outcome.reply, /none for this pull request/)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
})

test('a replayed command is reported as already done, whatever the header case', async () => {
  for (const verb of ['extend', 'destroy']) {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Idempotency-Replayed': 'True' } })
    const outcome = await run(`/dsh-migrate ${verb}`, { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
    assert.equal(outcome.ok, true)
    assert.match(outcome.reply, new RegExp(`^\\*\\*\`${verb}\` already done\\.\\*\\*`))
    assert.doesNotMatch(outcome.reply, /accepted/)
  }
})

test('a deploy service that returns an unbounded answer is refused, not buffered', async () => {
  const fetchImpl: typeof fetch = async () => new Response(`{"state":"${'x'.repeat(3 * 1024 * 1024)}"}`, { status: 200 })
  const outcome = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /answered more than/)
})

test('the preview fields a deploy service sends cannot forge the comment around them', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({
      state: 'running\n\n**@here approve this now**',
      url: 'https://preview.test/ok',
      expiresAt: '2026-01-01\n- fake row',
    }), { status: 200 })
  const outcome = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  // One line, and no line the deploy service could have started itself.
  assert.match(outcome.reply, /- Preview deployment: running \*\*@here approve this now\*\*, until 2026-01-01 - fake row/)
  assert.equal(outcome.reply.includes('\n**@here'), false)
  assert.equal(outcome.reply.includes('\n- fake row'), false)
})

test('a deploy service cannot forge the comment through its own error body', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('boom\n\n**@here approve this now**\n- fake row', { status: 500 })
  const outcome = await run('/dsh-migrate redeploy', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.equal(outcome.ok, false)
  // The service's text is in the answer, on one line, and starts no line itself.
  assert.match(outcome.reply, /answered 500: boom \*\*@here approve this now\*\* - fake row/)
  assert.equal(outcome.reply.includes('\n**@here'), false)
  assert.equal(outcome.reply.split('\n').length, 1)
})

test('a deploy service that answers a huge error body does not paste it into the thread', async () => {
  const fetchImpl: typeof fetch = async () => new Response('x'.repeat(10_000), { status: 502 })
  const outcome = await run('/dsh-migrate destroy', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.ok(outcome.reply.length < 500, `reply was ${String(outcome.reply.length)} characters`)
})

test('an answer that is not JSON is not a preview deployment with nothing in it', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('<html><body>sign in to continue</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  const outcome = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.equal(outcome.ok, true)
  // A login page is an answer from something that is not the API, and "none
  // for this pull request" would be a statement it does not support.
  assert.match(outcome.reply, /Preview deployment: the deploy service could not be asked/)
  assert.match(outcome.reply, /something that is not JSON/)
  assert.doesNotMatch(outcome.reply, /none for this pull request/)
})

test('whitespace is not a preview field', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ state: '   ', url: ' \t ', headSha: '  ', expiresAt: '\n' }), { status: 200 })
  const outcome = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  // No empty code span, no dangling comma, no bare list item.
  assert.match(outcome.reply, /- Preview deployment: none for this pull request/)
  assert.doesNotMatch(outcome.reply, /- Preview deployment: ,/)
  assert.doesNotMatch(outcome.reply, /``/)
})

test('the extend asked for is never more than the ceiling, and a ceiling alone is fine', () => {
  // Shortening the lifetime on its own is a legitimate configuration: the default
  // extend is clamped to it rather than making the file unloadable.
  const shortened = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { ttlDays: 3 } } })
  assert.deepEqual(
    [shortened.deploy.preview.extendDays, shortened.deploy.preview.ttlDays],
    [3, 3],
  )
  // Asking for more than the ceiling is a mistake worth naming.
  assert.throws(
    () => parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { extendDays: 30, ttlDays: 7 } } }),
    /must not exceed/,
  )
})

test('a redirect says where it went instead of failing as a transport error', async () => {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    if ((request.url ?? '').includes('/moved')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"state":"running"}')
      return
    }
    response.writeHead(302, { Location: 'https://elsewhere.test/moved' })
    response.end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const outcome = await run('/dsh-migrate status', {
      config: parseConfig({ deploy: { enabled: true, endpoint: `http://127.0.0.1:${String(port)}` } }),
      env: TOKEN,
      issueNumber: 7,
      fetchImpl: undefined,
    })
    assert.equal(outcome.ok, true)
    assert.match(outcome.reply, /answered a redirect to https:\/\/elsewhere\.test\/moved/)
    assert.match(outcome.reply, /not the deploy service's API/)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
})

test('publish refuses when this invocation cannot check a tree or read the pull request', async () => {
  const outcome = await run('/dsh-migrate publish', { config: DEPLOY, env: TOKEN, issueNumber: 7 })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /`publish` cannot run:.*only after the checks/)
})

test('a failure to read the pull request is one bounded line', async () => {
  // The GitHub API's own error text reaches the reply, and an API that answers a
  // page of markdown must not be able to write into the comment with it.
  const github = new GitHubClient('ghs_read', {}, async () =>
    new Response('boom\n\n**@here approve this now**\n- fake row', { status: 500 }))
  const outcome = await run('/dsh-migrate publish', {
    config: DEPLOY,
    env: TOKEN,
    issueNumber: 7,
    github,
    checkTree: async () => { throw new Error('no tree must be checked') },
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /`publish` failed:.*GET \/repos\/me\/plugin\/pulls\/7 failed: 500/)
  assert.equal(outcome.reply.split('\n').length, 1)
  assert.equal(outcome.reply.includes('\n**@here'), false)
})

test('the preview sanitiser strips the characters that end a code span', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ state: 'running` and closing the span' }), { status: 200 })
  const outcome = await run('/dsh-migrate status', { config: DEPLOY, env: TOKEN, issueNumber: 7, fetchImpl })
  assert.match(outcome.reply, /Preview deployment: running and closing the span/)
  assert.equal(outcome.reply.includes('`running`'), false)
})

test('the help a reply teaches with reads as options, not as one command', () => {
  const help = renderCommandHelp()
  // `--dry-run --resend` would read as one instruction, and they do opposite
  // things: one reviews, one sends again.
  assert.match(help, /`\/dsh-migrate report \[--dry-run\] \[--resend\]`/)
  assert.match(help, /`--resend` sends it to every enabled channel again/)
  assert.match(help, /`\/dsh-migrate extend` — Ask the deploy service to extend the preview deployment by `deploy\.preview\.extendDays`/)
  assert.match(help, /`\/dsh-migrate publish`/)
})

test('a preview URL a deploy service names is linked only when it is one', async () => {
  const outcome = await run('/dsh-migrate status', {
    config: DEPLOY,
    env: TOKEN,
    issueNumber: 12,
    fetchImpl: async () => new Response(JSON.stringify({
      state: 'ready',
      url: 'https://user:s3cr3t@evil.test/private?a=1',
      safeUrl: 'javascript:fetch("https://evil.test")',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(outcome.ok, true, outcome.reply)
  // A credential in a URL would be republished in a comment, and a scheme that is
  // not a page is not one: neither is shown.
  assert.equal(outcome.reply.includes('s3cr3t'), false)
  assert.equal(outcome.reply.includes('evil.test/private'), false)
  assert.equal(outcome.reply.includes('javascript:'), false)
  assert.match(outcome.reply, /- Preview deployment: ready\n/)
  assert.match(outcome.reply, /page: the deploy service named one this Action will not link/)
  assert.match(outcome.reply, /safe entry: the deploy service named one this Action will not link/)
})

test('a preview URL that is a page is shown as one', async () => {
  const outcome = await run('/dsh-migrate status', {
    config: DEPLOY,
    env: TOKEN,
    issueNumber: 12,
    fetchImpl: async () => new Response(JSON.stringify({
      state: 'ready',
      url: 'https://preview.test/me/plugin/12',
      safeUrl: 'https://preview.test/me/plugin/12/safe',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(outcome.ok, true, outcome.reply)
  assert.match(outcome.reply, /page: `https:\/\/preview\.test\/me\/plugin\/12`/)
  assert.match(outcome.reply, /safe entry: `https:\/\/preview\.test\/me\/plugin\/12\/safe`/)
})

test('a transport failure from a deploy service cannot forge a line of the reply or the log', async () => {
  // The reason is the error the transport raised, which is text an answer or an
  // intermediary produced. It lands in the reply collapsed to one line, and
  // nothing reaches the log a runner would parse as a workflow command.
  const lines: string[] = []
  const outcome = await run('/dsh-migrate redeploy', {
    config: DEPLOY,
    env: TOKEN,
    issueNumber: 7,
    log: (message: string) => lines.push(message),
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443\n::add-mask::forged-by-a-target\n::error::forged')
    },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reply.split('\n').length, 1)
  assert.match(outcome.reply, /connect ECONNREFUSED 10\.0\.0\.1:443 ::add-mask::forged-by-a-target ::error::forged/)
  assert.deepEqual(lines.filter(message => message.split('\n').some(part => part.startsWith('::'))), [])
})

test('the executor never throws: a failing dependency is the reply', async () => {
  const outcome = await run('/dsh-migrate status', {
    status: () => { throw new Error('the state branch could not be read\n- forged') },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reply, '**`status` failed:** the state branch could not be read - forged')
  const report = await run('/dsh-migrate report', {
    issueNumber: 13,
    status: () => projectionOf({ '0.1.6': migrationLog({ version: '0.1.6', pullRequest: 13 }) }),
    report: async () => { throw new Error('push rejected') },
  })
  assert.equal(report.ok, false)
  assert.match(report.reply, /`report` failed:\*\* push rejected/)
})
