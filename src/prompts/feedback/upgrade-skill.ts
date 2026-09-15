import { assembleFeedbackPrompt, FEEDBACK_REPORT_CONTRACT } from './shared.ts'

/**
 * The `upgrade-skill` channel: report what a real migration found wrong with the
 * community suite's knowledge, in the shape that repository's own bug template
 * asks for.
 *
 * The two findings their maintainers can act on are a card that is wrong and a
 * corridor that has no card at all. Everything else — a benchmark task, a
 * corridor claim, a registry entry — is either gated behind a frozen host
 * version or explicitly forbidden to be produced as a side effect of migrating
 * somebody else's plugin, so this channel delivers an issue and never a pull
 * request.
 */
export const UPGRADE_SKILL_FEEDBACK_PROMPT = `You are reporting a real migration back to the community DSH plugin-upgrade knowledge base (the \`dsh-plugin-upgrade-skill\` repository: version cards, corridor coverage, and the seven-class touchpoint taxonomy).

You are not writing a migration guide and not rewriting a card. You are reporting what one real migration observed, so a maintainer can correct a card or open a corridor.

Report only what the evidence supports, and prefer two kinds of finding:

1. **A wrong or stale card.** A card that applied to this migration said something the migration contradicts. Give the full card id, what the card says, what actually happened, and the reproduction.
2. **A covered gap.** The \`from → to\` corridor this migration crossed had no card, or the cards that exist did not cover a touchpoint the migration actually hit.

Rank findings by how much they would cost the next plugin to hit them. If there is nothing to report, say so plainly in one line rather than inventing a finding: "nothing to report" is a valid and useful answer.

## Their vocabulary — use it exactly

- Corridors are directed \`from → to\` edges between exact \`dsh-vX.Y.Z[-suffix]\` tags. Never a range, never \`latest\`.
- Touchpoints are numbered \`#1\`–\`#7\`. Use their numbering; do not invent a class.
- Card ids are complete, including the host version, for example \`DSH-0.1.2-A2-01\`. Never abbreviate one.
- \`curated\` means the cards cover the identified plugin-relevant changes and are not a complete API diff. Do not report "incomplete compared to the full API" as a defect; report a missed plugin-relevant change.
- A primary source is pinned to a tag or commit. Never cite a \`blob/main\` or \`blob/master\` link.`

/** The extra rules this channel adds to the shared contract. */
export const UPGRADE_SKILL_FEEDBACK_RULES = [
  'This channel opens an issue. It never opens a pull request, never claims a version corridor, and never generates a card or a registry entry: upstream forbids those as a side effect of migrating a third-party plugin.',
  'Write the body so it can be pasted into their bug-report template, with these sections in this order: Environment, Reproduction, Expected vs actual, Affected surface, Affected touchpoint or complete card id, Evidence, Unverified boundaries.',
  'Environment states the exact plugin, the exact `dsh-v*` tags, the operating system, and the Node version. Reproduction is the command a maintainer can run.',
  'Affected surface names one of: skill document, version card or corridor index, validator or planner, runtime verification, other.',
  'Where the migration conflicted with a card, present both sides side by side instead of overwriting one with the other, and give the exact command that produced the observation.',
  'Unverified boundaries is mandatory. Write "none" only when the migration really exercised everything the report claims.',
]

/**
 * Build the `upgrade-skill` feedback prompt.
 * @param evidence - the rendered evidence block.
 */
export function upgradeSkillFeedbackPrompt(evidence: string): string {
  return assembleFeedbackPrompt({
    instructions: UPGRADE_SKILL_FEEDBACK_PROMPT,
    contract: FEEDBACK_REPORT_CONTRACT,
    evidence,
    rules: UPGRADE_SKILL_FEEDBACK_RULES,
  })
}
