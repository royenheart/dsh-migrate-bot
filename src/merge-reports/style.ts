/**
 * The prose patterns a report should not use.
 *
 * These are not an authorship test. They are the constructions that make a
 * review read as defensive filler: the negative half denies something nobody
 * claimed, and the reader processes the denied idea before the real one. The
 * report prompt asks the session to avoid them; this module is the test-time
 * check on the deterministic parts and on recorded examples.
 */

const PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'not just / not only', pattern: /\bnot\s+(?:just|only)\b/i },
  { label: 'not a defect / finding / regression / failure', pattern: /\bnot\s+(?:a|an)\s+(?:action\s+)?(?:defect|finding|regression|failure)\b/i },
  { label: 'not scored', pattern: /\bnot\s+scored\b/i },
  { label: 'rather than', pattern: /\brather\s+than\b/i },
  { label: 'not X but Y', pattern: /\bnot\s+[^.\n]{1,80}\s+but\s+[^.\n]{1,80}/i },
]

/** The style rules a report body breaks, as human-readable labels. */
export function reportStyleProblems(text: string): string[] {
  return PATTERNS.filter(rule => rule.pattern.test(text)).map(rule => rule.label)
}
