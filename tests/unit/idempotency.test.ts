import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  commandKey,
  commandRecorded,
  mergeReportKey,
  parseCommandLedger,
  repeatReply,
  withCommandRecord,
  LEDGER_LIMIT,
  LEDGER_MAX_AGE_DAYS,
  MERGE_VERB,
} from '../../src/commands/idempotency.ts'
import { createDeployClient } from '../../src/deploy/client.ts'
import { COMMANDS, commandHasEffect } from '../../src/commands/table.ts'
import { parseCommand } from '../../src/commands/parse.ts'
import { runCommand } from '../../src/commands/run.ts'
import { parseConfig } from '../../src/config/load.ts'
import { applyRunToSeenState, applyPullRequestToSeenState, parseSeenState, serializeSeenState } from '../../src/watch/seen.ts'
import { resolveRepo } from '../../src/github/pr.ts'
import type { SeenState } from '../../src/watch/seen.ts'

const TARGET_CONFIG = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
const TARGET_ENV = { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' }

const IDENTITY = {
  repository: 'me/plugin',
  issueNumber: 7,
  verb: 'redeploy',
  flags: [] as string[],
}

test('the same delivery of the same comment produces the same key', () => {
  const first = commandKey({ ...IDENTITY, commentId: '42', runId: '1' })
  const again = commandKey({ ...IDENTITY, commentId: '42', runId: '2' })
  assert.equal(first, again)
  assert.match(first, /me\/plugin#7:redeploy:comment=42/)
})

test('a different comment, verb, pull request, or repository is a different command', () => {
  const base = commandKey({ ...IDENTITY, commentId: '42' })
  const keys = new Set([
    base,
    commandKey({ ...IDENTITY, commentId: '43' }),
    commandKey({ ...IDENTITY, commentId: '42', verb: 'destroy' }),
    commandKey({ ...IDENTITY, commentId: '42', issueNumber: 8 }),
    commandKey({ ...IDENTITY, commentId: '42', repository: 'me/other' }),
  ])
  assert.equal(keys.size, 5)
})

test('a flag order that the parser accepted differently is still one command', () => {
  assert.equal(
    commandKey({ ...IDENTITY, verb: 'feedback', flags: ['--dry-run', '--force'], commentId: '42' }),
    commandKey({ ...IDENTITY, verb: 'feedback', flags: ['--force', '--dry-run'], commentId: '42' }),
  )
})

test('without a comment the workflow run is the anchor, and a re-run is the same command', () => {
  const run = commandKey({ ...IDENTITY, runId: '900' })
  assert.match(run, /me\/plugin#7:redeploy:run=900/)
  // `GITHUB_RUN_ATTEMPT` is not part of the identity, so re-running a workflow
  // asks for the same command again rather than a second one.
  assert.equal(run, commandKey({ ...IDENTITY, runId: '900' }))
  // With neither, the command's own content is all there is to anchor to.
  assert.match(commandKey({ ...IDENTITY }), /me\/plugin#7:redeploy:flags=$/)
})

test('a command with no pull request is scoped by the repository alone', () => {
  assert.match(commandKey({ repository: 'me/plugin', verb: 'feedback', flags: [] }), /me\/plugin#-:feedback/)
})

test('an invalid ledger entry is dropped without discarding the rest', () => {
  const ledger = parseCommandLedger([
    { key: 'a', verb: 'redeploy', at: '2026-09-14T00:00:00Z' },
    { key: '', verb: 'redeploy' },
    { key: 'b' },
    'not a record',
    null,
    { key: 'c', verb: 'destroy' },
  ])
  assert.deepEqual(ledger.map(record => record.key), ['a', 'c'])
  assert.equal(ledger[1]?.at, '')
  assert.deepEqual(parseCommandLedger({ key: 'a' }), [])
  assert.deepEqual(parseCommandLedger(undefined), [])
})

test('the ledger keeps the newest records and stays bounded', () => {
  let ledger = parseCommandLedger([])
  const now = new Date()
  for (let index = 0; index < LEDGER_LIMIT + 10; index += 1) {
    ledger = withCommandRecord(ledger, { key: `k${String(index)}`, verb: 'redeploy', at: now.toISOString() }, now)
  }
  assert.equal(ledger.length, LEDGER_LIMIT)
  assert.equal(ledger[0]?.key, 'k10')
  assert.equal(ledger.at(-1)?.key, `k${String(LEDGER_LIMIT + 9)}`)
})

test('recording the same key twice does not grow the ledger', () => {
  const once = withCommandRecord([], {
    key: 'k',
    verb: 'redeploy',
    at: '2026-09-14T00:00:00.000Z',
  })
  const twice = withCommandRecord(once, {
    key: 'k',
    verb: 'redeploy',
    at: '2026-09-14T01:00:00.000Z',
  })
  assert.equal(twice.length, 1)
  assert.equal(twice[0]?.at, '2026-09-14T01:00:00.000Z')
  assert.equal(commandRecorded(twice, 'k')?.verb, 'redeploy')
  assert.equal(commandRecorded(twice, 'other'), undefined)
})

test('the channels a merge reached accumulate instead of being replaced', () => {
  const first = withCommandRecord([], {
    key: 'me/plugin#12:feedback:merge',
    verb: 'feedback (merge)',
    at: '2026-09-14T00:00:00.000Z',
    channels: ['migrate-bot'],
  })
  // The second report reached the channel that was missing the first time.
  const second = withCommandRecord(first, {
    key: 'me/plugin#12:feedback:merge',
    verb: 'feedback (merge)',
    at: '2026-09-14T01:00:00.000Z',
    channels: ['harness-discussion'],
  })
  assert.equal(second.length, 1)
  assert.deepEqual(second[0]?.channels, ['migrate-bot', 'harness-discussion'])
  assert.equal(second[0]?.at, '2026-09-14T01:00:00.000Z')
  // A record from a build that did not know about channels parses and keeps them.
  assert.deepEqual(parseCommandLedger(second)[0]?.channels, ['migrate-bot', 'harness-discussion'])
  assert.deepEqual(parseCommandLedger([{ key: 'k', verb: 'v', at: '', channels: ['a', 3, ''] }])[0]?.channels, ['a'])
})

test('command traffic cannot push a merge report out of the ledger', () => {
  const now = new Date('2026-09-14T00:00:00Z')
  const at = now.toISOString()
  let ledger = withCommandRecord([], {
    key: 'me/plugin#12:feedback:merge',
    verb: MERGE_VERB,
    at,
    channels: ['migrate-bot'],
  })
  for (let index = 0; index < LEDGER_LIMIT + 50; index += 1) {
    ledger = withCommandRecord(ledger, { key: `k${String(index)}`, verb: 'redeploy', at }, now)
  }
  // The merge report answers a question no command record can answer, so it is
  // bounded apart from them.
  assert.equal(commandRecorded(ledger, 'me/plugin#12:feedback:merge')?.channels?.[0], 'migrate-bot')
  assert.equal(ledger.filter(record => record.verb !== MERGE_VERB).length, LEDGER_LIMIT)
})

test('a record ages out, so the ledger cannot be evicted by unrelated traffic', () => {
  const now = new Date('2026-09-14T00:00:00Z')
  const old = new Date(now.getTime() - (LEDGER_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString()
  let ledger = withCommandRecord([], { key: 'ancient', verb: 'feedback', at: old }, now)
  // Far more newer commands than the ledger holds: the age bound is what keeps
  // a record that is still deliverable from being pushed out by traffic.
  for (let index = 0; index < LEDGER_LIMIT + 5; index += 1) {
    ledger = withCommandRecord(ledger, { key: `k${String(index)}`, verb: 'redeploy', at: now.toISOString() }, now)
  }
  assert.equal(ledger.some(record => record.key === 'ancient'), false)
  assert.equal(ledger.length, LEDGER_LIMIT)
  const fresh = withCommandRecord([], { key: 'recent', verb: 'feedback', at: now.toISOString() }, now)
  assert.equal(commandRecorded(fresh, 'recent')?.key, 'recent')
})

test('a merge report is keyed by the merge, not by the delivery that noticed it', () => {
  assert.equal(mergeReportKey('me/plugin', 12), 'me/plugin#12:feedback:merge')
  // The same merge twice is one key, and a different pull request is another.
  assert.equal(mergeReportKey('me/plugin', 12), mergeReportKey('me/plugin', 12))
  assert.notEqual(mergeReportKey('me/plugin', 12), mergeReportKey('me/plugin', 13))
  assert.notEqual(mergeReportKey('me/plugin', 12), mergeReportKey('me/other', 12))
})

test('a repeat answers with what happened rather than doing it again', () => {
  const reply = repeatReply({ key: 'k', verb: 'redeploy', at: '2026-09-14T00:00:00.000Z' })
  assert.doesNotMatch(reply, /It reached/)
  // When the record knows what a repeat reached, the answer says so.
  assert.match(
    repeatReply({ key: 'k', verb: 'feedback', at: '2026-09-14T00:00:00.000Z', channels: ['migrate-bot'] }),
    /It reached migrate-bot\./,
  )
  assert.match(reply, /`redeploy` already ran/)
  assert.match(reply, /2026-09-14T00:00:00\.000Z/)
  assert.match(reply, /post a new comment/)
})

test('a record read back out of the state file cannot forge a line of the reply', () => {
  // The ledger is a file on a branch, so its text is data: a newline in a verb,
  // a time, or a channel name must not become a line of its own in a comment.
  const reply = repeatReply({
    key: 'me/plugin#7:redeploy:comment=42',
    verb: 'redeploy\n- @everyone approved',
    at: '2026-09-14T00:00:00.000Z\n> quoted',
    channels: ['migrate-bot\n- forged'],
  })
  assert.equal(reply.split('\n').filter(line => line.startsWith('- ')).length, 0)
  assert.equal(reply.split('\n').filter(line => line.startsWith('> ')).length, 0)
  assert.match(reply, /redeploy - @everyone approved/)
  assert.match(reply, /It reached migrate-bot - forged\./)
})

test('the ledger survives a round trip through the state file', () => {
  const state = {
    tag: 'dsh-v0.1.5-rc.1',
    version: '0.1.5-rc.1',
    recordedAt: '2026-09-14T00:00:00Z',
    commands: withCommandRecord([], {
      key: 'me/plugin#7:redeploy:comment=42',
      verb: 'redeploy',
      at: new Date().toISOString(),
    }),
  }
  const parsed = parseSeenState(serializeSeenState(state))
  assert.deepEqual(parsed?.commands, state.commands)
})

test('a watch run replaces the cursor without erasing what has been answered', () => {
  const previous = {
    tag: 'dsh-v0.1.5-rc.1',
    version: '0.1.5-rc.1',
    recordedAt: '2026-09-14T00:00:00Z',
    commands: withCommandRecord([], { key: 'k', verb: 'redeploy', at: new Date().toISOString() }),
  }
  const next = applyRunToSeenState(previous, {
    target: { tag: 'dsh-v0.1.6', version: '0.1.6' },
    status: 'compatible',
  })
  assert.equal(next?.tag, 'dsh-v0.1.6')
  assert.equal(next?.commands?.length, 1)
  // The same is true of the merge that promotes a pending row.
  const merged = applyPullRequestToSeenState({ ...next, pending: { tag: 'dsh-v0.1.6', version: '0.1.6', pr: 12 } }, 'merged')
  assert.equal(merged.commands?.length, 1)
})

test('every verb declares whether a repeat has to be suppressed', () => {
  assert.deepEqual(
    COMMANDS.map(spec => [spec.verb, spec.effectful]),
    [
      ['status', 'never'],
      ['feedback', 'unless-dry-run'],
      ['redeploy', 'always'],
      ['destroy', 'always'],
      ['extend', 'always'],
      ['publish', 'always'],
    ],
  )
  const status = COMMANDS.find(spec => spec.verb === 'status')
  const feedback = COMMANDS.find(spec => spec.verb === 'feedback')
  const redeploy = COMMANDS.find(spec => spec.verb === 'redeploy')
  assert.equal(commandHasEffect(status as never, []), false)
  assert.equal(commandHasEffect(feedback as never, []), true)
  assert.equal(commandHasEffect(feedback as never, ['--dry-run']), false)
  assert.equal(commandHasEffect(redeploy as never, []), true)
})

test('a repeated command reaches nothing and says so', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async input => {
    calls.push(String(input))
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const parsed = parseCommand('/dsh-migrate redeploy')
  // The key the executor derives: the repository comes from the checkout, not
  // from anything a comment says.
  const repo = resolveRepo(process.cwd())
  const key = commandKey({
    repository: `${repo.owner}/${repo.repo}`,
    issueNumber: 7,
    verb: 'redeploy',
    flags: [],
    commentId: '42',
  })
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: TARGET_CONFIG,
    env: TARGET_ENV,
    workdir: process.cwd(),
    pullRequest: 7,
    commentId: '42',
    seen: {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      commands: [{ key, verb: 'redeploy', at: '2026-09-14T00:00:00.000Z' }],
    },
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(calls, [])
  assert.match(outcome.reply, /already ran/)
  assert.equal(outcome.record, undefined)
})

test('a preview verb is keyed by the pull request it acts on, not by the recorded one', async () => {
  const lines: string[] = []
  const parsed = parseCommand('/dsh-migrate extend')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: TARGET_CONFIG,
    env: TARGET_ENV,
    workdir: process.cwd(),
    commentId: '42',
    // A migrate pull request is recorded, but this verb acts on a preview and
    // names none, so it is refused — and its key must agree with that refusal
    // rather than quietly naming a pull request it never touched.
    seen: {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      pending: { tag: 'dsh-v0.1.6', version: '0.1.6', pr: 12 },
    },
    log: (message: string) => lines.push(message),
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /no pull request number was given/)
  assert.match(lines.join('\n'), /#-:extend:comment=42/)
})

test('a scheduled run opening the next pull request does not re-key the same comment', async () => {
  // The defect this replaces: the key folded in `seen.pending.pr`, so a watch run
  // opening the next migrate pull request gave the same comment a second key and
  // its redelivery ran every channel again.
  const keys: string[] = []
  const stages: string[] = []
  const run = async (seen: SeenState): Promise<void> => {
    const parsed = parseCommand('/dsh-migrate feedback')
    const lines: string[] = []
    await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({}),
      env: { GITHUB_REPOSITORY: 'me/plugin' },
      workdir: process.cwd(),
      commentId: '42',
      seen,
      log: (message: string) => lines.push(message),
      feedback: async () => {
        stages.push('feedback')
        return { ran: true, outcomes: [] }
      },
    })
    keys.push(...lines.filter(line => line.includes('idempotency key')))
  }
  const base: SeenState = { tag: 'dsh-v0.1.5', version: '0.1.5', recordedAt: '2026-09-14T00:00:00Z' }
  await run(base)
  await run({ ...base, pending: { tag: 'dsh-v0.1.6', version: '0.1.6', pr: 13 } })
  assert.equal(keys.length, 2)
  assert.match(keys[0] ?? '', /me\/plugin#-:feedback:comment=42/)
  assert.equal(keys[0]?.replace('idempotency key ', ''), keys[1]?.replace('idempotency key ', ''))
  assert.equal(stages.length, 2)
})

test('the repository comes from the environment, so a git failure cannot re-key a command', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const parsed = parseCommand('/dsh-migrate redeploy')
  const command = parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never
  const noRepo = mkdtempSync(join(tmpdir(), 'dsh-mig-idem-norepo-'))
  const keys: string[] = []
  const runAt = async (workdir: string): Promise<void> => {
    const lines: string[] = []
    await runCommand({
      command,
      config: TARGET_CONFIG,
      env: { ...TARGET_ENV, GITHUB_REPOSITORY: 'me/plugin' },
      workdir,
      pullRequest: 7,
      commentId: '42',
      log: (message: string) => lines.push(message),
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    keys.push(...lines.filter(line => line.includes('idempotency key')).map(line => line.split('idempotency key ')[1] ?? ''))
  }
  try {
    await runAt(noRepo)
    await runAt(process.cwd())
    assert.deepEqual(keys, ['me/plugin#7:redeploy:comment=42', 'me/plugin#7:redeploy:comment=42'])
  } finally {
    rmSync(noRepo, { recursive: true, force: true })
  }
})

test('an effectful success is handed back to be recorded, with the key that was sent', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  const parsed = parseCommand('/dsh-migrate extend')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: TARGET_CONFIG,
    env: TARGET_ENV,
    workdir: process.cwd(),
    pullRequest: 7,
    commentId: '42',
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.record?.verb, 'extend')
  assert.match(outcome.record?.key ?? '', /comment=42$/)
})

test('a feedback command that reached nobody is not recorded, so a retry retries it', async () => {
  const parsed = parseCommand('/dsh-migrate feedback')
  const run = async (status: 'delivered' | 'failed'): Promise<ReturnType<typeof runCommand>> =>
    await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({}),
      env: {},
      workdir: process.cwd(),
      commentId: '42',
      log: () => {},
      feedback: async () => ({
        ran: true,
        outcomes: [status === 'delivered'
          ? { channel: 'migrate-bot', status: 'delivered' as const, method: 'issue' as const }
          : { channel: 'migrate-bot', status: 'failed' as const, reason: 'GitHub POST failed: 500' }],
      }),
    })
  const failed = await run('failed')
  assert.equal(failed.ok, true)
  assert.equal(failed.record, undefined)
  const sent = await run('delivered')
  assert.equal(sent.ok, true)
  assert.equal(sent.record?.verb, 'feedback')
})

test('a command that failed stays retryable, and a read-only one is never recorded', async () => {
  const failing: typeof fetch = async () => new Response('boom', { status: 500 })
  const parsed = parseCommand('/dsh-migrate destroy')
  const failed = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: TARGET_CONFIG,
    env: TARGET_ENV,
    workdir: process.cwd(),
    pullRequest: 7,
    commentId: '42',
    log: () => {},
    fetchImpl: failing,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.record, undefined)

  const status = parseCommand('/dsh-migrate status')
  const read = await runCommand({
    command: status.ok ? status.command : (() => { throw new Error('parse') })() as never,
    config: TARGET_CONFIG,
    env: TARGET_ENV,
    workdir: process.cwd(),
    pullRequest: 7,
    commentId: '42',
    log: () => {},
  })
  assert.equal(read.ok, true)
  assert.equal(read.record, undefined)

  const dry = parseCommand('/dsh-migrate feedback --dry-run')
  const dryRun = await runCommand({
    command: dry.ok ? dry.command : (() => { throw new Error('parse') })() as never,
    config: TARGET_CONFIG,
    env: TARGET_ENV,
    workdir: process.cwd(),
    pullRequest: 7,
    commentId: '42',
    log: () => {},
    feedback: async () => ({ ran: true, outcomes: [] }),
  })
  assert.equal(dryRun.record, undefined)
})

test('the key rides on mutations and never on a read', async () => {
  const seen: Array<{ method: string; key: string | null }> = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    seen.push({ method: init?.method ?? 'GET', key: headers.get('Idempotency-Key') })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const client = createDeployClient({ endpoint: 'https://deploy.test', token: 'secret' }, fetchImpl, 'k1')
  const key = { repository: 'me/plugin', pullRequest: 7 }
  await client.redeploy(key)
  await client.destroy(key)
  await client.extend(key, { days: 7, maxTtlDays: 30 })
  await client.publish(key)
  await client.status(key)
  assert.equal(seen.length, 5)
  assert.equal(seen.at(-1)?.method, 'GET')
  assert.equal(seen.at(-1)?.key, null)
  assert.deepEqual(seen.slice(0, 4).map(call => call.key), ['k1', 'k1', 'k1', 'k1'])
})

test('a target that answers from the key is reported as already done', async () => {
  // `True` is the same header: HTTP header values are case-insensitive, and a
  // target that replays must not be reported as a second rebuild.
  const replayed: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Idempotency-Replayed': 'True' } })
  const parsed = parseCommand('/dsh-migrate redeploy')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: TARGET_CONFIG,
    env: TARGET_ENV,
    workdir: process.cwd(),
    pullRequest: 7,
    commentId: '42',
    log: () => {},
    fetchImpl: replayed,
  })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /already done/)
  assert.match(outcome.reply, /instead of doing the work again/)
})

/**
 * The whole point of the ledger is what an operator sees when a webhook is
 * delivered twice, so this drives the real CLI against a real target and a real
 * repository rather than the pieces it is assembled from.
 */
test('the CLI records an effectful command and suppresses its redelivery', async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn, spawnSync } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const { badgeFromSeenState } = await import('../../src/watch/badge.ts')
  const { persistStateBranch, STATE_BRANCH, STATE_FILE } = await import('../../src/watch/seen.ts')
  type SeenState = import('../../src/watch/seen.ts').SeenState

  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-idem-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-mig-idem-work-'))
  const requests: Array<{ method: string; key: string | null }> = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', key: request.headers['idempotency-key'] as string | null })
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  // Asynchronous on purpose: the fixture target is an HTTP server in this very
  // process, and a synchronous spawn would block the event loop that has to
  // answer the command's request.
  const run = async (
    commentId: string | undefined,
    runId?: string,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> => {
    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'command',
      '--workdir', work,
      '--config', '.github/dsh-migrate.yml',
      '--comment-body', '/dsh-migrate redeploy',
      ...(commentId === undefined ? [] : ['--comment-id', commentId]),
      '--comment-author', 'me',
      '--comment-author-association', 'OWNER',
      '--issue-number', '7',
      '--pull-request', '7',
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DSH_MIGRATE_DEPLOY_TOKEN: 'secret',
        // The repository identity a real run reads from GitHub's environment,
        // so the fixture's `origin` can stay a local bare repository.
        GITHUB_REPOSITORY: 'me/plugin',
        // No GITHUB_TOKEN: the reply lands in the log instead of on a thread,
        // which is what keeps this test off the network.
        ...(runId === undefined ? {} : { GITHUB_RUN_ID: runId }),
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    return await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', status => { resolve({ status, stdout, stderr }) })
    })
  }

  try {
    const git = (args: string[]): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], {
        cwd: work,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
    }
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    git(['init'])
    git(['config', 'user.name', 'test'])
    git(['config', 'user.email', 'test@example.test'])
    mkdirSync(join(work, '.github'), { recursive: true })
    writeFileSync(
      join(work, '.github/dsh-migrate.yml'),
      `deploy:\n  enabled: true\n  endpoint: http://127.0.0.1:${String(port)}\n`,
    )
    writeFileSync(join(work, 'plugin.js'), 'export {}\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    git(['remote', 'add', 'origin', bare])
    git(['push', '-u', 'origin', 'HEAD:master'])

    // With no state branch there is nowhere to remember anything, so the command
    // still runs and the answer says the guarantee is absent rather than
    // implying one that is not there.
    const unrecorded = await run('54')
    assert.equal(unrecorded.status, 0, unrecorded.stderr)
    assert.match(unrecorded.stdout, /`redeploy` accepted/)
    assert.match(unrecorded.stdout, /was not recorded on `dsh-migrate\/state` \(no-state\)/)

    const state: SeenState = { tag: 'dsh-v0.1.5', version: '0.1.5', recordedAt: '2026-09-14T00:00:00Z' }
    const seeded = persistStateBranch(work, { seen: state, badge: badgeFromSeenState(state) })
    assert.equal(seeded.ok, true, seeded.ok ? '' : seeded.detail)

    const first = await run('55')
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /`redeploy` accepted/)
    assert.equal(first.stdout.includes('was not recorded'), false)
    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.method, 'POST')
    assert.equal(requests[1]?.key, 'me/plugin#7:redeploy:comment=55')

    const stored = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    assert.equal(stored.status, 0, stored.stderr)
    const ledger = parseSeenState(stored.stdout)?.commands ?? []
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0]?.key, 'me/plugin#7:redeploy:comment=55')

    // The webhook is delivered again: the same comment is the same command, so
    // the target is not asked twice.
    const second = await run('55')
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /`redeploy` already ran/)
    assert.equal(requests.length, 2)

    // A new comment is a new instruction, and it reaches the target.
    const third = await run('56')
    assert.equal(third.status, 0, third.stderr)
    assert.equal(requests.length, 3)
    assert.equal(requests[2]?.key, 'me/plugin#7:redeploy:comment=56')

    // A consumer that maps no comment id still gets one delivery per command:
    // the workflow run is the anchor, and re-running that workflow is the same
    // command delivered again rather than a second one.
    const byRun = await run(undefined, '900')
    assert.equal(byRun.status, 0, byRun.stderr)
    assert.equal(requests.length, 4)
    assert.equal(requests[3]?.key, 'me/plugin#7:redeploy:run=900:flags=')
    const reRun = await run(undefined, '900')
    assert.equal(reRun.status, 0, reRun.stderr)
    assert.match(reRun.stdout, /already ran/)
    assert.equal(requests.length, 4)

    const reloaded = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    const stored2 = parseSeenState(reloaded.stdout)
    assert.equal(stored2?.commands?.length, 3)
    // Recording a command must not disturb what the state branch already held.
    assert.equal(stored2?.tag, 'dsh-v0.1.5')

    const badge = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:badge.json`], { encoding: 'utf8' })
    assert.equal(badge.status, 0, badge.stderr)
    assert.match(badge.stdout, /"unverified"|"dsh"/)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

/** A bare repository with a work checkout whose `origin` is that bare repository. */
async function scratchRepo(prefix: string): Promise<{ bare: string; work: string; git: (args: string[]) => void }> {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const bare = mkdtempSync(join(tmpdir(), `${prefix}-bare-`))
  const work = mkdtempSync(join(tmpdir(), `${prefix}-work-`))
  const git = (args: string[]): void => {
    const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], {
      cwd: work,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
  }
  spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
  git(['init'])
  git(['config', 'user.name', 'test'])
  git(['config', 'user.email', 'test@example.test'])
  writeFileSync(join(work, 'plugin.js'), 'export {}\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])
  git(['remote', 'add', 'origin', bare])
  git(['push', '-u', 'origin', 'HEAD:master'])
  return { bare, work, git }
}

test('a command keeps a concurrent run of the watch, and records itself too', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const { badgeFromSeenState } = await import('../../src/watch/badge.ts')
  const { persistStateBranch, STATE_BRANCH, STATE_FILE } = await import('../../src/watch/seen.ts')

  const { bare, work, git } = await scratchRepo('dsh-mig-conc')
  const server = createServer((request, response) => {
    request.resume()
    // The concurrent writer: a scheduled run finishing while this command is in
    // flight. It advances the cursor, verifies a tag, and records a command of
    // its own — none of which this command may throw away.
    const concurrent: SeenState = {
      tag: 'dsh-v0.1.6',
      version: '0.1.6',
      recordedAt: '2026-09-14T02:00:00Z',
      verified: { tag: 'dsh-v0.1.6', version: '0.1.6' },
      commands: [{ key: 'me/plugin#7:redeploy:comment=99', verb: 'redeploy', at: '2026-09-14T02:00:00.000Z' }],
    }
    persistStateBranch(work, { seen: concurrent, badge: badgeFromSeenState(concurrent) })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    mkdirSync(join(work, '.github'), { recursive: true })
    writeFileSync(
      join(work, '.github/dsh-migrate.yml'),
      `deploy:\n  enabled: true\n  endpoint: http://127.0.0.1:${String(port)}\n`,
    )
    git(['add', '.'])
    git(['commit', '-m', 'config'])
    const seeded: SeenState = { tag: 'dsh-v0.1.5', version: '0.1.5', recordedAt: '2026-09-14T00:00:00Z' }
    assert.equal(persistStateBranch(work, { seen: seeded, badge: badgeFromSeenState(seeded) }).ok, true)

    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'command',
      '--workdir', work,
      '--config', '.github/dsh-migrate.yml',
      '--comment-body', '/dsh-migrate redeploy',
      '--comment-id', '77',
      '--comment-author', 'me',
      '--comment-author-association', 'OWNER',
      '--issue-number', '7',
      '--pull-request', '7',
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DSH_MIGRATE_DEPLOY_TOKEN: 'secret',
        GITHUB_REPOSITORY: 'me/plugin',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const status = await new Promise<number | null>(resolve => { child.on('close', code => { resolve(code) }) })
    assert.equal(status, 0, stderr)
    assert.match(stdout, /accepted/)
    assert.doesNotMatch(stdout, /could not record/)

    const branch = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    const after = parseSeenState(branch.stdout)
    assert.equal(after?.tag, 'dsh-v0.1.6', 'the concurrent watch cursor must survive the command')
    assert.deepEqual(after?.verified, { tag: 'dsh-v0.1.6', version: '0.1.6' })
    assert.notEqual(commandRecorded(after?.commands ?? [], 'me/plugin#7:redeploy:comment=99'), undefined)
    assert.notEqual(commandRecorded(after?.commands ?? [], 'me/plugin#7:redeploy:comment=77'), undefined)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    rmSync(work, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

test('writing the badge says what an unreadable seen.json costs', async () => {
  const { rmSync } = await import('node:fs')
  const { spawn, spawnSync } = await import('node:child_process')
  const { badgeFromSeenState } = await import('../../src/watch/badge.ts')
  const { STATE_BRANCH, STATE_FILE } = await import('../../src/watch/seen.ts')

  const { bare, work } = await scratchRepo('dsh-mig-bad')
  try {
    // A state branch whose seen.json this build cannot read as state.
    const unreadable = '{"bad":true,"commands":[{"key":"me/plugin#7:redeploy:comment=9","verb":"redeploy","at":"2026-09-14T00:00:00.000Z"}]}\n'
    const objects = (content: string): string => {
      const result = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, input: content, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const tree = spawnSync('git', ['mktree'], {
      cwd: work,
      encoding: 'utf8',
      input: [
        `100644 blob ${objects(`${JSON.stringify(badgeFromSeenState(undefined), null, 2)}\n`)}\tbadge.json`,
        `100644 blob ${objects(unreadable)}\t${STATE_FILE}`,
        '',
      ].join('\n'),
    })
    assert.equal(tree.status, 0, tree.stderr)
    const commit = spawnSync('git', ['commit-tree', tree.stdout.trim(), '-m', 'seed'], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@e.test',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@e.test',
      },
    })
    assert.equal(commit.status, 0, commit.stderr)
    const pushed = spawnSync('git', ['push', 'origin', `${commit.stdout.trim()}:refs/heads/${STATE_BRANCH}`], {
      cwd: work,
      encoding: 'utf8',
    })
    assert.equal(pushed.status, 0, pushed.stderr)

    const child = spawn(process.execPath, ['dist/src/cli.js', 'refresh-badge', '--workdir', work], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_REPOSITORY: 'me/plugin' },
    })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    const status = await new Promise<number | null>(resolve => { child.on('close', code => { resolve(code) }) })
    assert.equal(status, 0)
    // The ledger is gone, and the run says so rather than leaving a maintainer to
    // wonder why every command started running twice.
    assert.match(stdout, /could not be read as state/)
    assert.match(stdout, /1 command record\(s\)/)
    const shown = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    assert.notEqual(shown.status, 0, 'the unreadable seen.json is replaced by the badge-only tree')
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

test('a record write that loses a race is retried instead of dropped', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn, spawnSync } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const { badgeFromSeenState } = await import('../../src/watch/badge.ts')
  const { persistStateBranch, STATE_BRANCH, STATE_FILE } = await import('../../src/watch/seen.ts')

  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-retry-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-mig-retry-work-'))
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`)
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    const git = (args: string[], cwd = work): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`)
    }
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    git(['init'])
    git(['config', 'user.name', 'test'])
    git(['config', 'user.email', 'test@example.test'])
    mkdirSync(join(work, '.github'), { recursive: true })
    writeFileSync(
      join(work, '.github/dsh-migrate.yml'),
      `deploy:\n  enabled: true\n  endpoint: http://127.0.0.1:${String(port)}\n`,
    )
    writeFileSync(join(work, 'plugin.js'), 'export {}\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    git(['remote', 'add', 'origin', bare])
    git(['push', '-u', 'origin', 'HEAD:master'])

    const state: SeenState = { tag: 'dsh-v0.1.5', version: '0.1.5', recordedAt: '2026-09-14T00:00:00Z' }
    assert.equal(persistStateBranch(work, { seen: state, badge: badgeFromSeenState(state) }).ok, true)

    // The first push to the state branch is rejected the way a lost race is: the
    // remote refuses it because it moved. A retry that re-reads the tip succeeds.
    const hook = join(bare, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\nif [ ! -f "$(dirname "$0")/../.rejected" ]; then touch "$(dirname "$0")/../.rejected"; echo "non-fast-forward" >&2; exit 1; fi\nexit 0\n')
    chmodSync(hook, 0o755)

    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'command',
      '--workdir', work,
      '--config', '.github/dsh-migrate.yml',
      '--comment-body', '/dsh-migrate redeploy',
      '--comment-id', '77',
      '--comment-author', 'me',
      '--comment-author-association', 'OWNER',
      '--issue-number', '7',
      '--pull-request', '7',
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DSH_MIGRATE_DEPLOY_TOKEN: 'secret',
        GITHUB_REPOSITORY: 'me/plugin',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const status = await new Promise<number | null>(resolve => { child.on('close', code => { resolve(code) }) })
    assert.equal(status, 0, stderr)
    assert.match(stdout, /`redeploy` accepted/)
    // The retry is what makes this recorded: one rejection, then the write lands.
    assert.doesNotMatch(stdout, /could not record/)
    assert.match(stdout, /moved under this write; retrying/)

    const branch = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${STATE_FILE}`], { encoding: 'utf8' })
    const after = parseSeenState(branch.stdout)
    assert.notEqual(commandRecorded(after?.commands ?? [], 'me/plugin#7:redeploy:comment=77'), undefined)
    assert.equal(after?.tag, 'dsh-v0.1.5', 'the retry kept what the branch already held')
    assert.equal(requests.length, 1)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('the repeat of a command is reported as an output a workflow can read', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn, spawnSync } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const { badgeFromSeenState } = await import('../../src/watch/badge.ts')
  const { persistStateBranch } = await import('../../src/watch/seen.ts')

  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-out-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-mig-out-work-'))
  const output = join(work, 'github-output.txt')
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const runBody = async (body: string, commentId: string): Promise<string> => {
    writeFileSync(output, '')
    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'command',
      '--workdir', work,
      '--config', '.github/dsh-migrate.yml',
      '--comment-body', body,
      '--comment-id', commentId,
      '--comment-author', 'me',
      '--comment-author-association', 'OWNER',
      '--issue-number', '7',
      '--pull-request', '7',
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DSH_MIGRATE_DEPLOY_TOKEN: 'secret',
        GITHUB_REPOSITORY: 'me/plugin',
        GITHUB_OUTPUT: output,
      },
    })
    child.stdout.resume()
    child.stderr.resume()
    await new Promise<void>(resolve => { child.on('close', () => { resolve() }) })
    return readFileSync(output, 'utf8')
  }
  const run = async (commentId: string): Promise<string> => await runBody('/dsh-migrate redeploy', commentId)

  try {
    const git = (args: string[]): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    git(['init'])
    git(['config', 'user.name', 'test'])
    git(['config', 'user.email', 'test@example.test'])
    mkdirSync(join(work, '.github'), { recursive: true })
    writeFileSync(join(work, '.github/dsh-migrate.yml'), `deploy:\n  enabled: true\n  endpoint: http://127.0.0.1:${String(port)}\n`)
    writeFileSync(join(work, 'plugin.js'), 'export {}\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    git(['remote', 'add', 'origin', bare])
    git(['push', '-u', 'origin', 'HEAD:master'])
    const state: SeenState = { tag: 'dsh-v0.1.5', version: '0.1.5', recordedAt: '2026-09-14T00:00:00Z' }
    assert.equal(persistStateBranch(work, { seen: state, badge: badgeFromSeenState(state) }).ok, true)

    const first = await run('55')
    assert.match(first, /command_repeat=false/)
    assert.match(first, /command_reply=/)
    const second = await run('55')
    assert.match(second, /command_repeat=true/)

    // Every path that answers writes both outputs, and a read-only verb or a
    // refusal is never reported as a repeat.
    const readOnly = await runBody('/dsh-migrate status', '56')
    assert.match(readOnly, /command_repeat=false/)
    // A multi-line reply is written as a heredoc, which is still one output.
    assert.match(readOnly, /command_reply(=|<<MIGRATE_EOF_)/)
    const refused = await runBody('/dsh-migrate teleport', '57')
    assert.match(refused, /command_repeat=false/)
    assert.match(refused, /not a command/)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('asking for a second pull request also gets past the unchanged-version gate', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const { badgeFromSeenState } = await import('../../src/watch/badge.ts')
  const { persistStateBranch } = await import('../../src/watch/seen.ts')

  const { bare, work, git } = await scratchRepo('dsh-mig-second')
  const run = async (extra: string[]): Promise<string> => {
    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'run',
      '--workdir', work,
      '--dsh-version', '0.1.5',
      '--skip-github',
      ...extra,
    ], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_REPOSITORY: 'me/plugin' },
    })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.resume()
    await new Promise<void>(resolve => { child.on('close', () => { resolve() }) })
    return stdout
  }
  try {
    writeFileSync(join(work, '.github-migrate-test'), 'x\n')
    git(['add', '-A'])
    git(['commit', '-m', 'state'])
    const state: SeenState = {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      pending: { tag: 'dsh-v0.1.5', version: '0.1.5', pr: 12 },
    }
    assert.equal(persistStateBranch(work, { seen: state, badge: badgeFromSeenState(state) }).ok, true)

    // The recorded version is the one being asked for, and a migrate pull request
    // is open: the unchanged gate would stop a plain run, so the override has to
    // get past it — otherwise it could never be reached at all.
    const plain = await run([])
    assert.match(plain, /dsh unchanged .*skip/)
    const second = await run(['--allow-second-pr'])
    assert.match(second, /forced run, processing dsh-v0\.1\.5/)
    assert.match(second, /migrate pull request #12 is still open; --allow-second-pr runs anyway/)
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

test('a badge write that loses a race is retried, like a command record', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn, spawnSync } = await import('node:child_process')
  const { BADGE_FILE, STATE_BRANCH } = await import('../../src/watch/seen.ts')

  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-badge-bare-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-mig-badge-work-'))
  try {
    const git = (args: string[], cwd = work): void => {
      const result = spawnSync('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' })
    git(['init'])
    git(['config', 'user.name', 'test'])
    git(['config', 'user.email', 'test@example.test'])
    writeFileSync(join(work, 'plugin.js'), 'export {}\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    git(['remote', 'add', 'origin', bare])
    git(['push', '-u', 'origin', 'HEAD:master'])

    // The first push to the state branch is rejected the way a lost race is.
    const hook = join(bare, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      '#!/bin/sh\nif [ ! -f "$(dirname "$0")/../.rejected" ]; then touch "$(dirname "$0")/../.rejected"; echo "non-fast-forward" >&2; exit 1; fi\nexit 0\n',
    )
    chmodSync(hook, 0o755)

    const child = spawn(process.execPath, ['dist/src/cli.js', 'refresh-badge', '--workdir', work], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_REPOSITORY: 'me/plugin' },
    })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.resume()
    const status = await new Promise<number | null>(resolve => { child.on('close', code => { resolve(code) }) })
    assert.equal(status, 0)
    assert.match(stdout, /moved under this write; retrying/)
    assert.doesNotMatch(stdout, /failed to persist dsh state/)
    // The write landed on the second attempt.
    const badge = spawnSync('git', ['-C', bare, 'show', `${STATE_BRANCH}:${BADGE_FILE}`], { encoding: 'utf8' })
    assert.equal(badge.status, 0, badge.stderr)
  } finally {
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('two ledgers merge without losing what either of them held', async () => {
  const { mergeCommandLedgers } = await import('../../src/commands/idempotency.ts')
  const older = [
    { key: 'me/plugin#7:redeploy:comment=1', verb: 'redeploy', at: '2026-09-14T01:00:00.000Z' },
    { key: 'me/plugin#12:feedback:merge', verb: MERGE_VERB, at: '2026-09-14T03:00:00.000Z', channels: ['migrate-bot'] },
  ]
  const newer = [
    // The same key, seen later: the first delivery's time is what matters.
    { key: 'me/plugin#7:redeploy:comment=1', verb: 'redeploy', at: '2026-09-14T05:00:00.000Z' },
    { key: 'me/plugin#7:destroy:comment=2', verb: 'destroy', at: '2026-09-14T06:00:00.000Z' },
  ]
  const merged = mergeCommandLedgers(older, newer)
  assert.deepEqual(merged.map(record => record.key), [
    'me/plugin#7:redeploy:comment=1',
    'me/plugin#12:feedback:merge',
    'me/plugin#7:destroy:comment=2',
  ])
  assert.equal(merged[0]?.at, '2026-09-14T01:00:00.000Z')
  // The channels a merge report reached accumulate across the two reads.
  assert.deepEqual(
    mergeCommandLedgers(
      [{ key: 'k', verb: MERGE_VERB, at: '2026-09-14T01:00:00.000Z', channels: ['a'] }],
      [{ key: 'k', verb: MERGE_VERB, at: '2026-09-14T02:00:00.000Z', channels: ['b'] }],
    )[0]?.channels,
    ['a', 'b'],
  )
  // A record nobody else has is kept, and an empty side changes nothing.
  assert.equal(mergeCommandLedgers(older, []).length, 2)
  assert.equal(mergeCommandLedgers([], newer).length, 2)
  assert.deepEqual(mergeCommandLedgers([], []), [])
  // An unreadable timestamp sorts last rather than being dropped.
  const unreadable = mergeCommandLedgers([{ key: 'old', verb: 'status', at: '' }], newer)
  assert.equal(unreadable.at(-1)?.key, 'old')
})

test('a read-only verb writes nothing into the checkout', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn, spawnSync } = await import('node:child_process')

  const { bare, work, git } = await scratchRepo('dsh-mig-ro')
  const run = async (body: string): Promise<void> => {
    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'command',
      '--workdir', work,
      '--comment-body', body,
      '--comment-author', 'me',
      '--comment-author-association', 'OWNER',
      '--issue-number', '7',
      '--pull-request', '7',
    ], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_REPOSITORY: 'me/plugin' },
    })
    child.stdout.resume()
    child.stderr.resume()
    await new Promise<void>(resolve => { child.on('close', () => { resolve() }) })
  }
  try {
    mkdirSync(join(work, '.github'), { recursive: true })
    writeFileSync(join(work, '.github/dsh-migrate.yml'), 'deploy:\n  enabled: false\n')
    git(['add', '-A'])
    git(['commit', '-m', 'config'])
    const exclude = join(work, '.git', 'info', 'exclude')
    const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    assert.doesNotMatch(before, /\.dsh-migrate\//)

    await run('/dsh-migrate status')
    const after = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    assert.doesNotMatch(after, /\.dsh-migrate\//, 'status wrote to the checkout')
    // And nothing was created either.
    assert.equal(existsSync(join(work, '.dsh-migrate')), false)
    assert.equal(spawnSync('git', ['-C', work, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim(), '')
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

test('deploy.commands: false refuses every comment verb, and touches no target', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:http')

  const { bare, work, git } = await scratchRepo('dsh-mig-off')
  const calls: string[] = []
  const server = createServer((request, response) => {
    calls.push(`${request.method ?? ''} ${request.url ?? ''}`)
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"state":"running"}')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const run = async (body: string, id: string): Promise<string> => {
    const child = spawn(process.execPath, [
      'dist/src/cli.js', 'command',
      '--workdir', work,
      '--config', '.github/dsh-migrate.yml',
      '--comment-body', body,
      '--comment-id', id,
      '--comment-author', 'me',
      '--comment-author-association', 'OWNER',
      '--issue-number', '7',
      '--pull-request', '7',
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DSH_MIGRATE_DEPLOY_TOKEN: 'secret',
        GITHUB_REPOSITORY: 'me/plugin',
      },
    })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.resume()
    await new Promise<void>(resolve => { child.on('close', () => { resolve() }) })
    return out
  }
  try {
    mkdirSync(join(work, '.github'), { recursive: true })
    writeFileSync(
      join(work, '.github/dsh-migrate.yml'),
      `deploy:\n  enabled: true\n  endpoint: http://127.0.0.1:${String(port)}\n  commands: false\n`,
    )
    git(['add', '-A'])
    git(['commit', '-m', 'config'])

    // Every verb, including the two that need no target: the switch governs the
    // command surface, and `status` reads the target now.
    const verbs = ['status', 'feedback', 'redeploy', 'destroy', 'extend', 'publish']
    for (const [index, verb] of verbs.entries()) {
      const out = await run(`/dsh-migrate ${verb}`, String(10 + index))
      assert.match(out, /Commands are disabled/, `${verb} was not refused`)
    }
    assert.deepEqual(calls, [], 'the target was asked something')

    // The help a person gets without a command is still help, not a refusal.
    const help = await run('/dsh-migrate', '20')
    assert.match(help, /dsh-migrate status/)
    const noCommand = await run('looks good to me', '21')
    assert.match(noCommand, /nothing to do/)
    assert.deepEqual(calls, [])
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    rmSync(bare, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
