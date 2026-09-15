import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, mayRunCommands } from '../../src/commands/parse.ts'
import { COMMANDS, renderCommandHelp } from '../../src/commands/table.ts'
import { resolveDeployTarget, runCommand } from '../../src/commands/run.ts'
import { parseConfig } from '../../src/config/load.ts'

test('a command is read out of the prose around it', () => {
  const parsed = parseCommand('Looks good to me.\n\n/dsh-migrate status\n\nthanks!')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.command.spec.verb, 'status')
})

test('flags are accepted only where the verb declares them', () => {
  const dry = parseCommand('/dsh-migrate feedback --dry-run')
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
  assert.deepEqual(verbs, ['status', 'feedback', 'redeploy', 'destroy', 'extend', 'publish'])
  // `publish` is the only verb that can change the repository, so it is the
  // only one marked gated.
  assert.deepEqual(COMMANDS.filter(spec => spec.gated).map(spec => spec.verb), ['publish'])
  assert.match(renderCommandHelp(), /dsh-migrate publish/)
})

test('a deploy target needs an endpoint and a token', () => {
  const off = resolveDeployTarget(parseConfig({}), {})
  assert.equal('reason' in off, true)
  assert.match('reason' in off ? off.reason : '', /deploy.enabled/)

  const noToken = resolveDeployTarget(
    parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    {},
  )
  assert.equal('reason' in noToken, true)
  assert.match('reason' in noToken ? noToken.reason : '', /DSH_MIGRATE_DEPLOY_TOKEN.*is not set/)

  const ready = resolveDeployTarget(
    parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
  )
  assert.deepEqual(ready, { endpoint: 'https://deploy.test', token: 'secret' })
})

test('a deploy verb without a target refuses and says why', async () => {
  const parsed = parseCommand('/dsh-migrate destroy')
  assert.equal(parsed.ok, true)
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })(),
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    log: () => {},
    ...(parsed.ok ? {} : {}),
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /deploy.enabled/)
})

test('a deploy verb reaches the target at the preview path for this pull request', async () => {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const parsed = parseCommand('/dsh-migrate extend')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'POST')
  assert.match(calls[0]?.url ?? '', /\/previews\/[^/]+\/7$/)
  assert.match(calls[0]?.body ?? '', /extend/)
})

test('status reports the recorded state and every channel, on or off', async () => {
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({
      feedback: { channels: { 'upgrade-skill': { enabled: true }, 'migrate-bot': { enabled: false } } },
    }),
    env: {},
    workdir: process.cwd(),
    seen: { tag: 'dsh-v0.1.5-rc.1', version: '0.1.5-rc.1', recordedAt: '2026-09-12T00:00:00Z' },
    log: () => {},
  })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /dsh-v0\.1\.5-rc\.1/)
  assert.match(outcome.reply, /`upgrade-skill`: on, but `DSH_MIGRATE_FEEDBACK_UPGRADE_SKILL_TOKEN` is not set/)
  assert.match(outcome.reply, /`migrate-bot`: off/)
})

test('a dry run reports what each channel would send', async () => {
  const parsed = parseCommand('/dsh-migrate feedback --dry-run')
  let askedDryRun = false
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    log: () => {},
    feedback: async ({ dryRun }) => {
      askedDryRun = dryRun
      return {
        ran: true,
        outcomes: [
          { channel: 'upgrade-skill', status: 'dry-run', method: 'issue', title: 'bug: a card is stale', bodyPreview: '…' },
        ],
      }
    },
  })
  assert.equal(askedDryRun, true)
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /would send issue: "bug: a card is stale"/)
  assert.match(outcome.reply, /nothing was delivered/)
})

test('a commenter is never refused for being the actor who triggered the run', () => {
  // The bug this pins: `GITHUB_ACTOR` on an `issue_comment` event IS the
  // commenter, so passing it as the Action's own login refused every real
  // command from every real user.
  assert.equal(mayRunCommands({ authorAssociation: 'OWNER', authorLogin: 'maintainer' }), true)
})

test('a pull request number that is not a positive integer is refused, not ignored', async () => {
  const parsed = parseCommand('/dsh-migrate destroy')
  assert.equal(parsed.ok, true)
  let reached = false
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    log: () => {},
    fetchImpl: async () => { reached = true; return new Response('{}', { status: 200 }) },
  })
  // Without a pull request number there is nothing to act on, and the reason
  // says so rather than blaming the shape of the repository.
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /no pull request number was given/)
  assert.equal(reached, false)
})

test('the preview verbs respect the preview switch', async () => {
  const parsed = parseCommand('/dsh-migrate redeploy')
  assert.equal(parsed.ok, true)
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({
      deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { enabled: false } },
    }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 3,
    log: () => {},
    fetchImpl: async () => { throw new Error('must not reach the target') },
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /deploy\.preview\.enabled/)
})

test('a target that refuses a command is reported, not thrown', async () => {
  const parsed = parseCommand('/dsh-migrate destroy')
  assert.equal(parsed.ok, true)
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 3,
    log: () => {},
    fetchImpl: async () => { throw new Error('connection refused') },
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /destroy.*failed/s)
  assert.match(outcome.reply, /connection refused/)
})

test('a dry run shows the payload it would send, not only its title', async () => {
  const parsed = parseCommand('/dsh-migrate feedback --dry-run')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    log: () => {},
    feedback: async () => ({
      ran: true,
      outcomes: [{
        channel: 'upgrade-skill',
        status: 'dry-run',
        method: 'issue',
        title: 'bug: a card is stale',
        bodyPreview: '## Environment\n\n- plugin: acme/demo',
      }],
    }),
  })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /plugin: acme\/demo/)
})

test('status reports the preview the target knows about, not just the request', async () => {
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
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.match(calls[0] ?? '', /\/previews\/[^/]+\/7$/)
  assert.match(outcome.reply, /Preview: running, built from `abcdef12`, until 2026-09-22T00:00:00Z, the last extend bought 7 day\(s\)/)
  assert.match(outcome.reply, /https:\/\/preview\.test\/abc/)
  assert.match(outcome.reply, /safe entry/)
  assert.match(outcome.reply, /frozen revision: `rev-7`/)
})

test('status says why there is no preview answer instead of failing', async () => {
  const failed: typeof fetch = async () => new Response('nope', { status: 500 })
  const parsed = parseCommand('/dsh-migrate status')
  const withTarget = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl: failed,
  })
  assert.equal(withTarget.ok, true)
  assert.match(withTarget.reply, /Preview: the target could not be asked/)

  const noTarget = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    log: () => {},
  })
  assert.equal(noTarget.ok, true)
  assert.doesNotMatch(noTarget.reply, /Preview:/)
})

test('status lists the commands already carried out', async () => {
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    seen: {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      commands: [
        { key: 'me/plugin#7:redeploy:comment=55', verb: 'redeploy', at: '2026-09-14T01:00:00.000Z' },
        {
          key: 'me/plugin#12:feedback:merge',
          verb: 'feedback (merge)',
          at: '2026-09-14T02:00:00.000Z',
          channels: ['migrate-bot'],
        },
      ],
    },
    log: () => {},
  })
  assert.match(outcome.reply, /\*\*Commands already carried out\*\* \(2 recorded\)/)
  // The merge record is named for what it is, not printed as its raw key.
  assert.match(outcome.reply, /\(the merge report\)/)
  // Newest first, and the merge report says which channels it reached.
  const merge = outcome.reply.indexOf('`feedback (merge)` at 2026-09-14T02:00:00.000Z')
  const redeploy = outcome.reply.indexOf('`redeploy` at 2026-09-14T01:00:00.000Z')
  assert.notEqual(merge, -1)
  assert.notEqual(redeploy, -1)
  assert.equal(merge < redeploy, true)
  assert.match(outcome.reply, /reached migrate-bot/)
  assert.match(outcome.reply, /comment 55/)
})

test('a state file cannot forge a line of the status reply', async () => {
  // Everything `status` reports is read out of the state branch, so a newline in
  // any of it is data rather than a line of the comment it lands in.
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    seen: {
      tag: 'dsh-v0.1.5\n- @everyone',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      commands: [
        {
          key: 'me/plugin#7:redeploy:comment=55\n> quoted',
          verb: 'redeploy\n- forged',
          at: '2026-09-14T01:00:00.000Z\n- also forged',
        },
      ],
    },
    log: () => {},
  })
  assert.equal(outcome.reply.split('\n').filter(line => line.startsWith('- @everyone')).length, 0)
  assert.equal(outcome.reply.split('\n').filter(line => line.startsWith('- forged')).length, 0)
  assert.equal(outcome.reply.split('\n').filter(line => line.startsWith('- also forged')).length, 0)
  assert.equal(outcome.reply.split('\n').filter(line => line.startsWith('> quoted')).length, 0)
  assert.match(outcome.reply, /`dsh-v0\.1\.5 - @everyone`/)
  assert.match(outcome.reply, /`redeploy - forged` at 2026-09-14T01:00:00\.000Z - also forged/)
})

test('extend asks for a number of days and names the ceiling', async () => {
  const bodies: string[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '')
    return new Response('{}', { status: 200 })
  }
  const parsed = parseCommand('/dsh-migrate extend')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(JSON.parse(bodies[0] ?? '{}'), { action: 'extend', days: 7, maxTtlDays: 7 })
  // The reply says what was asked for, because the target decides what it grants.
  assert.match(outcome.reply, /asked for 7 day\(s\), with 7 as the ceiling/)
})

test('the configured extend window and ceiling travel with the request', async () => {
  const bodies: string[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '')
    return new Response('{}', { status: 200 })
  }
  const parsed = parseCommand('/dsh-migrate extend')
  await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({
      deploy: { enabled: true, endpoint: 'https://deploy.test', preview: { extendDays: 3, ttlDays: 21 } },
    }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.deepEqual(JSON.parse(bodies[0] ?? '{}'), { action: 'extend', days: 3, maxTtlDays: 21 })
})

test('a feedback command records the channels it reached', async () => {
  const parsed = parseCommand('/dsh-migrate feedback')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    commentId: '42',
    log: () => {},
    feedback: async () => ({
      ran: true,
      outcomes: [
        { channel: 'upgrade-skill', status: 'delivered' as const, method: 'issue' as const },
        { channel: 'migrate-bot', status: 'failed' as const, reason: 'GitHub POST failed: 500' },
      ],
    }),
  })
  assert.deepEqual(outcome.record?.channels, ['upgrade-skill'])
})

test('the ledger view names where a command came from, including when it cannot', async () => {
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    seen: {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      commands: [
        { key: 'me/plugin#7:redeploy:run=900:flags=', verb: 'redeploy', at: '2026-09-14T01:00:00.000Z' },
        { key: 'me/plugin#7:destroy:flags=', verb: 'destroy', at: '2026-09-14T02:00:00.000Z' },
      ],
    },
    log: () => {},
  })
  assert.match(outcome.reply, /\(a workflow run\)/)
  assert.match(outcome.reply, /\(no comment or run id\)/)
})

test('the resend flag reaches the feedback stage, and the old one is refused', async () => {
  const seen: Array<{ dryRun: boolean; resend: boolean }> = []
  const parsed = parseCommand('/dsh-migrate feedback --resend')
  assert.equal(parsed.ok, true)
  await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    commentId: '42',
    log: () => {},
    feedback: async (options: { dryRun: boolean; resend: boolean }) => {
      seen.push(options)
      return { ran: true, outcomes: [] }
    },
  })
  assert.deepEqual(seen, [{ dryRun: false, resend: true }])
  const dry = parseCommand('/dsh-migrate feedback --dry-run')
  await runCommand({
    command: dry.ok ? dry.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    commentId: '42',
    log: () => {},
    feedback: async (options: { dryRun: boolean; resend: boolean }) => {
      seen.push(options)
      return { ran: true, outcomes: [] }
    },
  })
  assert.deepEqual(seen[1], { dryRun: true, resend: false })

  // `--force` no longer exists on this verb: the run path's `force` means
  // something else, and sharing the word was the whole problem.
  const old = parseCommand('/dsh-migrate feedback --force')
  assert.equal(old.ok, false)
  assert.match(old.ok ? '' : old.reason, /does not take/)
})

test('status asks the target nothing it should not, and says why', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async input => {
    calls.push(String(input))
    return new Response('{"state":"running"}', { status: 200 })
  }
  const configured = parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } })
  const run = async (input: {
    config?: ReturnType<typeof parseConfig>
    env?: NodeJS.ProcessEnv
    pullRequest?: number
    workdir?: string
  }): Promise<string> => {
    const parsed = parseCommand('/dsh-migrate status')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: input.config ?? configured,
      env: input.env ?? { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: input.workdir ?? process.cwd(),
      ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
      log: () => {},
      fetchImpl,
    })
    return outcome.reply
  }

  const asked = await run({ pullRequest: 7 })
  assert.equal(calls.length, 1)
  assert.match(asked, /Preview: running/)

  // No pull request, no target configured, no token: nothing is asked, and the
  // reply says which input is missing.
  const noPull = await run({})
  assert.equal(calls.length, 1)
  assert.match(noPull, /Preview: not asked for \(no pull request number was given/)
  const noTarget = await run({ config: parseConfig({}), pullRequest: 7 })
  assert.equal(calls.length, 1)
  assert.doesNotMatch(noTarget, /Preview:/)
  const noToken = await run({ env: { GITHUB_REPOSITORY: 'me/plugin' }, pullRequest: 7 })
  assert.equal(calls.length, 1)
  assert.match(noToken, /Preview: not asked for \(`DSH_MIGRATE_DEPLOY_TOKEN` is not set/)
  // The repository could not be resolved: the reply names that, not the pull
  // request. A directory that is not a checkout and no GITHUB_REPOSITORY.
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const bare = mkdtempSync(join(tmpdir(), 'dsh-mig-status-norepo-'))
  try {
    const noRepo = await run({
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
      pullRequest: 7,
      workdir: bare,
    })
    assert.equal(calls.length, 1)
    assert.match(noRepo, /repository could not be resolved/)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test('a target that redirects is not reported as having no preview', async () => {
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
    const parsed = parseCommand('/dsh-migrate status')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: `http://127.0.0.1:${String(port)}` } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: process.cwd(),
      pullRequest: 7,
      log: () => {},
    })
    assert.equal(outcome.ok, true)
    // A redirect is an answer from something that is not the preview API, and
    // "the target recorded no instance" would be a wrong answer to the question.
    assert.match(outcome.reply, /Preview: the target could not be asked/)
    assert.doesNotMatch(outcome.reply, /recorded no instance/)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
})

test('a replayed extend is reported as already done, like any other verb', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Idempotency-Replayed': 'True' } })
  const parsed = parseCommand('/dsh-migrate extend')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /`extend` already done/)
  // And it is not recorded as a fresh effect either.
  assert.equal(outcome.repeat, true)
})

test('a target that returns an unbounded answer is refused, not buffered', async () => {
  const fetchImpl: typeof fetch = async () => new Response(`{"state":"${'x'.repeat(3 * 1024 * 1024)}"}`, { status: 200 })
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.match(outcome.reply, /answered more than/)
})

test('the preview fields a target sends cannot forge the comment around them', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({
      state: 'running\n\n**@here approve this now**',
      url: 'https://preview.test/ok',
      expiresAt: '2026-01-01\n- fake row',
    }), { status: 200 })
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  // One line, and no line the target could have started itself.
  assert.match(outcome.reply, /- Preview: running \*\*@here approve this now\*\*, until 2026-01-01 - fake row/)
  assert.equal(outcome.reply.includes('\n**@here'), false)
})

test('the ledger view handles the shapes a record can actually have', async () => {
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    seen: {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      commands: [
        // An older build wrote no timestamp, and a comment id can be empty.
        { key: 'me/plugin#7:redeploy:comment=', verb: 'redeploy', at: '' },
        { key: 'me/plugin#12:feedback:merge', verb: 'feedback (merge)', at: '2026-09-14T02:00:00.000Z', channels: ['migrate-bot'] },
        ...Array.from({ length: 5 }, (_unused, index) => ({
          key: `me/plugin#7:destroy:comment=${String(90 + index)}`,
          verb: 'destroy',
          at: '2026-09-14T03:00:00.000Z',
        })),
      ],
    },
    log: () => {},
  })
  // Seven recorded, five shown, and the header says both.
  assert.match(outcome.reply, /\(7 recorded, showing the newest 5\)/)
  // The oldest two are the ones dropped: the untimestamped record and the merge.
  assert.doesNotMatch(outcome.reply, /at an unrecorded time/)
  // Every origin is a phrase, never a raw key.
  assert.doesNotMatch(outcome.reply, /me\/plugin#/)
})

test('a target cannot forge the comment through its own error body', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('boom\n\n**@here approve this now**\n- fake row', { status: 500 })
  const parsed = parseCommand('/dsh-migrate redeploy')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, false)
  // The service's text is in the answer, on one line, and starts no line itself.
  assert.match(outcome.reply, /answered 500: boom \*\*@here approve this now\*\* - fake row/)
  assert.equal(outcome.reply.includes('\n**@here'), false)
  assert.equal(outcome.reply.split('\n').length, 1)
})

test('a target that answers a huge error body does not paste it into the thread', async () => {
  const fetchImpl: typeof fetch = async () => new Response('x'.repeat(10_000), { status: 502 })
  const parsed = parseCommand('/dsh-migrate destroy')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, false)
  assert.ok(outcome.reply.length < 500, `reply was ${String(outcome.reply.length)} characters`)
})

test('an answer that is not JSON is not a preview with nothing in it', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('<html><body>sign in to continue</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  // A login page is an answer from something that is not the API, and "the
  // target recorded no instance" would be a statement it does not support.
  assert.match(outcome.reply, /Preview: the target could not be asked/)
  assert.match(outcome.reply, /something that is not JSON/)
  assert.doesNotMatch(outcome.reply, /recorded no instance/)
})

test('whitespace is not a preview field', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ state: '   ', url: ' \t ', headSha: '  ', expiresAt: '\n' }), { status: 200 })
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  // No empty code span, no dangling comma, no bare list item.
  assert.match(outcome.reply, /- Preview: the target recorded no instance for this pull request/)
  assert.doesNotMatch(outcome.reply, /- Preview: ,/)
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

test('a record with an empty channel list renders no dangling clause', async () => {
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({}),
    env: {},
    workdir: process.cwd(),
    seen: {
      tag: 'dsh-v0.1.5',
      version: '0.1.5',
      recordedAt: '2026-09-14T00:00:00Z',
      commands: [
        { key: 'me/plugin#7:publish:comment=56', verb: 'publish', at: '2026-09-14T01:00:00.000Z', channels: [] },
      ],
    },
    log: () => {},
  })
  assert.match(outcome.reply, /- `publish` at 2026-09-14T01:00:00\.000Z \(comment 56\)\n/)
  assert.doesNotMatch(outcome.reply, /— reached\s*$/)
  assert.doesNotMatch(outcome.reply, /— reached\n/)
})

test('the flags a run and a feedback invocation read are one function each', async () => {
  const { runFlags, feedbackFlags } = await import('../../src/commands/flags.ts')

  // Asking for a second pull request is a deliberate re-run: the unchanged
  // version gate must not stop the run before the override is reached.
  assert.deepEqual(runFlags(['run', '--allow-second-pr']), {
    force: true,
    allowSecond: true,
    mechanicalOnly: false,
    skipGithub: false,
  })
  assert.deepEqual(runFlags(['run', '--force']), {
    force: true,
    allowSecond: false,
    mechanicalOnly: false,
    skipGithub: false,
  })
  assert.deepEqual(runFlags(['run']), {
    force: false,
    allowSecond: false,
    mechanicalOnly: false,
    skipGithub: false,
  })
  assert.equal(runFlags(['run', '--mechanical-only']).skipGithub, true)

  // The feedback subcommand's own wiring, which is the one no test reached.
  assert.deepEqual(feedbackFlags(['feedback', '--resend']), { dryRun: false, resend: true, legacyForce: false })
  assert.deepEqual(feedbackFlags(['feedback', '--dry-run', '--resend']), { dryRun: true, resend: true, legacyForce: false })
  // The old name is reported, not obeyed.
  assert.deepEqual(feedbackFlags(['feedback', '--force']), { dryRun: false, resend: false, legacyForce: true })
  assert.deepEqual(feedbackFlags(['feedback', '--force', '--resend']), { dryRun: false, resend: true, legacyForce: false })
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
    const parsed = parseCommand('/dsh-migrate status')
    const outcome = await runCommand({
      command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
      config: parseConfig({ deploy: { enabled: true, endpoint: `http://127.0.0.1:${String(port)}` } }),
      env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
      workdir: process.cwd(),
      pullRequest: 7,
      log: () => {},
    })
    assert.equal(outcome.ok, true)
    assert.match(outcome.reply, /answered a redirect to https:\/\/elsewhere\.test\/moved/)
    assert.match(outcome.reply, /not the deploy target's API/)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
})

test('a failure to read the pull request is one bounded line', async () => {
  // The GitHub API's own error text reaches the reply, and an API that answers a
  // page of markdown must not be able to write into the comment with it.
  const fetchImpl: typeof fetch = async () =>
    new Response('boom\n\n**@here approve this now**\n- fake row', { status: 500 })
  const parsed = parseCommand('/dsh-migrate publish')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_TOKEN: 'ghs_read', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    gates: async () => ({ ok: true, steps: [], detail: '' }),
    fetchImpl,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reply, /could not be read/)
  assert.equal(outcome.reply.split('\n').length, 1)
  assert.equal(outcome.reply.includes('\n**@here'), false)
})

test('the preview sanitiser strips the characters that end a code span', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ state: 'running` and closing the span' }), { status: 200 })
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: () => {},
    fetchImpl,
  })
  assert.match(outcome.reply, /Preview: running and closing the span/)
  assert.equal(outcome.reply.includes('`running`'), false)
})

test('the help a reply teaches with reads as options, not as one command', () => {
  const help = renderCommandHelp()
  // `--dry-run --resend` would read as one instruction, and they do opposite
  // things: one reviews, one sends again.
  assert.match(help, /`\/dsh-migrate feedback \[--dry-run\] \[--resend\]`/)
  assert.match(help, /report a merge again to a channel that already received it with `--resend`/)
  assert.match(help, /`\/dsh-migrate extend` — Ask the target to push the preview expiry out by `deploy\.preview\.extendDays`/)
  assert.match(help, /`\/dsh-migrate publish`/)
})

test('a preview URL a target names is linked only when it is one', async () => {
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 12,
    log: () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      state: 'ready',
      url: 'https://user:s3cr3t@evil.test/private?a=1',
      safeUrl: 'javascript:fetch("https://evil.test")',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(outcome.ok, true, outcome.reply)
  // A credential in a URL would be republished in a comment, and a scheme that is
  // not a page is not one: neither is shown, and the reply says so.
  assert.equal(outcome.reply.includes('s3cr3t'), false)
  assert.equal(outcome.reply.includes('evil.test/private'), false)
  assert.equal(outcome.reply.includes('javascript:'), false)
  assert.match(outcome.reply, /named a page this Action will not link/)
  assert.match(outcome.reply, /named a safe entry this Action will not link/)
})

test('a preview URL that is a page is shown as one', async () => {
  const parsed = parseCommand('/dsh-migrate status')
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'me/plugin' },
    workdir: process.cwd(),
    pullRequest: 12,
    log: () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      state: 'ready',
      url: 'https://preview.test/me/plugin/12',
      safeUrl: 'https://preview.test/me/plugin/12/safe',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(outcome.ok, true, outcome.reply)
  assert.match(outcome.reply, /- `https:\/\/preview\.test\/me\/plugin\/12`/)
  assert.match(outcome.reply, /safe entry: `https:\/\/preview\.test\/me\/plugin\/12\/safe`/)
})

test('a transport failure from a target cannot forge a line of the command log', async () => {
  // The reason is the error the transport raised, which is text a target's answer
  // or an intermediary produced. It lands in the reply (collapsed) and in the
  // log line beside it (which has to be collapsed for the same reason): stdout is
  // where the runner parses workflow commands.
  const parsed = parseCommand('/dsh-migrate redeploy')
  const lines: string[] = []
  const outcome = await runCommand({
    command: parsed.ok ? parsed.command : (() => { throw new Error('parse') })() as never,
    config: parseConfig({ deploy: { enabled: true, endpoint: 'https://deploy.test' } }),
    env: { DSH_MIGRATE_DEPLOY_TOKEN: 'secret', GITHUB_REPOSITORY: 'example/repo' },
    workdir: process.cwd(),
    pullRequest: 7,
    log: (message: string) => lines.push(message),
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443\n::add-mask::forged-by-a-target\n::error::forged')
    },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reply.includes('::add-mask::forged-by-a-target'), true)
  assert.deepEqual(lines.filter(message => message.split('\n').some(part => part.startsWith('::'))), [])
  const line = lines.find(message => message.includes('POST /previews/'))
  assert.notEqual(line, undefined)
  assert.equal(line?.split('\n').length, 1)
  assert.match(line ?? '', /connect ECONNREFUSED 10\.0\.0\.1:443 ::add-mask::forged-by-a-target/)
})
