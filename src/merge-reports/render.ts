import { inline } from '../render/text.ts'
import type { Evidence, RunMetrics } from './evidence.ts'
import type { MigrateBotPayload } from './parse.ts'

/**
 * Render the evidence a report session reasons over.
 *
 * Reports are truncated rather than summarised: a summary is a second analysis
 * nobody asked for, and it hides the evidence the report has to cite.
 * @param evidence - what was collected.
 * @param options.includeCandidates - include the upstream threads the duplicate check judges.
 */
export function renderEvidence(evidence: Evidence, options: { includeCandidates: boolean }): string {
  const lines: string[] = []
  const section = (title: string, ...body: string[]): void => {
    lines.push(`### ${title}`, '', ...body, '')
  }
  section(
    'Migration',
    `- Plugin repository: \`${evidence.plugin}\``,
    `- Release range: ${evidence.from === undefined ? '(source release not recorded)' : `\`${evidence.from}\``} → \`${evidence.to}\``,
    `- Pull request: #${String(evidence.pullRequest.number)} — ${evidence.pullRequest.title} (${evidence.pullRequest.url})`,
    `- Merged: ${evidence.pullRequest.merged ? `yes, at ${evidence.pullRequest.mergedAt ?? 'unknown'} by ${evidence.pullRequest.mergedBy ?? 'unknown'}` : 'no'}`,
    `- Companion issue: ${evidence.issueUrl}`,
    `- Action version: ${evidence.actionVersion === undefined ? 'unknown' : `\`${evidence.actionVersion}\``}`,
    `- Model: \`${evidence.model.provider}/${evidence.model.model}\` (thinking ${evidence.model.thinking}, effort ${evidence.model.reasoningEffort})`,
    ...evidence.warnings.map(warning => `- Warning recorded by the migration: ${warning}`),
  )

  if (evidence.metrics !== undefined) section('Agent work', ...metricsLines(evidence.metrics))

  const changes = evidence.maintainerChanges
  section(
    'What the maintainer changed on the proposal branch',
    ...(evidence.pullRequest.merged ? [] : ['The pull request is not merged: nothing below is a maintainer\'s decision yet, and the branch can still change.', '']),
    ...(!changes.known
      ? [`Not comparable: ${changes.note}`]
      : changes.files.length === 0
        ? ['Nothing: the branch is exactly as this Action pushed it.']
        : [
          '| File | Status | + | - |',
          '| --- | --- | --- | --- |',
          ...changes.files.map(file => `| \`${file.filename}\` | ${file.status} | ${String(file.additions)} | ${String(file.deletions)} |`),
        ]),
  )

  if (evidence.pullRequest.body.trim() !== '') section('Pull request body (written by this Action)', truncate(evidence.pullRequest.body))

  section(
    'Human comments on the issue and the pull request',
    ...(evidence.comments.length === 0
      ? ['None.']
      : evidence.comments.flatMap(comment => [
        `#### ${comment.author} (${comment.source}${comment.path === undefined ? '' : ` ${comment.path}`}, ${comment.createdAt})`,
        '',
        truncate(comment.body, 8_000),
        '',
      ])),
  )

  const { reports } = evidence
  if (reports.overlap !== undefined) section('Overlap review report', truncate(reports.overlap, 12_000))
  if (reports.extensionPoints !== undefined) section('Extension-point review report', truncate(reports.extensionPoints, 12_000))
  reports.repairs.forEach((report, index) => {
    section(`Repair attempt ${String(index + 1)} report`, truncate(report, 8_000))
  })

  for (const report of evidence.patchReports) {
    section(
      `Patch report \`${report.slug}\` (${report.kind})`,
      ...(report.links.length === 0 ? [] : [`Existing upstream threads: ${report.links.join(', ')}`, '']),
      truncate(report.body, 12_000),
    )
  }

  if (options.includeCandidates) {
    section(
      'Upstream threads found by searching for each draft',
      ...(evidence.candidates.length === 0
        ? ['The search returned nothing. An empty search is not proof that nothing exists.']
        : evidence.candidates.map(candidate => `- ${candidate.title} — ${candidate.url}`)),
    )
  }
  return lines.join('\n').trim()
}

function evaluationText(evaluation: NonNullable<Evidence['evaluation']>): string {
  return [
    evaluation.harborJob === undefined ? undefined : `Harbor job \`${inline(evaluation.harborJob, 200)}\``,
    evaluation.trialId === undefined ? undefined : `trial \`${inline(evaluation.trialId, 200)}\``,
    evaluation.record === undefined
      ? undefined
      : /^https?:\/\//i.test(evaluation.record) ? `[record](${evaluation.record})` : `record \`${inline(evaluation.record, 300)}\``,
  ].filter((part): part is string => part !== undefined).join(' · ')
}

function metricsLines(metrics: RunMetrics): string[] {
  const cost = metrics.usd === undefined ? 'cost not recorded' : `$${metrics.usd.toFixed(6)}`
  return [
    `- Agent work: ${String(metrics.runs)} run(s), ${String(metrics.sessions)} session(s), ${String(metrics.turns)} turns, ${String(metrics.steps)} steps, ${String(metrics.toolCalls)} tool calls`,
    `- Agent cost: ${cost} (input ${String(metrics.inputTokens)}, output ${String(metrics.outputTokens)}, cache hit ${String(metrics.cacheHitTokens)} tokens)`,
    `- Agent time: ${String(metrics.elapsedSeconds)}s across sessions`,
  ]
}

function truncate(text: string, limit = 20_000): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n\n… truncated by this Action (${String(trimmed.length - limit)} characters omitted).`
}


/**
 * Render the migrate-bot report from structured findings.
 *
 * The model returns findings as data; this template owns the prose around them.
 * That keeps the report readable and keeps defensive attributions out of it:
 * `attribution` is a label, not a sentence that argues with a reader.
 * @param evidence - what the report reasons over.
 * @param report - the findings the session returned.
 */
export function renderMigrateBotReport(evidence: Evidence, report: MigrateBotPayload): { title: string; body: string } {
  const lines: string[] = [
    '## Run',
    '',
    `- Plugin: \`${evidence.plugin}\``,
    `- Release range: ${evidence.from === undefined ? '(source release not recorded)' : `\`${evidence.from}\``} → \`${evidence.to}\``,
    `- Pull request: #${String(evidence.pullRequest.number)} — ${evidence.pullRequest.title} (${evidence.pullRequest.url})`,
    `- Merged: ${evidence.pullRequest.merged ? `yes, at ${evidence.pullRequest.mergedAt ?? 'unknown'} by ${evidence.pullRequest.mergedBy ?? 'unknown'}` : 'no'}`,
    `- Action version: ${evidence.actionVersion === undefined ? 'unknown' : `\`${evidence.actionVersion}\``}`,
    `- Model: \`${evidence.model.provider}/${evidence.model.model}\` (thinking ${evidence.model.thinking}, effort ${evidence.model.reasoningEffort})`,
    ...(evidence.checks.length === 0 ? ['- Checks: none recorded in the proposal body'] : ['- Checks:', ...evidence.checks.map(check => `  - ${check}`)]),
    ...(evidence.metrics === undefined ? [] : metricsLines(evidence.metrics)),
    ...(evidence.evaluation === undefined || evaluationText(evidence.evaluation) === ''
      ? []
      : [`- Evaluation: ${evaluationText(evidence.evaluation)}`]),
    ...evidence.warnings.map(warning => `- Warning recorded by the migration: ${warning}`),
    '',
    '## What the maintainer changed',
    '',
  ]

  if (!evidence.maintainerChanges.known) {
    lines.push(`Not comparable: ${evidence.maintainerChanges.note}`)
  } else if (evidence.maintainerChanges.files.length === 0) {
    lines.push('Nothing: the branch is exactly as this Action pushed it.')
  } else {
    const table = [
      '| File | Status | + | - |',
      '| --- | --- | --- | --- |',
      ...evidence.maintainerChanges.files.map(file => `| \`${file.filename}\` | ${file.status} | ${String(file.additions)} | ${String(file.deletions)} |`),
    ]
    if (table.length > 12) {
      lines.push(`<details><summary>${String(evidence.maintainerChanges.files.length)} changed file(s)</summary>`, '', ...table, '', '</details>')
    } else {
      lines.push(...table)
    }
  }
  lines.push('', '## Findings', '')

  if (report.findings.length === 0) {
    lines.push('No Action defect found: no check missed a defect that cost the maintainer work.', '')
  }
  report.findings.forEach((finding, index) => {
    lines.push(`### ${String(index + 1)}. [${finding.severity}] ${finding.stage}: ${finding.finding}`, '')
    lines.push(`**Evidence.** ${finding.evidence}`, '')
    lines.push(`**Fix.** ${finding.fix}`, '')
    if (finding.attribution !== 'action') {
      lines.push(`**Attribution.** ${finding.attribution === 'pre-existing' ? 'Pre-existing.' : 'Upstream.'}`, '')
    }
  })

  if (report.limits !== undefined && report.limits.length > 0) {
    lines.push('## Limits', '', ...report.limits.map(limit => `- ${limit}`), '')
  }
  return { title: report.title, body: `${lines.join('\n').trim()}\n` }
}
