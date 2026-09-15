import { discussionDraftSpec } from '../discussion-draft.ts'
import { assembleFeedbackPrompt, FEEDBACK_DUPLICATE_CONTRACT } from './shared.ts'

/**
 * The `harness-discussion` channel: post a discussion draft that the migration
 * already wrote, unless an equivalent topic has been opened since.
 *
 * This channel deliberately carries **no** "open a discussion" prompt. The draft
 * is produced during the A/B reviews, by the prompt in
 * `src/prompts/migrate/prompts.ts`, and posting it again here would mean two
 * prompts writing the same document. What is left for the model to do is the one
 * thing that changed between those reviews and the merge: whether somebody has
 * proposed the same thing in the meantime, which the issue stage could not know
 * about.
 *
 * The draft is produced by the A/B reviews (the prompt in
 * `src/prompts/migrate/prompts.ts`), and its sections come from
 * `src/prompts/discussion-draft.ts`; this file only classifies it.
 */
export const HARNESS_DISCUSSION_FEEDBACK_PROMPT = `You are deciding whether a feature-request discussion draft should still be posted to the official DeepSeek Harness repository, or whether it has already been asked.

The draft was written during this migration's reviews and posted on the plugin's issue. Between then and the merge of the migration pull request, somebody may have opened the same request, or the maintainers may have shipped the change the draft asks for.

Decide one thing: is there already a thread that covers this draft?

- A thread covers it when the same change is being requested, or the same defect is being reported, even if the wording differs.
- A closed thread that never landed does **not** cover it: the request is still open, and a fresh topic is the right answer.
- A thread about a neighbouring API, a different package, or a coarser version of the request does **not** cover it.
- If the harness source for the target tag already ships the capability the draft asks for, the draft is obsolete rather than duplicated: say so in \`reason\` and leave \`existing\` empty.

You are given the draft, the candidate threads the Action already searched for, and the harness context. Judge from that evidence; do not treat a failed or empty search as proof that nothing exists, and say so in \`reason\` when the search was inconclusive.`

/** The extra rules this channel adds to the shared contract. */
export const HARNESS_DISCUSSION_FEEDBACK_RULES = [
  'This channel only classifies. Do not rewrite the draft, do not write a new one, and do not print a title or a body: the draft that gets posted is the one written during the migration.',
  'The draft sections are, in order: ' + discussionDraftSpec() + '.',
  'A candidate is only a duplicate when it requests the same change. Report the candidate URL verbatim; never construct a URL you were not given.',
]

/**
 * Build the `harness-discussion` duplicate-check prompt.
 * @param evidence - the rendered evidence block, which carries the draft and the candidate threads.
 */
export function harnessDiscussionFeedbackPrompt(evidence: string): string {
  return assembleFeedbackPrompt({
    instructions: HARNESS_DISCUSSION_FEEDBACK_PROMPT,
    contract: FEEDBACK_DUPLICATE_CONTRACT,
    evidence,
    rules: HARNESS_DISCUSSION_FEEDBACK_RULES,
  })
}
