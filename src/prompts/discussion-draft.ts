/**
 * The one home for the official-discussion draft spec.
 *
 * Two callers depend on it being exactly these sections: the A/B harness-context
 * note, which asks the migration agent to draft a topic when no official thread
 * covers a required dsh-side patch, and the `harness-discussion` feedback
 * channel, which posts a draft that already exists by the time a migrate PR is
 * merged. Writing a second "open a discussion" prompt for the feedback channel
 * would let the two drift apart, so the field list lives here and both reference
 * it.
 */

/** The section list every discussion draft carries, in order. */
export const DISCUSSION_DRAFT_SECTIONS = [
  'Title (`# [Feature request] …`)',
  'English summary (blockquote)',
  'Background',
  'Current state',
  'Proposal',
  'Appendix: patch',
  'Questions to confirm',
  'Related',
] as const

/** The section list as one prose sentence, for embedding in a prompt. */
export function discussionDraftSpec(): string {
  return DISCUSSION_DRAFT_SECTIONS.join(', ')
}
