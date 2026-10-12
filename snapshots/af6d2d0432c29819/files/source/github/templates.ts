import { describeBaseline } from '../domain/outcome.ts'
import { inline } from '../render/text.ts'
import { formatAgentReport, formatWorkingTree, wrapFenced, neutralizeEmbedHtml } from './issue-format.ts'
import type { MigrationContext } from '../workflow/machine.ts'
import type { CheckResult } from '../workflow/model.ts'

/**
 * The text of a proposal: the pull request title and body, and the companion
 * issue that carries the full reports.
 */

export interface ProposalDocuments {
  title: string
  issue: string
  pullRequest: string
}

const CHECK_LABEL: Record<CheckResult['check'], string> = {
  mechanical: 'Mechanical checks',
  boot: 'Boot check',
  web: 'Web check',
  e2e: 'End-to-end check',
}

/** The hidden marker that identifies the proposal issue and pull request. */
export const PROPOSAL_MARKER = '<!-- dsh-migrate:proposal -->'

export function renderProposal(input: {
  context: MigrationContext
  pluginName: string
  /** The latest result of each check, in the order they ran. */
  checks: readonly CheckResult[]
  reports: { overlap?: string | undefined; extensionPoints?: string | undefined; repairs: readonly string[] }
  diff: string
  /** The workflow run that produced the proposal, when known. */
  runUrl?: string | undefined
}): ProposalDocuments {
  const { context } = input
  const target = inline(context.input.target.tag, 80)
  const plugin = inline(input.pluginName, 120)
  const title = `Migrate ${plugin} to DeepSeek Harness ${inline(context.input.target.version, 80)}`
  const checkLines = input.checks.map(check => `- ${CHECK_LABEL[check.check]}: ${check.outcome}${check.outcome === 'fail' ? ` (${inline(check.fingerprint, 200)})` : ''}`)
  const summary = [
    `- Target release: \`${target}\``,
    `- Source release: ${context.input.source === undefined ? 'unknown' : `\`${inline(context.input.source.release.tag, 80)}\` (${context.input.source.origin})`}`,
    `- Before the migration: ${describeBaseline(context)}`,
    `- Repair attempts: ${String(context.attempts)}`,
    ...(input.runUrl === undefined ? [] : [`- Workflow run: ${input.runUrl}`]),
    ...context.warnings.map(warning => `- Warning: ${inline(warning, 300)}`),
  ].join('\n')
  const repairs = input.reports.repairs.map((report, index) => `### Repair attempt ${String(index + 1)}\n\n${formatAgentReport(report, '_No report._')}`).join('\n\n')
  const issue = `${PROPOSAL_MARKER}
# Migration of ${plugin} to ${target}

## Summary

${summary}

## Checks

${checkLines.length === 0 ? '_No check ran._' : checkLines.join('\n')}

## Overlap review

${formatAgentReport(input.reports.overlap, '_Not run._')}

## Extension-point review

${formatAgentReport(input.reports.extensionPoints, '_Not run._')}
${repairs === '' ? '' : `\n## Repair attempts\n\n${repairs}\n`}
## Working tree

${formatWorkingTree(input.diff)}
`
  const failing = input.checks.filter(check => check.outcome === 'fail')
  const pullRequest = `${PROPOSAL_MARKER}
## Summary

This pull request migrates \`${plugin}\` to DeepSeek Harness \`${target}\`. The companion issue carries the review and repair reports.

${summary}

## Checks

${checkLines.length === 0 ? '_No check ran._' : checkLines.join('\n')}
${failing.length === 0 ? '' : `\n${failing.map(check => wrapFenced(neutralizeEmbedHtml(check.detail))).join('\n\n')}\n`}
## Before merging

- [ ] The documented capabilities and entry points still work.
- [ ] A capability the overlap review marked \`shrink\` or \`retire\` is really covered by the target release.
`
  return { title, issue, pullRequest }
}
