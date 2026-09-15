/**
 * The gate stack, in one place, so a change is verified the same way whichever
 * path hands it to a branch.
 *
 * A migration pull request and a published preview diff are the same kind of
 * object: a tree somebody proposes for a branch. [The gate policy] says which
 * layers run and which of them refuse, and everything that publishes goes
 * through here rather than deciding for itself.
 *
 * [The gate policy]: ../../docs/design/preview-and-live-view.md#7-gate-policy
 */

import { runMechanical } from '../mechanical/run.ts'

/** An error as a sentence a report can carry. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The first line of somebody else's output, for a refusal that has to say why.
 *
 * The suite's failure text is the answer a user is looking for, and it is also
 * text the plugin wrote: one line of it, bounded, so it can be read in a reply.
 * @param output - the failing layer's output.
 */
function firstLine(output: string): string {
  const line = output.split('\n').map(entry => entry.trim()).find(entry => entry !== '')
  return line === undefined ? 'no output' : inline(line, 200)
}
import { bootProbe, type BootProbeResult } from './boot.ts'
import { ensureDsh } from './dsh-install.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { VerificationResult } from '../pipeline/types.ts'
import { inline } from '../render/text.ts'

/** One layer's verdict, as the reply and the report render it. */
export interface GateStep {
  layer: 'mechanical' | 'boot' | 'web' | 'e2e'
  ok: boolean
  detail: string
  /** Present when the layer did not apply, and why. */
  skipped?: string
}

export interface GateReport {
  ok: boolean
  steps: GateStep[]
  /** The layer that refused, when one did. */
  refusedBy?: 'mechanical' | 'boot' | 'web' | 'e2e'
  /** What the boot probe and the mechanical layer were run against, once known. */
  tag?: string
  detail: string
}

export interface GateRunnerInput {
  config: MigrateConfig
  /**
   * The tag this change is verified against, as `dsh-v…` or a bare version.
   *
   * A resolver is accepted for the case where nothing is recorded yet: a
   * publish on a repository whose first migration has not been recorded cannot
   * name the harness from its own state, and installing whatever npm calls
   * `latest` while reporting the tag as `latest` is not a verification of
   * anything. Resolution happens when the boot layer runs, and a resolution that
   * fails refuses the gate with its own reason.
   */
  dshTag: string | (() => Promise<string>)
  /** Where the cached dsh binaries live. */
  dshCache: string
  log: (message: string) => void
  /** Injectable layers, so the policy is testable without a harness install. */
  mechanical?: ((tree: string) => { ok: boolean; errors?: string; log?: string; checks?: number } | Promise<{ ok: boolean; errors?: string; log?: string; checks?: number }>) | undefined
  boot?: ((tree: string) => Promise<BootProbeResult>) | undefined
  e2e?: ((tree: string) => VerificationResult | Promise<VerificationResult>) | undefined
  /**
   * The client-surface boot smoke, which the pipeline runs and a publish must too.
   *
   * It is given the tag the rest of the stack is verifying against, so one run
   * cannot probe two harnesses: a resolver that answers `dsh-v0.1.9` and a web
   * layer that installed `latest` would report a verification nobody performed.
   */
  web?: ((tree: string, tag: string) => VerificationResult | Promise<VerificationResult>) | undefined
}

/**
 * Build the runner a publishing path calls with the tree it wants verified.
 *
 * The three layers are the same three the migration pipeline uses: the plugin's
 * own mechanical suite, the keyless boot probe, and the end-to-end suite under
 * whichever gate `e2e.gate` names. The first two refuse; the third refuses only
 * when it is configured to.
 * @param input - the config, the tag, and where the harness binary is cached.
 */
export function createGateRunner(input: GateRunnerInput): (tree: string) => Promise<GateReport> {
  const { config } = input
  // Resolved once per runner, and only when a layer actually needs it: a verb
  // that never reaches this runner must not pay for a release lookup.
  let resolved: Promise<string> | undefined
  const tag = (): Promise<string> => {
    if (resolved === undefined) {
      resolved = typeof input.dshTag === 'string' ? Promise.resolve(input.dshTag) : input.dshTag()
    }
    return resolved
  }
  const mechanical = input.mechanical
    ?? (async (tree: string) => runMechanical(tree, config, {
      dshVersion: (await tag()).replace(/^dsh-v/, ''),
      timeoutMs: config.timeouts.commandMs,
    }))
  const boot = input.boot
    ?? (async (tree: string): Promise<BootProbeResult> => {
      const dshTag = await tag()
      const installed = ensureDsh(dshTag.replace(/^dsh-v/, ''), input.dshCache, {
        timeoutMs: config.timeouts.commandMs,
      })
      if (!installed.ok || installed.bin === undefined) {
        return { outcome: 'fail', signature: `probe unavailable: ${installed.detail}`, detail: installed.detail }
      }
      return await bootProbe({
        workdir: tree,
        bin: installed.bin,
        dshTag,
        timeoutMs: config.verify.boot.timeoutMs,
      })
    })

  return async (tree: string): Promise<GateReport> => {
    const steps: GateStep[] = []
    /** Whether any layer produced a verdict about the tree rather than skipping. */
    let executed = false

    // The harness version is resolved once, before anything runs: the mechanical
    // layer pins its peers to it and the boot probe installs it, and a failure to
    // resolve is a failure of the whole stack rather than of one layer — which is
    // what a lazy resolution reported it as.
    let against: string
    try {
      against = await tag()
    } catch (error) {
      return {
        ok: false,
        steps,
        detail: inline(`the harness version to verify against could not be resolved: ${message(error)}`, 300),
      }
    }

    input.log('gates: mechanical')
    let fast: { ok: boolean; errors?: string; log?: string; checks?: number }
    try {
      fast = await mechanical(tree)
    } catch (error) {
      // A gate that cannot run is a refusal, never a pass: the whole point of
      // this runner is that nothing reaches a branch unverified.
      return {
        ok: false,
        steps: [{ layer: 'mechanical', ok: false, detail: message(error) }],
        refusedBy: 'mechanical',
        tag: against,
        detail: inline(`the mechanical suite could not run: ${message(error)}`, 300),
      }
    }
    steps.push({
      layer: 'mechanical',
      ok: fast.ok,
      detail: fast.ok ? 'passed' : (fast.errors ?? fast.log ?? 'failed').slice(0, 1500),
    })
    if (!fast.ok) {
      return {
        ok: false,
        steps,
        refusedBy: 'mechanical',
        tag: against,
        detail: inline(`the plugin's own test command failed: ${firstLine(fast.errors ?? fast.log ?? '')}`, 300),
      }
    }
    // A plugin with no build, typecheck or test command runs only its installs,
    // which is not evidence that anything works.
    if ((fast.checks ?? 0) > 0) executed = true

    if (config.verify.boot.enabled) {
      input.log('gates: boot probe')
      let probed: BootProbeResult
      try {
        probed = await boot(tree)
      } catch (error) {
        return {
          ok: false,
          steps: [...steps, { layer: 'boot', ok: false, detail: message(error) }],
          refusedBy: 'boot',
          tag: against,
          detail: inline(`the boot probe could not run: ${message(error)}`, 300),
        }
      }
      // Only `pass` is a load that was observed. A probe that timed out says
      // nothing about the plugin, and counting it as loaded is how a hung boot
      // would reach a branch.
      const ok = probed.outcome === 'pass'
      executed = true
      steps.push({
        layer: 'boot',
        ok,
        detail: ok
          ? `loaded (${probed.signature})`
          : probed.outcome === 'timeout'
            ? `the probe did not finish (${probed.signature})`
            : probed.detail.slice(0, 1500),
      })
      if (!ok) {
        return {
          ok: false,
          steps,
          refusedBy: 'boot',
          tag: against,
          detail: inline(
            probed.outcome === 'timeout'
              ? `the boot probe did not finish, so the plugin was never observed to load: ${probed.signature}`
              : `the plugin does not load: ${probed.signature}`,
            300,
          ),
        }
      }
    } else {
      steps.push({ layer: 'boot', ok: true, detail: '', skipped: 'verify.boot.enabled is false' })
    }

    if (config.verify.web.enabled && input.web !== undefined) {
      input.log('gates: web smoke')
      let smoke: VerificationResult
      try {
        smoke = await input.web(tree, against)
      } catch (error) {
        return {
          ok: false,
          steps: [...steps, { layer: 'web', ok: false, detail: message(error) }],
          refusedBy: 'web',
          tag: against,
          detail: inline(`the web smoke could not run: ${message(error)}`, 300),
        }
      }
      // A layer that skipped did not look at the tree: only a verdict counts as
      // one having run.
      if (smoke.skipped === undefined) executed = true
      steps.push({
        layer: 'web',
        ok: smoke.ok,
        detail: smoke.ok ? smoke.signature : smoke.detail.slice(0, 1500),
        ...(smoke.skipped === undefined ? {} : { skipped: smoke.skipped }),
      })
      if (!smoke.ok) {
        return {
          ok: false,
          steps,
          refusedBy: 'web',
          tag: against,
          detail: inline(`the web smoke failed: ${smoke.signature}`, 300),
        }
      }
    } else if (config.verify.web.enabled) {
      // The web smoke is not a configured gate the way `e2e.gate` is, so a
      // caller that cannot run it says so in the report rather than refusing:
      // the publish path always provides it, and a report that names the gap is
      // better than a refusal nobody can act on.
      steps.push({ layer: 'web', ok: true, detail: '', skipped: 'no web smoke in this invocation' })
    } else {
      steps.push({ layer: 'web', ok: true, detail: '', skipped: 'verify.web.enabled is false' })
    }

    const blocking = config.e2e.gate === 'blocking'
    if (config.e2e.enabled && input.e2e !== undefined) {
      input.log('gates: end-to-end suite')
      let run: VerificationResult
      try {
        run = await input.e2e(tree)
      } catch (error) {
        return {
          ok: false,
          steps: [...steps, { layer: 'e2e', ok: false, detail: message(error) }],
          refusedBy: 'e2e',
          tag: against,
          detail: inline(`the end-to-end suite could not run: ${message(error)}`, 300),
        }
      }
      if (run.skipped === undefined) executed = true
      steps.push({
        layer: 'e2e',
        ok: run.ok,
        detail: run.ok ? run.signature : run.detail.slice(0, 1500),
        ...(run.skipped === undefined ? {} : { skipped: run.skipped }),
      })
      if (!run.ok && blocking) {
        return {
          ok: false,
          steps,
          refusedBy: 'e2e',
          tag: against,
          detail: inline(`the end-to-end suite failed: ${run.signature}`, 300),
        }
      }
    } else if (config.e2e.enabled && blocking) {
      // A configured blocking suite that this invocation cannot run must not
      // become a silent pass: the user's configuration says nothing reaches the
      // branch without it.
      return {
        ok: false,
        steps: [...steps, { layer: 'e2e', ok: false, detail: '', skipped: 'no end-to-end runner in this invocation' }],
        refusedBy: 'e2e',
        tag: against,
        detail: '`e2e.gate` is `blocking` and this invocation has no end-to-end runner, so the change cannot be verified',
      }
    } else {
      steps.push({
        layer: 'e2e',
        ok: true,
        detail: '',
        skipped: config.e2e.enabled ? 'no end-to-end runner in this invocation' : 'e2e.enabled is false',
      })
    }

    if (!executed) {
      // Every layer skipped: the tree was never looked at by anything, and a
      // report that says `ok` here is the difference between "verified" and
      // "nobody checked".
      return {
        ok: false,
        steps,
        detail: 'no gate layer ran: the plugin declares no build, typecheck or test command, and the other layers are disabled',
      }
    }
    return {
      ok: true,
      steps,
      tag: against,
      detail: steps
        .map(step => `${step.layer}: ${step.skipped === undefined ? (step.ok ? 'pass' : 'fail') : 'skipped'}`)
        .join(', '),
    }
  }
}

/**
 * One line per layer, for the reply that has to be the audit trail.
 * @param report - what the runner returned.
 */
export function renderGateReport(report: GateReport): string {
  return report.steps
    .map((step) => {
      const verdict = step.skipped === undefined ? (step.ok ? 'pass' : 'fail') : `skipped (${step.skipped})`
      return `- \`${step.layer}\`: ${verdict}`
    })
    .join('\n')
}
