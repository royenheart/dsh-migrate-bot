import { appendFileSync } from 'node:fs'
import { describeBaseline } from '../domain/outcome.ts'
import { externalUrl, inline } from '../render/text.ts'
import type { MigrationView } from '../workflow/projection.ts'

/**
 * The step summary on the workflow run page: the outcome, why, and where the
 * proposal is.
 */

/** The Action's `status` output for a migration state. */
export function statusOf(state: string): string {
  return state === 'awaitingMerge' ? 'proposed' : state
}

export function renderStepSummary(input: { view: MigrationView; pluginName: string; logStreamUrl?: string | undefined }): string {
  const { view } = input
  const context = view.context
  const lines = [
    `## dsh-migrate: ${statusOf(view.state)}`,
    '',
    `**${inline(input.pluginName, 120)}** → \`${inline(view.target.tag, 80)}\``,
    '',
    `- Before the migration: ${describeBaseline(context)}`,
    `- Repair attempts: ${String(context.attempts)}${context.stoppedBy === undefined ? '' : ` (stopped: ${context.stoppedBy})`}`,
  ]
  if (context.failure !== undefined && view.state === 'failed') {
    lines.push(`- Failing check: ${context.failure.check} (${inline(context.failure.fingerprint, 200)})`)
  }
  for (const warning of context.warnings) lines.push(`- Warning: ${inline(warning, 300)}`)
  const proposal = context.proposal
  if (proposal !== undefined) lines.push(`- Proposal: ${externalUrl(proposal.pullRequest.url, 300) ?? `#${String(proposal.pullRequest.number)}`}`)
  const stream = input.logStreamUrl === undefined ? undefined : externalUrl(input.logStreamUrl, 300)
  if (stream !== undefined) lines.push(`- Run log stream: ${stream}`)
  return `${lines.join('\n')}\n`
}

/** Append to `$GITHUB_STEP_SUMMARY` when the runner provides one. */
export function writeStepSummary(markdown: string, env: NodeJS.ProcessEnv): void {
  const path = env.GITHUB_STEP_SUMMARY
  if (path !== undefined && path !== '') appendFileSync(path, markdown)
}
