import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMechanical } from '../mechanical/run.ts'
import { cardsInSpan, checkLedger, ledgerPathOf, ledgerSchema, renderCardList, type CardLedger } from '../skills/cards.ts'
import { declaresClient, findPlugins } from '../plugins.ts'
import { bootProbe, normalizeSignature } from '../verify/boot.ts'
import { errorSummary } from '../mechanical/errors.ts'
import { ensureDsh, publishedAt, releaseCutoff } from '../verify/dsh-install.ts'
import { hasClientSurface, startWebHost, webSmoke } from '../verify/web.ts'
import { readSuite, runSuite, type SuiteRun } from '../e2e/suite.ts'
import { suiteDirOf } from './e2e-suite.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { ActivityRequest } from '../workflow/machine.ts'
import type { CheckName, CheckResult, Release } from '../workflow/model.ts'

/**
 * The check activity: one of the checks on the working tree, against one
 * release. Every check is keyless.
 *
 * The result in the event log carries a bounded excerpt; the full output is
 * kept in the run directory, because the repair session that follows a failure
 * is given that output and nothing else.
 */

const EXCERPT = 2_000

export interface CheckOutput {
  outcome: CheckResult['outcome']
  fingerprint: string
  /** The full output, or why the check was skipped. */
  output: string
  blame?: CheckResult['blame']
}

export interface CheckDeps {
  workdir: string
  config: MigrateConfig
  /** One cached dsh installation per release. */
  cacheDir: string
  /** Where full outputs are kept for this run. */
  runDir: string
  /** The upgrade skill's release files (`references/`), for the cards check. */
  cardsDir?: string | undefined
}

export class CheckRunner {
  private sequence = 0
  /** The full output of the last failing check, for the next repair session. */
  lastFailure: { check: CheckName; output: string } | undefined

  constructor(private readonly deps: CheckDeps) {}

  async run(request: Extract<ActivityRequest, { activity: 'check' }>, release: Release): Promise<CheckResult> {
    const output = await this.execute(request, release)
    this.sequence += 1
    const dir = join(this.deps.runDir, 'checks')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${String(this.sequence).padStart(2, '0')}-${request.check}.log`), output.output)
    if (output.outcome === 'fail') this.lastFailure = { check: request.check, output: output.output }
    return {
      check: request.check,
      outcome: output.outcome,
      fingerprint: output.outcome === 'fail' ? output.fingerprint : '',
      detail: output.output.length <= EXCERPT ? output.output : `…${output.output.slice(-EXCERPT)}`,
      ...(output.outcome === 'fail' && output.blame !== undefined ? { blame: output.blame } : {}),
    }
  }

  /** The dsh binary of a release, or why it could not be installed. */
  install(release: Release): { bin: string } | { failure: string } {
    const installed = ensureDsh(release.version, this.deps.cacheDir, { timeoutMs: this.deps.config.timeouts.commandMs })
    return installed.ok && installed.bin !== undefined ? { bin: installed.bin } : { failure: `could not install dsh ${release.version} for the checks: ${installed.detail}` }
  }

  /** The target release must install: without it no check can run, which is not a verdict on the plugin. */
  private dsh(release: Release): string {
    const installed = this.install(release)
    if ('failure' in installed) throw new Error(installed.failure)
    return installed.bin
  }

  private async execute(request: Extract<ActivityRequest, { activity: 'check' }>, release: Release): Promise<CheckOutput> {
    const { workdir, config } = this.deps
    switch (request.check) {
      case 'cards': {
        const source = request.source
        if (source === undefined) return { outcome: 'skipped', fingerprint: '', output: 'no source release is known, so no span of change cards' }
        const cards = this.deps.cardsDir === undefined ? [] : cardsInSpan(this.deps.cardsDir, source, release.version)
        if (cards.length === 0) return { outcome: 'skipped', fingerprint: '', output: `the upgrade skill has no change card after ${source} up to ${release.version}` }
        const path = ledgerPathOf(this.deps.runDir)
        const parsed = existsSync(path) ? safeLedger(readFileSync(path, 'utf8')) : { error: `no card ledger at ${path}` }
        if ('error' in parsed) return { outcome: 'fail', fingerprint: `cards: ${normalizeSignature(parsed.error)}`, output: `${parsed.error}\n\n${renderCardList(cards)}` }
        const problems = checkLedger(cards, parsed.ledger, file => existsSync(join(workdir, file)))
        if (problems.length > 0) {
          const byId = new Map(cards.map(card => [card.id, card]))
          return {
            outcome: 'fail',
            fingerprint: `cards: ${problems.map(problem => problem.id).sort().join(' ').slice(0, 300)}`,
            output: `The card ledger (${path}) falls short:\n${problems.map(problem => `- ${problem.id} (${byId.get(problem.id)?.title ?? ''}): ${problem.problem}. Recipe: ${byId.get(problem.id)?.recipe ?? ''}`).join('\n')}`,
          }
        }
        const done = parsed.ledger.cards.filter(entry => entry.status === 'done').length
        return { outcome: 'pass', fingerprint: '', output: `${String(cards.length)} card(s) after ${source} up to ${release.version}: ${String(done)} done, the rest not needed` }
      }
      case 'mechanical': {
        // Every plugin is checked, so a repair is given every failure at once.
        const found = findPlugins(workdir)
        // A tree with no plugin is checked at its root, where the shape scan says what it lacks.
        const plugins = found.length === 0 ? [{ dir: '', name: '' }] : found
        const named = plugins.length > 1
        // Pinned as the release was published: a prerelease's own packages otherwise resolve their peers to a later prerelease of the line.
        const published = publishedAt(release.version, config.timeouts.commandMs)
        const before = published === undefined ? undefined : releaseCutoff(published)
        const results = plugins.map(plugin => ({ plugin, result: runMechanical(join(workdir, plugin.dir), config, { dshVersion: release.version, timeoutMs: config.timeouts.commandMs, before }) }))
        const failed = results.filter(({ result }) => !result.ok)
        if (failed.length > 0) {
          const first = failed[0] as (typeof failed)[number]
          const firstError = errorSummary(first.result.errors) || 'mechanical checks failed'
          return {
            outcome: 'fail',
            fingerprint: `mechanical: ${named ? `${first.plugin.name}: ` : ''}${normalizeSignature(firstError)}`,
            output: failed.map(({ plugin, result }) => `${named ? `## ${plugin.name} (${plugin.dir})\n` : ''}${result.errors || result.log}`).join('\n\n'),
          }
        }
        if (results.every(({ result }) => result.checks === 0)) {
          return { outcome: 'skipped', fingerprint: '', output: 'no plugin declares a build, typecheck or test command' }
        }
        return { outcome: 'pass', fingerprint: '', output: results.map(({ result }) => result.log).join('\n') }
      }
      case 'boot': {
        const installed = this.install(release)
        if ('failure' in installed) {
          // A source release that no longer installs leaves the baseline
          // unknown; the migration goes on without it.
          if (request.release === 'source') return { outcome: 'skipped', fingerprint: '', output: installed.failure }
          throw new Error(installed.failure)
        }
        // A plugin with a browser half may need services only the web
        // composition provides; the web check loads it there.
        const plugins = findPlugins(workdir)
        const headless = plugins.filter(plugin => !declaresClient(plugin))
        if (plugins.length > 0 && headless.length === 0) {
          return { outcome: 'skipped', fingerprint: '', output: 'every plugin has a browser half (dsh.client); the web check loads them in the web composition' }
        }
        const probe = await bootProbe({ workdir, bin: installed.bin, dshTag: release.tag, timeoutMs: config.checks.boot.timeoutMs, plugins: headless.length > 0 ? headless : undefined })
        return { outcome: probe.outcome === 'pass' ? 'pass' : 'fail', fingerprint: probe.signature, output: probe.detail }
      }
      case 'web': {
        if (!hasClientSurface(workdir)) return { outcome: 'skipped', fingerprint: '', output: 'the plugin declares no dsh.client surface' }
        const smoke = await webSmoke({ workdir, bin: this.dsh(release), timeoutMs: config.checks.web.timeoutMs, dshTag: release.tag })
        if (smoke.skipped !== undefined) return { outcome: 'skipped', fingerprint: '', output: smoke.skipped }
        return { outcome: smoke.ok ? 'pass' : 'fail', fingerprint: smoke.signature, output: smoke.detail }
      }
      case 'e2e': {
        // The suite the baseline was recorded with, or the one on the branch.
        const suiteDir = suiteDirOf(this.deps.runDir)
        const present = existsSync(join(suiteDir, 'package.json'))
          || readSuite({ workdir, branch: config.checks.e2e.branch, dir: config.checks.e2e.dir, dest: suiteDir })
        if (!present) return { outcome: 'skipped', fingerprint: '', output: `no suite on ${config.checks.e2e.branch} yet` }
        const served = await startWebHost({ workdir, bin: this.dsh(release), timeoutMs: config.checks.web.timeoutMs, dshTag: release.tag })
        if (!served.ok) return { outcome: 'fail', fingerprint: served.failure.signature, output: served.failure.detail }
        let run: SuiteRun
        try {
          run = runSuite({ suiteDir, webUrl: served.host.url, timeoutMs: config.timeouts.commandMs })
        } finally {
          served.host.stop()
        }
        if (run.error !== undefined) return { outcome: 'fail', fingerprint: `e2e: ${normalizeSignature(run.error)}`, output: `${run.error}\n${run.output}` }
        // With a baseline, a test fails the check when it passed on the source release and does not pass now.
        const baseline = request.e2eBaseline
        const broken = baseline.length > 0 ? baseline.filter(id => !run.passed.includes(id)) : run.failed
        if (broken.length === 0) return { outcome: 'pass', fingerprint: '', output: `${String(run.passed.length)} test(s) passed` }
        const heading = baseline.length > 0 ? 'These tests passed on the source release and do not pass now:' : 'These tests fail:'
        // A failure in a check step is the plugin's; one on the way there through the host's UI, or one that cannot be placed, is not shown to be.
        const blame = broken.some(id => run.phases[id] === 'check') ? 'plugin' : 'host'
        const where = (id: string): string => ` (failed in ${run.phases[id] === 'check' ? 'a check step' : run.phases[id] === 'reach' ? 'a reach step, on the way through the host\'s UI' : 'no step'})`
        return { outcome: 'fail', blame, fingerprint: `e2e: ${[...broken].sort().join(' | ').slice(0, 300)}`, output: `${heading}\n${broken.map(id => `- ${id}${where(id)}${run.errors[id] === undefined ? '' : `: ${run.errors[id]}`}`).join('\n')}\n\n${run.output}` }
      }
    }
  }
}

function safeLedger(text: string): { ledger: CardLedger } | { error: string } {
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(text))
    return parsed.success ? { ledger: parsed.data } : { error: `the card ledger does not match its schema: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` }
  } catch (error) {
    return { error: `the card ledger is not JSON: ${(error as Error).message}` }
  }
}
