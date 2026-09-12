import { assembleFeedbackPrompt, FEEDBACK_REPORT_CONTRACT } from './shared.ts'

/**
 * The `migrate-bot` channel: report how *this* Action performed, so the Action
 * can be improved.
 *
 * A merged pull request is the moment the maintainer's verdict becomes
 * observable: the tree they accepted, and any edit they made to it before
 * merging. That edit is the highest-value signal this Action can get, because
 * it is the maintainer fixing by hand what the agent did not get right.
 */
export const MIGRATE_BOT_FEEDBACK_PROMPT = `You are reviewing how the DSH migration bot (this Action) performed on one migration, so the Action's prompts, gates, and prompts can be improved.

The maintainer merged the migration pull request. That is an endorsement of the outcome, not proof that every step was right: they may have edited the branch before merging, they may have merged to stop the noise, and they may have left comments explaining what they had to fix by hand.

Find the defects that cost the maintainer work, and attribute each one to the stage that should have caught it: the fast gate (\`typecheck\`, build, unit tests), the boot probe, the end-to-end suite, the overlap review, the alignment review, or the repair loop. If the migration went through cleanly and the maintainer changed nothing, say so in one line and report nothing else.

## What makes a finding actionable

- Name the stage that owned the miss, and say what it should have done instead.
- Quote the maintainer's own edit or comment as the evidence, with the file path, and distinguish "the maintainer had to fix this" from "the maintainer preferred a different style".
- Separate a defect in the Action from a defect in the plugin: a plugin that was already broken before this run, or a harness change that no plugin-side edit can absorb, is not an Action defect. Report it as an attribution, not a bug.
- Prefer few, well-evidenced findings over a list. A report with one real defect and an honest "everything else was clean" is more useful than five speculative ones.`

/** The extra rules this channel adds to the shared contract. */
export const MIGRATE_BOT_FEEDBACK_RULES = [
  'This channel opens an issue on the migration bot repository. It never opens a pull request and never edits the bot.',
  'Write the body with these sections in this order: Run, What the maintainer changed, Findings, Suggested change, Unverified boundaries.',
  'Run names the plugin, the `from` and `to` `dsh-v*` tags, the Action version if the evidence carries it, and the model configuration.',
  'What the maintainer changed lists the exact paths and, where the evidence has it, the exact diff lines. If they changed nothing, write "nothing" and stop after Unverified boundaries.',
  'Each finding states: the stage that owned the miss, the evidence, and the smallest change that would have caught it. Do not propose a rewrite.',
  'Never report a token count, a duration, or a reward that the evidence does not contain.',
]

/**
 * Build the `migrate-bot` feedback prompt.
 * @param evidence - the rendered evidence block.
 */
export function migrateBotFeedbackPrompt(evidence: string): string {
  return assembleFeedbackPrompt({
    instructions: MIGRATE_BOT_FEEDBACK_PROMPT,
    contract: FEEDBACK_REPORT_CONTRACT,
    evidence,
    rules: MIGRATE_BOT_FEEDBACK_RULES,
  })
}
