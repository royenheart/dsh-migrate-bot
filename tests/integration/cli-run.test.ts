import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { appRootFrom } from '../../src/paths.ts'
import { StateStore } from '../../src/state/store.ts'
import { checkout } from '../support/repository.ts'
import { FakeGitHub } from '../support/github.ts'
import { serve } from '../support/serve.ts'

/**
 * The whole CLI, end to end: a migration runs to a proposal, and the merge of
 * that proposal is reported. The agent runtime is a stub that answers like dsh
 * (`DSH_BIN`), and GitHub is the in-memory fake served over HTTP; the state
 * branch is a real git remote.
 */

const CLI = join(appRootFrom(import.meta.url), 'dist', 'src', 'cli.js')

const STUB = `#!/usr/bin/env node
const task = process.env.DSH_MIGRATE_TASK ?? ''
if (!process.env.DEEPSEEK_API_KEY) {
  process.stderr.write('dsh-migrate: MISSING_CREDENTIAL: llm-deepseek: no API key\\n')
  process.exit(1)
}
process.stderr.write('dsh-migrate-status: ' + JSON.stringify({ turns: 1, steps: 2, elapsedSeconds: 1, inputTokens: 100, outputTokens: 50, cacheHitTokens: 10, cacheMissTokens: 90, costUsd: 0.01 }) + '\\n')
const fs = require('node:fs')
if (task.includes('Output contract')) {
  process.stdout.write('Findings.\\n\\n\`\`\`json\\n{"title":"Clean migration","body":"## Run\\\\nnothing to report"}\\n\`\`\`\\n')
} else if (task.includes('extension points of a harness release')) {
  fs.appendFileSync('index.js', 'export const migrated = true\\n')
  process.stdout.write('# Extension points\\n\\n## 3. Edits you made\\nadded an export\\n')
} else {
  process.stdout.write('# Overlap\\n\\n## 3. Decision\\nkeep\\n')
}
`

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('close', (status) => { resolve({ status, output }) })
  })
}

test('a migration runs to a proposal, and its merge is reported to the enabled channel', async () => {
  const repo = checkout({
    'package.json': JSON.stringify({ name: '@acme/plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.7' } }),
    'cordis.patch.yml': '[]\n',
    'index.js': 'export const apply = () => {}\n',
  })
  const github = new FakeGitHub('acme/plugin')
  const server = await serve(github.fetch)
  try {
    mkdirSync(join(repo.work, '.github'))
    writeFileSync(join(repo.work, '.github', 'dsh-migrate.yml'), [
      'agent:',
      '  provider: stub',
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
      'reports:',
      '  channels:',
      '    migrate-bot:',
      '      enabled: true',
      '',
    ].join('\n'))
    repo.git(['add', '-A'])
    repo.git(['commit', '--quiet', '-m', 'config'])
    repo.git(['push', '--quiet', 'origin', 'HEAD:main'])
    mkdirSync(join(repo.work, 'node_modules'))
    const stub = join(repo.work, '..', 'dsh-stub.cjs')
    writeFileSync(stub, STUB, { mode: 0o755 })
    // No network: npm is a stub that installs nothing, and the harness checkout
    // is already the target's, which the checkout reuses.
    const bin = join(repo.work, '..', 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const home = join(repo.work, '..', 'home')
    mkdirSync(join(home, 'harness', '.git'), { recursive: true })
    writeFileSync(join(home, 'harness', '.dsh-migrate-tag'), 'dsh-v0.2.0\n')
    const output = join(repo.work, '..', 'github-output')
    writeFileSync(output, '')
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      DSH_BIN: stub,
      DSH_MIGRATE_HOME: home,
      DEEPSEEK_API_KEY_DSH_MIGRATE_BOT: 'sk-stub',
      GITHUB_TOKEN: 'ghs_stub',
      GITHUB_REPOSITORY: 'acme/plugin',
      GITHUB_API_URL: server.url,
      GITHUB_OUTPUT: output,
      DSH_MIGRATE_REPORT_BOT_TOKEN: 'ghp_stub',
    }

    const migrated = await run(['run', '--workdir', repo.work, '--target', '0.2.0'], env)
    assert.equal(migrated.status, 0, migrated.output)
    assert.match(readFileSync(output, 'utf8'), /status=proposed/)
    const pull = [...github.pulls.values()][0]
    assert.equal(pull?.head.ref, 'dsh-migrate/proposal')
    assert.match(repo.git(['show', 'dsh-migrate/proposal:index.js'], repo.remote), /export const migrated = true/)
    const issue = [...github.issues.values()][0]
    assert.match(issue?.body ?? '', /Source release: `dsh-v0\.1\.7` \(declared-peers\)/)
    assert.match(issue?.body ?? '', /## Overlap review[\s\S]*### Decision\n\nkeep/)

    const skipped = await run(['run', '--workdir', repo.work, '--target', '0.2.0'], env)
    assert.equal(skipped.status, 0)
    assert.match(skipped.output, /skipped \(unchanged-release\)/)

    const merged = await run(['pull-request-closed', '--workdir', repo.work, '--number', String(pull?.number), '--merged', 'true'], env)
    assert.equal(merged.status, 0, merged.output)
    assert.deepEqual(github.external.map(report => [report.repo, report.title]), [['royenheart/dsh-migrate-bot', 'Clean migration']])

    const state = new StateStore(repo.clone()).read()
    const log = state.logs.get('0.2.0') ?? []
    assert.deepEqual(log.filter(entry => entry.kind === 'event').map(entry => entry.kind === 'event' ? entry.event.type : ''), [
      'session.done', 'session.done', 'check.done', 'tree.inspected', 'proposal.published', 'pull-request.closed', 'report.done',
    ])
    assert.match(repo.git(['show', 'dsh-migrate/state:badge.json'], repo.remote), /"message": "dsh-v0\.2\.0"/)
  } finally {
    await server.close()
    repo.cleanup()
  }
})
