import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckRunner } from '../../src/activities/checks.ts'
import { SessionRunner } from '../../src/activities/sessions.ts'
import { syncUpgradeSkills } from '../../src/skills/upgrade.ts'
import { parseConfig } from '../../src/config/load.ts'
import { QuotaError } from '../../src/quota/errors.ts'
import { appRootFrom } from '../../src/paths.ts'
import { contextOf, input, settings } from '../support/migration.ts'
import type { AgentRequest, AgentRunner } from '../../src/agents/types.ts'
import type { MigrateConfig } from '../../src/config/schema.ts'
import type { QuotaQuery } from '../../src/quota/types.ts'

const RELEASE = { tag: 'dsh-v0.2.0', version: '0.2.0' }

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-activities-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"@acme/plugin","version":"1.0.0"}\n')
  return { dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

/** A valid plugin shape with no command at all, and nothing to install. */
function plugin(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  mkdirSync(join(dir, 'node_modules'))
}

test('a failing mechanical check keeps its errors for the repair and a bounded excerpt for the log', async () => {
  const { dir, cleanup } = scratch()
  try {
    plugin(dir)
    const config = parseConfig({ tests: { commands: [`node -e "console.log('noise\\n'.repeat(3000)); console.error('error TS2304: cannot find name'); process.exit(1)"`] } })
    const runner = new CheckRunner({ workdir: dir, config, cacheDir: join(dir, 'cache'), runDir: join(dir, 'run') })
    const result = await runner.run({ activity: 'check', check: 'mechanical', release: 'target', e2eBaseline: [] }, RELEASE)
    assert.equal(result.outcome, 'fail')
    assert.equal(result.fingerprint, 'mechanical: error TS2304: cannot find name')
    assert.ok(result.detail.length <= 2_001)
    assert.match(runner.lastFailure?.output ?? '', /error TS2304/)
    assert.doesNotMatch(runner.lastFailure?.output ?? '', /noise/)
    assert.deepEqual(readdirSync(join(dir, 'run', 'checks')), ['01-mechanical.log'])
  } finally {
    cleanup()
  }
})

test('a plugin that declares no command is a skipped mechanical check, not a pass', async () => {
  const { dir, cleanup } = scratch()
  try {
    plugin(dir)
    const runner = new CheckRunner({ workdir: dir, config: parseConfig({}), cacheDir: join(dir, 'cache'), runDir: join(dir, 'run') })
    const result = await runner.run({ activity: 'check', check: 'mechanical', release: 'target', e2eBaseline: [] }, RELEASE)
    assert.equal(result.outcome, 'skipped')
  } finally {
    cleanup()
  }
})

test('a source release that does not install leaves the baseline unknown; a target release that does not is an error', async () => {
  const { dir, cleanup } = scratch()
  const path = process.env.PATH
  try {
    plugin(dir)
    mkdirSync(join(dir, 'bin'))
    // The registry answers when each release was published; the install itself fails.
    writeFileSync(join(dir, 'bin', 'npm'), '#!/bin/sh\nif [ "$1" = view ]; then echo \'{"0.0.1-rc.1":"2026-01-01T00:00:00.000Z","0.2.0":"2026-09-01T00:00:00.000Z"}\'; exit 0; fi\necho "npm error ERESOLVE could not resolve" >&2\nexit 1\n', { mode: 0o755 })
    process.env.PATH = `${join(dir, 'bin')}:${path ?? ''}`
    const runner = new CheckRunner({ workdir: dir, config: parseConfig({}), cacheDir: join(dir, 'cache'), runDir: join(dir, 'run') })
    const source = await runner.run({ activity: 'check', check: 'boot', release: 'source', e2eBaseline: [] }, { tag: 'dsh-v0.0.1-rc.1', version: '0.0.1-rc.1' })
    assert.equal(source.outcome, 'skipped')
    assert.match(source.detail, /could not install dsh 0\.0\.1-rc\.1 for the checks: npm error ERESOLVE/)
    await assert.rejects(runner.run({ activity: 'check', check: 'boot', release: 'target', e2eBaseline: [] }, RELEASE), /could not install dsh 0\.2\.0/)
  } finally {
    process.env.PATH = path
    cleanup()
  }
})

function sessions(config: MigrateConfig, agent: AgentRunner, quota?: QuotaQuery, cardsDir?: string) {
  const { dir, cleanup } = scratch()
  const runner = new SessionRunner({
    workdir: dir,
    config,
    apiKey: 'sk-test',
    agent,
    quota,
    runDir: join(dir, 'run'),
    harnessDir: join(dir, 'missing-harness'),
    syncSkills: () => {},
    log: () => {},
    lastFailure: () => 'error TS2304: cannot find name',
    cardsDir,
  })
  // No harness checkout in a unit test: the sessions run without one.
  ;(runner as unknown as { harness: null }).harness = null
  return { runner, dir, cleanup }
}

const repairRequest = { activity: 'session' as const, kind: 'repair' as const, attempt: 1 }

test('a repair session gets the reviews and the failing output, and its report is kept', async () => {
  const requests: AgentRequest[] = []
  const agent: AgentRunner = { run: async (request) => {
    requests.push(request)
    return { report: `# ${request.kind}`, raw: '', usage: { turns: 1, steps: 1, elapsedSeconds: 1, inputTokens: 10, outputTokens: 5, cacheHitTokens: 2, cacheMissTokens: 8, costUsd: 0.25 } }
  } }
  const { runner, dir, cleanup } = sessions(parseConfig({}), agent)
  try {
    const context = contextOf(input(), [])
    await runner.run({ activity: 'session', kind: 'overlap', attempt: 0 }, context)
    await runner.run({ activity: 'session', kind: 'extension-points', attempt: 0 }, context)
    const repair = await runner.run(repairRequest, context)
    assert.match(requests[2]?.prompt ?? '', /# overlap[\s\S]*# extension-points[\s\S]*error TS2304/)
    assert.deepEqual([...repair.files.keys()], ['reports/repair-1.md'])
    assert.equal(readFileSync(join(dir, 'run', 'reports', 'repair-1.md'), 'utf8'), '# repair')
    assert.equal(repair.event.type === 'session.done' && repair.event.usage?.usd, 0.25)
    assert.equal(runner.spent, 0.75)
  } finally {
    cleanup()
  }
})

test('the extension-point review is given the change cards of the span, and the ledger it keeps goes to the state branch', async () => {
  const references = join(appRootFrom(import.meta.url), 'vendor', 'dsh-plugin-upgrade-skill', 'skills', 'plugin-upgrade', 'references')
  let ledgerPath = ''
  const agent: AgentRunner = { run: async (request) => {
    ledgerPath = /at `([^`]+cards\.json)`/.exec(request.prompt)?.[1] ?? ''
    writeFileSync(ledgerPath, '{"cards":[]}')
    return { report: '# extension points', raw: '' }
  } }
  const { runner, cleanup } = sessions(parseConfig({}), agent, undefined, references)
  try {
    const context = contextOf(input('0.1.2-alpha.2', { source: { release: { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' }, origin: 'declared-peers' }, settings: settings({ checks: { cards: true, boot: false, web: false, e2e: false } }) }), [])
    const review = await runner.run({ activity: 'session', kind: 'extension-points', attempt: 0 }, context)
    assert.notEqual(ledgerPath, '', 'the prompt names the ledger')
    assert.equal(review.files.get('cards.json'), '{"cards":[]}')
  } finally {
    cleanup()
  }
})

test('a blocker with every evidence field stops the loop; an incomplete one does not', async () => {
  const valid = 'BLOCKER: upstream\nREASON: no slot\nATTEMPTED: tried a shim\nHARNESS: packages/x.ts:10\nWHY-NOT-PLUGIN: the slot is private\n'
  for (const [report, expected] of [[valid, 'valid'], ['BLOCKER: upstream\nREASON: hard\n', 'incomplete'], ['fixed it', 'none']] as const) {
    const { runner, cleanup } = sessions(parseConfig({}), { run: async () => ({ report, raw: report }) })
    try {
      const result = await runner.run(repairRequest, contextOf(input(), []))
      assert.equal(result.event.type === 'session.done' && result.event.blocker, expected)
    } finally {
      cleanup()
    }
  }
})

test('the spend cap stops a session before it starts, and a cap the session hits is the same outcome', async () => {
  const quota: QuotaQuery = { provider: 'deepseek-official', query: async () => ({ kind: 'available', provider: 'deepseek-official', queriedAt: '' }) }
  let ran = 0
  const agent: AgentRunner = { run: async () => {
    ran += 1
    return { report: 'r', raw: '', usage: { turns: 1, steps: 1, elapsedSeconds: 1, inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, costUsd: 3 } }
  } }
  const { runner, cleanup } = sessions(parseConfig({ quota: { limit: 2 } }), agent, quota)
  try {
    const first = await runner.run(repairRequest, contextOf(input(), []))
    assert.equal(first.event.type === 'session.done' && first.event.outcome, 'completed')
    const second = await runner.run(repairRequest, contextOf(input(), []))
    assert.equal(second.event.type === 'session.done' && second.event.outcome, 'spend-cap')
    assert.equal(ran, 1)
  } finally {
    cleanup()
  }
  const capped = sessions(parseConfig({}), { run: async () => { throw new QuotaError('limit_exceeded', 'quota limit exceeded') } })
  try {
    const result = await capped.runner.run(repairRequest, contextOf(input(), []))
    assert.equal(result.event.type === 'session.done' && result.event.outcome, 'spend-cap')
  } finally {
    capped.cleanup()
  }
})

test('a session that crashes is a failed session with the reason', async () => {
  const { runner, cleanup } = sessions(parseConfig({}), { run: async () => { throw new Error('dsh agent failed (1): boom') } })
  try {
    const result = await runner.run(repairRequest, contextOf(input(), []))
    assert.equal(result.event.type === 'session.done' && result.event.outcome, 'failed')
    assert.match(result.event.type === 'session.done' ? result.event.detail : '', /boom/)
  } finally {
    cleanup()
  }
})

test('the upgrade skills are loaded into and removed from the agent runtime home only', () => {
  const { dir, cleanup } = scratch()
  try {
    const source = join(dir, 'vendor')
    for (const name of ['plugin-upgrade', 'dsh-benchmark-case']) {
      mkdirSync(join(source, name), { recursive: true })
      writeFileSync(join(source, name, 'SKILL.md'), name)
    }
    const home = join(dir, 'home')
    mkdirSync(join(home, 'skills', 'my-own'), { recursive: true })
    syncUpgradeSkills({ dshHome: home, enabled: true, source })
    assert.deepEqual(readdirSync(join(home, 'skills')).sort(), ['my-own', 'plugin-upgrade'])
    syncUpgradeSkills({ dshHome: home, enabled: false, source })
    assert.deepEqual(readdirSync(join(home, 'skills')), ['my-own'])
    assert.throws(() => syncUpgradeSkills({ dshHome: home, enabled: true, source: join(dir, 'nowhere') }), /plugin-upgrade not found/)
    assert.equal(existsSync(join(home, 'skills', 'my-own')), true)
  } finally {
    cleanup()
  }
})

test('a tree whose plugins all have a browser half leaves the boot check to the web check', async () => {
  const { dir, cleanup } = scratch()
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/web', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }))
    mkdirSync(join(dir, 'cache', 'dsh-0.2.0', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'cache', 'dsh-0.2.0', 'bin', 'dsh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const runner = new CheckRunner({ workdir: dir, config: parseConfig({}), cacheDir: join(dir, 'cache'), runDir: join(dir, 'run') })
    const result = await runner.run({ activity: 'check', check: 'boot', release: 'target', e2eBaseline: [] }, RELEASE)
    assert.equal(result.outcome, 'skipped')
    assert.match(result.detail, /web check loads them/)
  } finally {
    cleanup()
  }
})
