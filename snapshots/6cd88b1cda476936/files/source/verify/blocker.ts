/**
 * The repair loop stops early only on evidence. One of the two accepted forms
 * is the agent declaring, in a fixed shape, that the fix has to happen upstream
 * — but only when it also supplies the three pieces of evidence that make the
 * claim checkable. Without them the declaration is treated as absent, so an
 * agent that hits a hard problem cannot shortcut the budget by blaming the host.
 */

export interface BlockerReport {
  declared: boolean
  /** Declared with all required evidence present. */
  valid: boolean
  reason?: string
  /** Evidence fields the declaration is missing. */
  missing: string[]
}

const FIELDS = {
  reason: /^\s*(?:BLOCKER-)?REASON:\s*(.+)$/im,
  attempted: /^\s*ATTEMPTED:\s*([\s\S]*?)(?=\n[A-Z][A-Z-]*:|$)/im,
  harness: /^\s*HARNESS:\s*(.+)$/im,
  whyNotPlugin: /^\s*WHY-NOT-PLUGIN:\s*([\s\S]*?)(?=\n[A-Z][A-Z-]*:|$)/im,
} as const

const DECLARATION = /^\s*BLOCKER:\s*upstream\s*$/im

function field(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern)
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Parse an agent's upstream-blocker declaration out of a repair report.
 *
 * A valid declaration needs all three: what was already tried on the plugin
 * side, where in the harness the fix belongs, and why no plugin-side change can
 * substitute for it.
 * @param report - the repair session's markdown report
 */
export function parseBlocker(report: string | undefined): BlockerReport {
  if (report === undefined || !DECLARATION.test(report)) {
    return { declared: false, valid: false, missing: [] }
  }
  const reason = field(report, FIELDS.reason)
  const attempted = field(report, FIELDS.attempted)
  const harness = field(report, FIELDS.harness)
  const whyNotPlugin = field(report, FIELDS.whyNotPlugin)

  const missing: string[] = []
  if (attempted === undefined) missing.push('ATTEMPTED')
  if (harness === undefined) missing.push('HARNESS')
  if (whyNotPlugin === undefined) missing.push('WHY-NOT-PLUGIN')

  return {
    declared: true,
    valid: missing.length === 0,
    ...(reason === undefined ? {} : { reason }),
    missing,
  }
}

/** One line for the run log explaining why the loop stopped. */
export function describeBlocker(blocker: BlockerReport): string {
  if (!blocker.declared) return ''
  if (!blocker.valid) {
    return `agent declared an upstream blocker without evidence (missing ${blocker.missing.join(', ')}); continuing the loop`
  }
  return `agent declared an upstream blocker with evidence${blocker.reason === undefined ? '' : `: ${blocker.reason}`}`
}
