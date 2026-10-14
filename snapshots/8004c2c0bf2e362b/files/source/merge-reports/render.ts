import type { Evidence } from './evidence.ts'

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
    ...evidence.warnings.map(warning => `- Warning recorded by the migration: ${warning}`),
  )

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

function truncate(text: string, limit = 20_000): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n\n… truncated by this Action (${String(trimmed.length - limit)} characters omitted).`
}
