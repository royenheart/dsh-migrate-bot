import type { FeedbackEvidence } from './types.ts'

/**
 * Render the evidence a feedback session reasons over.
 *
 * The Action renders this and the model does not fetch anything: by the time a
 * migrate PR is merged, the repository the session would have to read is one it
 * has no token for, and a session that goes looking fails quietly instead of
 * reporting a gap.
 *
 * Reports are truncated rather than summarized. A summary is a second analysis
 * the maintainer did not ask for, and it hides the evidence the report is
 * supposed to cite.
 * @param evidence - what the run collected.
 * @param options.includeCandidates - include the candidate threads the duplicate check judges.
 */
export function renderEvidence(
  evidence: FeedbackEvidence,
  options: { includeCandidates?: boolean } = {},
): string {
  const lines: string[] = []
  const plugin = `\`${evidence.plugin.owner}/${evidence.plugin.repo}\``
  lines.push('### Migration')
  lines.push('')
  lines.push(`- Plugin repository: ${plugin} (${evidence.plugin.url})`)
  lines.push(`- Corridor: ${fromTag(evidence)} → ${toTag(evidence)}`)
  lines.push(`- Pull request: #${String(evidence.pullRequest.number)} — ${evidence.pullRequest.title}`)
  lines.push(`- Pull request URL: ${evidence.pullRequest.url}`)
  lines.push(`- Pull request state: ${evidence.pullRequest.state}`)
  lines.push(`- Merged at: ${evidence.pullRequest.mergedAt ?? 'unknown'}`)
  lines.push(`- Merged by: ${evidence.pullRequest.mergedBy ?? 'unknown'}`)
  lines.push(`- Branch author: ${evidence.pullRequest.author ?? 'unknown'}`)
  if (evidence.issue !== undefined) {
    lines.push(`- Companion issue: #${String(evidence.issue.number)} — ${evidence.issue.url}`)
  }
  lines.push('')

  lines.push('### What the maintainer changed before merging')
  lines.push('')
  if (evidence.pullRequest.state !== 'merged') {
    // The merge is what the automatic path waits for, and a manual report may
    // run before it. Saying "the merge took the branch as pushed" here would
    // invent a verdict nobody has given yet.
    lines.push(
      `The pull request is \`${evidence.pullRequest.state}\`, not merged: nothing below is a maintainer's verdict,`
      + ' and the branch can still change.',
    )
    lines.push('')
  }
  if (!evidence.maintainerChanges.known) {
    lines.push(`Not comparable: ${evidence.maintainerChanges.note ?? 'the comparison was unavailable'}`)
  } else if (evidence.maintainerChanges.files.length === 0) {
    lines.push(
      evidence.pullRequest.state === 'merged'
        ? 'Nothing: the merge took the branch exactly as the Action pushed it.'
        : 'Nothing yet: no commit on the branch was authored by anyone but the Action.',
    )
  } else {
    lines.push('Files the merge changed relative to the branch the Action pushed:')
    lines.push('')
    lines.push('| File | Status | + | - |')
    lines.push('| --- | --- | --- | --- |')
    for (const file of evidence.maintainerChanges.files) {
      lines.push(`| \`${file.filename}\` | ${file.status} | ${String(file.additions)} | ${String(file.deletions)} |`)
    }
  }
  lines.push('')

  if (evidence.pullRequest.body.trim() !== '') {
    lines.push('### Pull request body (written by the Action)')
    lines.push('')
    lines.push(truncate(evidence.pullRequest.body))
    lines.push('')
  }

  lines.push('### Human comments on the issue and pull request')
  lines.push('')
  if (evidence.comments.length === 0) {
    lines.push('None.')
  } else {
    for (const comment of evidence.comments) {
      const where = comment.path === undefined ? comment.source : `${comment.source} ${comment.path}`
      lines.push(`#### ${comment.author} (${where}, ${comment.createdAt})`)
      lines.push('')
      lines.push(truncate(comment.body, 8_000))
      lines.push('')
    }
  }
  lines.push('')

  lines.push("### What this Action's own run produced")
  lines.push('')
  lines.push(`Run directory: ${evidence.reports.runDir ?? 'unknown'}`)
  lines.push('')
  if (evidence.reports.mechanical !== undefined) {
    lines.push('#### Mechanical gate output')
    lines.push('')
    lines.push(fenced(evidence.reports.mechanical))
    lines.push('')
  }
  if (evidence.reports.absorption !== undefined) {
    lines.push('#### Report A — official overlap')
    lines.push('')
    lines.push(truncate(evidence.reports.absorption, 12_000))
    lines.push('')
  }
  if (evidence.reports.alignment !== undefined) {
    lines.push('#### Report B — design alignment')
    lines.push('')
    lines.push(truncate(evidence.reports.alignment, 12_000))
    lines.push('')
  }
  if (evidence.reports.fixes.length > 0) {
    lines.push('#### Repair reports')
    lines.push('')
    evidence.reports.fixes.forEach((fix, index) => {
      lines.push(`##### C${String(index + 1)}`)
      lines.push('')
      lines.push(truncate(fix, 8_000))
      lines.push('')
    })
  }

  if (evidence.reports.patchReports.length > 0) {
    lines.push('### Patch reports (dsh-side changes the migration still needs)')
    lines.push('')
    for (const report of evidence.reports.patchReports) {
      lines.push(`#### \`${report.slug}\` — ${report.kind}`)
      lines.push('')
      if (report.links.length > 0) {
        lines.push(`Existing official threads: ${report.links.join(', ')}`)
        lines.push('')
      }
      lines.push(truncate(report.body, 12_000))
      lines.push('')
    }
  }

  if (options.includeCandidates === true) {
    lines.push('### Candidate threads the Action already found')
    lines.push('')
    if (evidence.candidates.length === 0) {
      lines.push('The search returned no candidates. An empty search is not proof that nothing exists.')
    } else {
      for (const candidate of evidence.candidates) {
        lines.push(`- ${candidate.title} — ${candidate.url}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

/** The exact `dsh-v*` tags the drafts under discussion were written against. */
export function corridorLine(evidence: FeedbackEvidence): string {
  return `${fromTag(evidence)} → ${toTag(evidence)}`
}

function fromTag(evidence: FeedbackEvidence): string {
  return evidence.from === undefined ? '(not recorded)' : `\`${evidence.from}\``
}

function toTag(evidence: FeedbackEvidence): string {
  return evidence.to === undefined ? '(not recorded)' : `\`${evidence.to}\``
}

function truncate(text: string, limit = 20_000): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n\n… truncated by the Action (${String(trimmed.length - limit)} characters omitted).`
}

function fenced(text: string): string {
  const body = text.trim()
  const fence = body.includes('```') ? '````' : '```'
  return `${fence}\n${body}\n${fence}`
}
