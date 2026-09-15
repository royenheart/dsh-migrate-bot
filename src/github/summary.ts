import { appendFileSync } from 'node:fs'
import { externalUrl, inline } from '../render/text.ts'
import type { PipelineResult, RunStatus, VerificationResult } from '../pipeline/types.ts'

/**
 * The run summary that renders inside the Actions UI.
 *
 * Logs are ephemeral and the artifact has to be downloaded, so the one place a
 * human actually looks — the run page — is where the verdict, the baseline
 * attribution and the failing layer belong.
 */

export interface StepSummaryInput {
  status: RunStatus
  target: { tag: string; version: string }
  pluginName: string
  result: Pick<
    PipelineResult,
    'mechanical' | 'fixAttempts' | 'skippedReview' | 'attribution' | 'verification' | 'stoppedBy' | 'e2eSync'
  >
  issueUrl?: string | undefined
  pullRequestUrl?: string | undefined
  /** Read-only view of this run, when a deploy target is streaming it. */
  liveViewUrl?: string | undefined
  runDir: string
}

/** Every verification layer names itself; a new layer must be added here. */
const VERIFY_LABEL: Record<VerificationResult['layer'], string> = {
  boot: 'boot probe',
  web: 'web smoke',
  e2e: 'E2E suite',
}

const VERDICT: Record<RunStatus, string> = {
  compatible: '✅ compatible',
  migrated: '🔧 migrated',
  failed: '❌ failed',
  skipped: '⏭️ skipped',
}

/**
 * Render the markdown summary for `$GITHUB_STEP_SUMMARY`.
 * @param input - run outcome
 */
export function renderStepSummary(input: StepSummaryInput): string {
  const lines: string[] = []
  lines.push(`## dsh-migrate: ${VERDICT[input.status]}`)
  lines.push('')
  lines.push(`**${inline(input.pluginName, 120)}** × \`${inline(input.target.tag, 80)}\``)
  // A link only when the value is a page: `externalUrl` is what decides that, and
  // a URL that is not one is dropped rather than rendered.
  const view = input.liveViewUrl === undefined ? undefined : externalUrl(input.liveViewUrl, 300)
  if (view !== undefined) {
    lines.push('')
    lines.push(`[Watch this run](${view}) — read-only, and it keeps the log after the run ends.`)
  } else if (input.liveViewUrl !== undefined) {
    // The reader of a run page has to be able to tell "the target named nothing"
    // from "the target named something this Action will not link".
    lines.push('')
    lines.push('_The deploy target named a page this Action will not link._')
  }
  lines.push('')

  const facts: string[] = [`fast gate: ${input.result.mechanical.ok ? 'pass' : 'fail'}`]
  if (input.result.skippedReview) facts.push('review skipped')
  else facts.push(`repair rounds: ${input.result.fixAttempts}`)
  if (input.result.stoppedBy !== undefined && input.result.stoppedBy !== 'budget') {
    facts.push(`loop stopped: ${input.result.stoppedBy}`)
  }
  lines.push(facts.join(' · '))

  if (input.result.attribution !== undefined) {
    lines.push('')
    lines.push(`**Baseline** — ${inline(input.result.attribution.summary, 300)}`)
  }

  const verification = input.result.verification
  if (verification !== undefined) {
    lines.push('')
    const label = VERIFY_LABEL[verification.layer]
    lines.push(`**Verification** — ${label}: ${verification.ok ? 'pass' : 'fail'}${
      verification.skipped === undefined ? '' : ` (skipped: ${inline(verification.skipped, 200)})`
    }`)
    if (!verification.ok) {
      // One line of the failing layer's own output: this is the plugin's text,
      // and a multi-line value inside a fence is a way out of the fence.
      lines.push('')
      lines.push('```')
      lines.push(inline(verification.detail.trim().slice(0, 1500) || verification.signature, 600))
      lines.push('```')
    }
  }

  if (input.result.e2eSync !== undefined) {
    lines.push('')
    lines.push(`**E2E branch** — ${input.result.e2eSync.pushed
      ? 'updated'
      : `not updated (${inline(input.result.e2eSync.reason ?? 'unknown', 200)})`}`)
  }

  const links = [input.issueUrl, input.pullRequestUrl]
    .map(url => (url === undefined ? undefined : externalUrl(url, 300)))
    .filter((url): url is string => url !== undefined)
  if (links.length > 0) {
    lines.push('')
    lines.push(links.join(' · '))
  }
  lines.push('')
  lines.push(`<sub>reports: \`${inline(input.runDir, 200)}\`</sub>`)
  return `${lines.join('\n')}\n`
}

/**
 * Append a summary to the Actions step summary, when the runner provides one.
 * Never throws: a missing summary must not fail a migration.
 * @param markdown - rendered summary
 * @param env - environment holding `GITHUB_STEP_SUMMARY`
 */
export function writeStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.GITHUB_STEP_SUMMARY
  if (path === undefined || path === '') return false
  try {
    appendFileSync(path, markdown, 'utf8')
    return true
  } catch {
    return false
  }
}
