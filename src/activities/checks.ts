import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMechanical } from '../mechanical/run.ts'
import { declaresClient, findPlugins } from '../plugins.ts'
import { bootProbe, normalizeSignature } from '../verify/boot.ts'
import { ensureDsh } from '../verify/dsh-install.ts'
import { hasClientSurface, webSmoke } from '../verify/web.ts'
import { runE2E } from '../e2e/run.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { ActivityRequest } from '../workflow/machine.ts'
import type { CheckName, CheckResult, Release } from '../workflow/model.ts'

/**
 * The check activity: one of the four checks on the working tree, against one
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
}

export interface CheckDeps {
  workdir: string
  config: MigrateConfig
  /** One cached dsh installation per release. */
  cacheDir: string
  /** Where full outputs are kept for this run. */
  runDir: string
}

export class CheckRunner {
  private e2eFailing: string[] = []
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
    }
  }

  /** The dsh binary of a release, or why it could not be installed. */
  private install(release: Release): { bin: string } | { failure: string } {
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
      case 'mechanical': {
        // Every plugin is checked, so a repair is given every failure at once.
        const found = findPlugins(workdir)
        // A tree with no plugin is checked at its root, where the shape scan says what it lacks.
        const plugins = found.length === 0 ? [{ dir: '', name: '' }] : found
        const named = plugins.length > 1
        const results = plugins.map(plugin => ({ plugin, result: runMechanical(join(workdir, plugin.dir), config, { dshVersion: release.version, timeoutMs: config.timeouts.commandMs }) }))
        const failed = results.filter(({ result }) => !result.ok)
        if (failed.length > 0) {
          const first = failed[0] as (typeof failed)[number]
          const firstError = first.result.errors.split('\n').find(line => line.trim() !== '') ?? 'mechanical checks failed'
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
        const run = runE2E({
          workdir,
          branch: config.checks.e2e.branch,
          mode: request.e2eScope,
          failing: this.e2eFailing,
          worktreeDir: join(this.deps.runDir, 'e2e-worktree'),
          timeoutMs: config.timeouts.commandMs,
        })
        this.e2eFailing = run.failedTests
        if (run.skipped !== undefined) return { outcome: 'skipped', fingerprint: '', output: run.skipped }
        return { outcome: run.ok ? 'pass' : 'fail', fingerprint: run.signature, output: run.detail }
      }
    }
  }
}
