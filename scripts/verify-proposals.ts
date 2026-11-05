/**
 * Gate: every design proposal has the documented shape and an explicit status.
 *
 * A proposal exists to make a decision reviewable: the status says whether it
 * is open or parked, and the required sections separate the problem from the
 * options and the acceptance criteria. The check keeps the directory from
 * becoming a set of notes that no owner can decide.
 */

import { readText, rel, repoFiles, REPO_ROOT } from './repo.ts'
import { headingsOf } from './md.ts'

const PROPOSALS = 'docs/proposals'
const REQUIRED = ['Problem', 'Proposal', 'Decisions needed', 'Acceptance criteria', 'Risks']

export interface ProposalViolation {
  file: string
  detail: string
}

/**
 * Check every proposal below `docs/proposals`.
 * @returns one entry per defect, and how many proposals were checked.
 */
export function verifyProposalSource(source: string, file: string): ProposalViolation[] {
  const violations: ProposalViolation[] = []
  const headings = headingsOf(source)
  const first = headings[0]
  if (first === undefined || first.level !== 1 || !first.text.startsWith('Proposal: ')) {
    violations.push({ file, detail: 'the first heading is not "# Proposal: <title>"' })
  }
  const header = (source.split(/^##\s/m, 1)[0] ?? source).split('```', 1)[0] ?? ''
  const lines = header.split('\n')
  const titleIndex = lines.findIndex(line => /^# Proposal: /.test(line.trim()))
  const afterTitle = lines.slice(titleIndex + 1).filter(line => line.trim() !== '')
  const statuses = afterTitle.filter(line => /^Status:/.test(line.trim()))
  if (statuses.length !== 1 || !/^Status: (open|parked)$/.test((afterTitle[0] ?? '').trim())) violations.push({ file, detail: 'the proposal needs exactly one leading "Status: open" or "Status: parked"' })
  const sections = headings.filter(heading => heading.level === 2).map(heading => heading.text)
  for (const required of REQUIRED) {
    if (!sections.includes(required)) violations.push({ file, detail: `missing section "## ${required}"` })
  }
  const positions = REQUIRED.map(name => sections.indexOf(name))
  if (positions.every(position => position >= 0)) {
    for (let index = 1; index < positions.length; index += 1) {
      if ((positions[index] ?? -1) < (positions[index - 1] ?? -1)) {
        violations.push({ file, detail: 'the required sections are out of order' })
        break
      }
    }
  }
  return violations
}

export function verifyProposals(): { violations: ProposalViolation[]; checked: number } {
  const files = repoFiles(['.md'], `${REPO_ROOT}/${PROPOSALS}`)
    .map(file => rel(file))
    .filter(file => file !== `${PROPOSALS}/README.md`)
    .sort()
  const violations = files.flatMap(file => verifyProposalSource(readText(`${REPO_ROOT}/${file}`), file))
  return { violations, checked: files.length }
}
