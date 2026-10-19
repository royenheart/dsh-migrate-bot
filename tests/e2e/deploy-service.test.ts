import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appRootFrom } from '../../src/paths.ts'
import { checkout } from '../support/repository.ts'
import { FakeGitHub } from '../support/github.ts'
import { serve } from '../support/serve.ts'

/**
 * The Action against the reference deploy service, end to end and keyless.
 *
 * The service (`deploy-service/`, built beforehand) runs with the `process`
 * provider, so a preview is two real `dsh web` processes on this machine. The
 * CLI is the real one: a migration streams its run log to the service, and the
 * comment commands drive the preview, with GitHub served by the in-memory fake
 * and the pull request branch living in a bare repository on disk. The agent
 * runtime is a stub; no agent session runs and no API key is used.
 *
 * Skipped with the reason when the service is not built or when
 * `@deepseek-ai/dsh` cannot be installed (no network). With
 * `DEPLOY_SERVICE_E2E=required`, as CI sets it, either of those fails instead.
 */

const ROOT = appRootFrom(import.meta.url)
const CLI = join(ROOT, 'dist', 'src', 'cli.js')
const SERVICE = join(ROOT, 'deploy-service', 'dist', 'src', 'main.js')
const TOKEN = 'e2e-deploy-token-0123456789'
const SECRET = 'e2e-webhook-secret-0123456789'
const REQUIRED = process.env.DEPLOY_SERVICE_E2E === 'required'

const STUB = `#!/usr/bin/env node
if (!process.env.DEEPSEEK_API_KEY) {
  process.stderr.write('dsh-migrate: MISSING_CREDENTIAL: llm-deepseek: no API key\\n')
  process.exit(1)
}
process.stderr.write('the stub agent runtime was asked for a session, which this test never needs\\n')
process.exit(1)
`

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('close', (status) => { resolve({ status, output }) })
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

/** The dsh version the agent runtime pins, which is also what previews run. */
function pinnedDsh(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'container', 'agent-runtime', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const version = manifest.dependencies['@deepseek-ai/dsh']
  if (version === undefined) throw new Error('container/agent-runtime/package.json pins no @deepseek-ai/dsh')
  return version
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

test('a migration streams its run log, and the comment commands drive a real preview deployment', { timeout: 300_000 }, async (t) => {
  const skip = (reason: string): void => {
    if (REQUIRED) assert.fail(`DEPLOY_SERVICE_E2E=required, but ${reason}`)
    t.skip(reason)
  }
  if (!existsSync(SERVICE)) return skip('the deploy service is not built; run `npm run deploy-service:build` first')

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-deploy-e2e-'))
  const children: ChildProcess[] = []
  const repo = checkout({ 'README.md': 'A plugin.\n' })
  const github = new FakeGitHub('acme/plugin')
  const api = await serve(github.fetch)
  try {
    // Slow (about 20 s on a warm npm cache): the dsh the previews run.
    const prefix = join(scratch, 'dsh')
    const installed = spawnSync('npm', ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', `@deepseek-ai/dsh@${pinnedDsh()}`], {
      encoding: 'utf8',
      timeout: 240_000,
      env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'npm-cache'), npm_config_logs_dir: process.env.npm_config_logs_dir ?? join(tmpdir(), 'npm-logs') },
    })
    if (installed.status !== 0) return skip(`@deepseek-ai/dsh@${pinnedDsh()} could not be installed (no network?): ${(installed.stderr ?? '').split('\n').filter(line => line.startsWith('npm error')).slice(0, 2).join(' ')}`)

    // The consumer repository: the fixture plugin with a configuration that
    // runs no agent session, and a pull request branch.
    cpSync(join(ROOT, 'fixtures', 'plugins', 'typecheck-ok'), repo.work, { recursive: true })
    mkdirSync(join(repo.work, '.github'))
    const port = await freePort()
    const endpoint = `http://127.0.0.1:${String(port)}`
    writeFileSync(join(repo.work, '.github', 'dsh-migrate.yml'), [
      'target: 0.2.0',
      'review:',
      '  policy: when-checks-fail',
      'checks:',
      '  boot:',
      '    enabled: false',
      '  web:',
      '    enabled: false',
      '  e2e:',
      '    enabled: false',
      'tests:',
      '  commands:',
      '    - "true"',
      'deploy:',
      '  enabled: true',
      `  endpoint: ${endpoint}`,
      '  preview:',
      '    ttlDays: 7',
      '    extendDays: 1',
      '',
    ].join('\n'))
    repo.git(['add', '-A'])
    repo.git(['commit', '--quiet', '-m', 'plugin'])
    repo.git(['push', '--quiet', 'origin', 'HEAD:main'])
    repo.git(['checkout', '--quiet', '-b', 'feature'])
    appendFileSync(join(repo.work, 'src', 'index.js'), 'export const feature = true\n')
    repo.git(['commit', '--quiet', '-am', 'feature'])
    repo.git(['push', '--quiet', 'origin', 'feature'])
    const head = repo.git(['rev-parse', 'HEAD'])
    repo.git(['checkout', '--quiet', 'main'])
    github.addPull({ number: 1, head: { ref: 'feature', sha: head } })

    // The service.
    const dataDir = join(scratch, 'data')
    const service = spawn(process.execPath, [SERVICE], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? scratch,
        DEPLOY_TOKEN: TOKEN,
        GITHUB_WEBHOOK_SECRET: SECRET,
        DATA_DIR: dataDir,
        PUBLIC_URL: endpoint,
        PROVIDER: 'process',
        DSH_BIN: join(prefix, 'bin', 'dsh'),
        PORT: String(port),
        HOST: '127.0.0.1',
        TTL_DAYS: '2',
        npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'npm-cache'),
        npm_config_logs_dir: process.env.npm_config_logs_dir ?? join(tmpdir(), 'npm-logs'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(service)
    let serviceLog = ''
    service.stdout.on('data', (chunk: Buffer) => { serviceLog += chunk.toString() })
    service.stderr.on('data', (chunk: Buffer) => { serviceLog += chunk.toString() })
    await until('the service to listen', 15_000, async () => serviceLog.includes('listening') ? true : undefined)
    const call = async (method: string, path: string): Promise<Response> => await fetch(`${endpoint}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } })
    const preview = async (): Promise<Record<string, unknown>> => await (await call('GET', '/previews/acme%2Fplugin/1')).json() as Record<string, unknown>

    // The CLI environment: a stub agent runtime, a stub npm, and the fake GitHub.
    const bin = join(scratch, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const stub = join(scratch, 'dsh-stub.cjs')
    writeFileSync(stub, STUB, { mode: 0o755 })
    const home = join(scratch, 'home')
    mkdirSync(join(home, 'harness', '.git'), { recursive: true })
    writeFileSync(join(home, 'harness', '.dsh-migrate-tag'), 'dsh-v0.2.0\n')
    const output = join(scratch, 'github-output')
    writeFileSync(output, '')
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? scratch,
      DSH_BIN: stub,
      DSH_MIGRATE_HOME: home,
      DSH_MIGRATE_DEPLOY_TOKEN: TOKEN,
      DEEPSEEK_API_KEY_DSH_MIGRATE_BOT: 'sk-stub',
      GITHUB_OUTPUT: output,
    }

    // 1. A migration streams its run log, and the record the service sealed
    //    matches what it stored.
    const migrated = await run(['run', '--workdir', repo.work, '--skip-github'], env)
    assert.equal(migrated.status, 0, migrated.output)
    const page = /log stream: (http:\/\/\S+\/view\/(\S+))/.exec(migrated.output)
    assert.ok(page?.[1] !== undefined && page[2] !== undefined, migrated.output)
    assert.equal((await call('GET', `/view/${page[2]}`)).status, 200)
    const runDir = join(dataDir, 'runs', decodeURIComponent(page[2]))
    const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as { stored: number; finish?: { events: number; attempted: number; complete: boolean } }
    const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(line => line !== '')
    assert.ok(meta.finish !== undefined, 'the run was sealed')
    assert.equal(meta.finish.events, lines.length)
    assert.equal(meta.stored, lines.length)
    assert.equal(meta.finish.complete, true)
    assert.ok(lines.length > 0)

    // 2. A pull request event creates a preview. Slow (about 20 s): the plugin
    //    is installed and boot-checked before two `dsh web` processes start.
    const event = JSON.stringify({
      action: 'opened',
      number: 1,
      pull_request: { head: { sha: head, ref: 'feature', repo: { full_name: 'acme/plugin' } } },
      repository: { full_name: 'acme/plugin', clone_url: repo.remote },
    })
    const delivered = await fetch(`${endpoint}/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'delivery-1',
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(event).digest('hex')}`,
      },
      body: event,
    })
    assert.equal(delivered.status, 202)
    const ready = await until('the preview to leave building', 180_000, async () => {
      const state = await preview()
      return state.state === 'building' ? undefined : state
    })
    assert.equal(ready.state, 'ready', `${JSON.stringify(ready)}\n${serviceLog}`)
    assert.equal(ready.headSha, head)
    const safe = await call('GET', new URL(String(ready.safeUrl)).pathname)
    assert.equal(safe.status, 200)
    assert.match(await safe.text(), /<!doctype html>/i)

    // 3. The comment commands, as the comment job runs them.
    const commandEnv = { ...env, GITHUB_TOKEN: 'ghs_stub', GITHUB_REPOSITORY: 'acme/plugin', GITHUB_API_URL: api.url }
    const comment = async (id: number, body: string): Promise<string> => {
      const result = await run(['comment', '--workdir', repo.work, '--body', body, '--comment-id', String(id), '--author', 'maintainer', '--association', 'OWNER', '--issue', '1'], commandEnv)
      assert.equal(result.status, 0, result.output)
      return result.output
    }
    const replies = (): string[] => github.issues.get(1)?.comments.map(entry => entry.body) ?? []

    const status = await comment(101, '/dsh-migrate status')
    assert.match(status, /Preview deployment: ready, built from `[0-9a-f]{8}`/)
    assert.match(status, new RegExp(`safe entry: \`${String(ready.safeUrl).replaceAll('.', '\\.')}\``))

    const before = await preview()
    assert.match(await comment(102, '/dsh-migrate extend'), /`extend` accepted/)
    const extended = await preview()
    assert.equal(Date.parse(String(extended.expiresAt)) - Date.parse(String(before.expiresAt)), 24 * 60 * 60 * 1000)
    // The same comment delivered again: no second reply and no second extension.
    await comment(102, '/dsh-migrate extend')
    assert.equal((await preview()).expiresAt, extended.expiresAt)
    assert.equal(replies().filter(reply => reply.includes('reply-to=102')).length, 1)

    // Slow (about 20 s): a rebuild of the same head.
    assert.match(await comment(103, '/dsh-migrate redeploy'), /`redeploy` accepted/)
    const rebuilt = await until('the redeploy to finish', 180_000, async () => {
      const state = await preview()
      return state.state === 'building' ? undefined : state
    })
    assert.deepEqual([rebuilt.state, rebuilt.headSha], ['ready', head])

    // Publish: a change made in the working copy reaches the pull request branch.
    const id = new URL(String(ready.url)).pathname.split('/')[2] ?? ''
    appendFileSync(join(dataDir, 'previews', id, 'work', 'src', 'index.js'), 'export const fromPreview = true\n')
    const published = await comment(104, '/dsh-migrate publish')
    assert.match(published, /`publish` landed\.\*\* Revision `r1-[0-9a-f]{12}` is on `feature`/)
    assert.match(repo.git(['show', 'feature:src/index.js'], repo.remote), /export const fromPreview = true/)
    // The outcome report is kept with its revision in the preview record.
    const record = JSON.parse(readFileSync(join(dataDir, 'previews', id, 'preview.json'), 'utf8')) as { revisions: Array<{ result?: Record<string, unknown> }> }
    const reported = record.revisions.at(-1)?.result ?? {}
    assert.equal(reported.outcome, 'published')
    assert.equal(reported.commit, repo.git(['rev-parse', 'feature'], repo.remote))
    assert.deepEqual(reported.checks, [{ check: 'mechanical', outcome: 'pass' }])

    assert.match(await comment(105, '/dsh-migrate destroy'), /`destroy` accepted/)
    assert.deepEqual(await preview(), { state: 'none' })
    assert.ok(!existsSync(join(dataDir, 'previews', id)))
    assert.deepEqual(readdirSync(join(dataDir, 'previews')), [])
  } finally {
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(children.map(async child => await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(undefined)
      else child.once('exit', resolve)
    })))
    await api.close()
    repo.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  }
})
