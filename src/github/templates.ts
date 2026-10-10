import type { MechanicalResult } from '../mechanical/run.ts'
import type { ResolvedVersion } from '../watch/dsh-version.ts'
import type { RunStatus, VerificationResult } from '../pipeline/types.ts'
import type { Attribution } from '../verify/baseline.ts'
import { formatAgentReport, formatErrorExcerpt, formatRootCause, formatWorkingTree } from './issue-format.ts'
import { inline } from '../render/text.ts'

export interface DocumentInput {
  status: RunStatus
  target: ResolvedVersion
  pluginName: string
  skippedReview: boolean
  fixAttempts: number
  mechanical: MechanicalResult
  verdictA?: string | undefined
  verdictB?: string | undefined
  fixes?: readonly string[] | undefined
  diff: string
  verification?: VerificationResult | undefined
  attribution?: Attribution | undefined
}

const CHECK_LABEL: Record<VerificationResult['layer'], string> = {
  boot: 'boot check',
  web: 'web check',
  e2e: 'end-to-end check',
}

/** Baseline attribution plus the last verification round, when either exists. */
function verificationSection(input: DocumentInput): string {
  const lines: string[] = []
  if (input.attribution !== undefined) {
    lines.push(`Baseline: ${input.attribution.summary}`)
  }
  if (input.verification !== undefined) {
    const label = CHECK_LABEL[input.verification.layer]
    const state = input.verification.ok ? 'pass' : 'fail'
    const skipped = input.verification.skipped === undefined
      ? ''
      : ` (skipped: ${input.verification.skipped})`
    lines.push(`${label}: ${state}${skipped}`)
    if (!input.verification.ok) {
      lines.push('', '```', inline(input.verification.detail.trim().slice(0, 4000) || input.verification.signature, 600), '```')
    }
  }
  if (lines.length === 0) return ''
  return `\n## Checks\n\n${lines.join('\n')}\n`
}

function en(input: DocumentInput): { title: string; issue: string; pr: string } {
  const title = input.status === 'failed'
    ? `dsh ${inline(input.target.version, 80)}: migration incomplete for ${inline(input.pluginName, 120)}`
    : `dsh ${inline(input.target.version, 80)}: migrate ${inline(input.pluginName, 120)}`
  const issue = `# Migration report: ${inline(input.pluginName, 120)} × DeepSeek Harness ${inline(input.target.version, 80)}

## Summary

- Target harness: \`${inline(input.target.tag, 80)}\` (${inline(input.target.version, 80)})
- Outcome: **${input.status}**
- Review skipped: ${input.skippedReview ? 'yes' : 'no'}
- Repair loops: ${input.fixAttempts}
- Mechanical tests: ${input.mechanical.ok ? 'passed' : 'failed'}
${verificationSection(input)}
## Root cause

${formatRootCause({
    mechanicalOk: input.mechanical.ok,
    reportA: input.verdictA,
    reportB: input.verdictB,
    reportC: input.fixes?.at(-1),
  })}

## Official overlap (A)

${formatAgentReport(input.verdictA, '_Not run._')}

## Design alignment (B)

${formatAgentReport(input.verdictB, '_Not run._')}
${input.fixes !== undefined && input.fixes.length > 0
    ? `\n## Repair (C${input.fixes.length})\n\n${formatAgentReport(input.fixes.at(-1), '_Not run._')}\n`
    : ''}
## Mechanical test report

Status: ${input.mechanical.ok ? 'pass' : 'fail'}

${formatErrorExcerpt(input.mechanical.errors, '(no error excerpt)')}

## Working tree

${formatWorkingTree(input.diff)}

## Notes

Full A/B/C reports stay in the Action artifact / local \`.dsh-migrate/\` run directory and are not committed. Per-patch reports under \`.dsh-migrate/patch-reports/\` are posted as an Issue comment (index table, then each body).
`
  const pr = `## Summary

Automated migration toward DeepSeek Harness \`${inline(input.target.version, 80)}\` for \`${inline(input.pluginName, 120)}\`.

- Outcome: **${input.status}**
- Repair loops: ${input.fixAttempts}

## Test plan

- [ ] Mechanical suite on this branch (Action log)
- [ ] Install into a throwaway profile and boot \`dsh web\`
- [ ] Confirm documented capabilities and entry points still work
- [ ] Confirm no leftover shadow of an official surface that A marked \`retire\` / \`shrink\` only when official overlap absorbed that surface

## Root cause

See the companion Issue. Mechanical excerpt:

${formatErrorExcerpt(input.mechanical.errors, '(clean)')}

## Risk

Preview-era harness APIs still move. Re-run the Action when the next \`dsh-v*\` tag lands.
`
  return { title, issue, pr }
}

export function renderDocuments(input: DocumentInput): { title: string; issue: string; pr: string } {
  return en(input)
}
