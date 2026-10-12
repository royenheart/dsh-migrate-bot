import { discussionDraftSpec } from './discussion-draft.ts'
import { HARNESS_DISCUSSION_CHANNEL, MIGRATE_BOT_CHANNEL, UPGRADE_SKILL_CHANNEL } from '../merge-reports/channels.ts'

/**
 * The prompts of the report channels.
 *
 * A report session runs after a proposal is merged. Everything it needs is
 * rendered into the prompt as evidence, because the repositories it would have
 * to read are ones the session has no token for; its job is analysis, not
 * retrieval. Each built-in channel has its own instructions and shares the
 * evidence block and one of the two output contracts below.
 */

/** What an analysis channel must print. */
export const REPORT_CONTRACT = `Print exactly one fenced \`\`\`json block as the last thing in your output, with this shape:

{
  "title": "<the issue or pull request title, one line, no markdown>",
  "body": "<the complete markdown body>"
}

Rules for that block:
- \`title\` and \`body\` are always required and are never empty.
- Reproduce evidence exactly: exact \`dsh-v*\` tags, full card ids, file paths and line numbers. Never invent a version, a card, or a URL.
- State what you could not check. An unverified boundary is reported, never implied away.
- Do not print anything after the block.`

/** What the duplicate-check channel must print. */
export const DUPLICATE_CONTRACT = `Print exactly one fenced \`\`\`json block as the last thing in your output, with this shape:

{
  "decisions": [
    {
      "slug": "<the patch report slug, exactly as given>",
      "post": true | false,
      "reason": "<one sentence>",
      "existing": [{ "url": "<existing thread>", "title": "<its title>", "why": "<one sentence>" }]
    }
  ]
}

Rules for that block:
- Exactly one decision per draft you were given, carrying that draft's slug verbatim.
- \`post\` is true only when no existing thread already requests the same thing and the request is still open. When it is false, \`reason\` says which of the two it is: an existing thread, or a request the harness already shipped.
- \`existing\` lists the threads that made this a duplicate, and is empty when there are none — including when the reason is "already shipped".
- Every URL in \`existing\` must be one you were given. Never construct one.
- Do not print anything after the block.`

/**
 * `upgrade-skill`: report what a real migration found wrong or missing in the
 * community upgrade skills, in the shape of that repository's bug template. It
 * delivers an issue only, because that project forbids generating cards or
 * claiming a corridor as a side effect of migrating somebody else's plugin.
 * "Corridor" and "touchpoint" are that project's terms and are quoted as such.
 */
const UPGRADE_SKILL_PROMPT = `You are reporting a real migration back to the community DSH plugin-upgrade knowledge base (the \`dsh-plugin-upgrade-skill\` repository: version cards, corridor coverage, and the seven-class touchpoint taxonomy).

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

const UPGRADE_SKILL_RULES = [
  'This channel opens an issue. It never opens a pull request, never claims a version corridor, and never generates a card or a registry entry: upstream forbids those as a side effect of migrating a third-party plugin.',
  'Write the body so it can be pasted into their bug-report template, with these sections in this order: Environment, Reproduction, Expected vs actual, Affected surface, Affected touchpoint or complete card id, Evidence, Unverified boundaries.',
  'Environment states the exact plugin, the exact `dsh-v*` tags, the operating system, and the Node version. Reproduction is the command a maintainer can run.',
  'Affected surface names one of: skill document, version card or corridor index, validator or planner, runtime verification, other.',
  'Where the migration conflicted with a card, present both sides side by side instead of overwriting one with the other, and give the exact command that produced the observation.',
  'Unverified boundaries is mandatory. Write "none" only when the migration really exercised everything the report claims.',
]

/**
 * `migrate-bot`: report how this Action performed. The maintainer's own edits
 * before merging are the most specific defect signal it can get.
 */
const MIGRATE_BOT_PROMPT = `You are reviewing how the DSH migration bot (this Action) performed on one migration, so the Action's prompts and checks can be improved.

The maintainer merged the proposal pull request. That is an endorsement of the outcome, not proof that every step was right: they may have edited the branch before merging, they may have merged to stop the noise, and they may have left comments explaining what they had to fix by hand.

Find the defects that cost the maintainer work, and attribute each one to the stage that should have caught it: the mechanical checks (\`typecheck\`, build, unit tests), the boot check, the web check, the end-to-end check, the overlap review, the extension-point review, or the repair attempts. If the migration went through cleanly and the maintainer changed nothing, say so in one line and report nothing else.

## What makes a finding actionable

- Name the stage that owned the miss, and say what it should have done instead.
- Quote the maintainer's own edit or comment as the evidence, with the file path, and distinguish "the maintainer had to fix this" from "the maintainer preferred a different style".
- Separate a defect in the Action from a defect in the plugin: a plugin that was already broken before this run, or a harness change that no plugin-side edit can absorb, is not an Action defect. Report it as an attribution, not a bug.
- Prefer few, well-evidenced findings over a list. A report with one real defect and an honest "everything else was clean" is more useful than five speculative ones.`

const MIGRATE_BOT_RULES = [
  'This channel opens an issue on the migration bot repository. It never opens a pull request and never edits the bot.',
  'Write the body with these sections in this order: Run, What the maintainer changed, Findings, Suggested change, Unverified boundaries.',
  'Run names the plugin, the `from` and `to` `dsh-v*` tags, the Action version if the evidence carries it, and the model configuration.',
  'What the maintainer changed lists the exact paths and, where the evidence has it, the exact diff lines. If they changed nothing, write "nothing" and stop after Unverified boundaries.',
  'Each finding states: the stage that owned the miss, the evidence, and the smallest change that would have caught it. Do not propose a rewrite.',
  'Never report a token count, a duration, or a reward that the evidence does not contain.',
]

/**
 * `harness-discussion`: decide whether the discussion draft the reviews already
 * wrote is still worth posting. It classifies and never writes a draft of its
 * own, so the draft's shape has one source: `discussion-draft.ts`.
 */
const HARNESS_DISCUSSION_PROMPT = `You are deciding whether a feature-request discussion draft should still be posted to the official DeepSeek Harness repository, or whether it has already been asked.

The draft was written during this migration's reviews and posted on the plugin's issue. Between then and the merge of the proposal, somebody may have opened the same request, or the maintainers may have shipped the change the draft asks for.

Decide one thing: is there already a thread that covers this draft?

- A thread covers it when the same change is being requested, or the same defect is being reported, even if the wording differs.
- A closed thread that never landed does **not** cover it: the request is still open, and a fresh topic is the right answer.
- A thread about a neighbouring API, a different package, or a coarser version of the request does **not** cover it.
- If the harness source for the target tag already ships the capability the draft asks for, the draft is obsolete rather than duplicated: say so in \`reason\` and leave \`existing\` empty.

You are given the draft, the candidate threads the Action already searched for, and the harness context. Judge from that evidence; do not treat a failed or empty search as proof that nothing exists, and say so in \`reason\` when the search was inconclusive.`

const HARNESS_DISCUSSION_RULES = [
  'This channel only classifies. Do not rewrite the draft, do not write a new one, and do not print a title or a body: the draft that gets posted is the one written during the migration.',
  `The draft sections are, in order: ${discussionDraftSpec()}.`,
  'A candidate is only a duplicate when it requests the same change. Report the candidate URL verbatim; never construct a URL you were not given.',
]

const BUILTIN_PROMPTS: Record<string, { instructions: string; contract: string; rules: readonly string[] }> = {
  [UPGRADE_SKILL_CHANNEL]: { instructions: UPGRADE_SKILL_PROMPT, contract: REPORT_CONTRACT, rules: UPGRADE_SKILL_RULES },
  [MIGRATE_BOT_CHANNEL]: { instructions: MIGRATE_BOT_PROMPT, contract: REPORT_CONTRACT, rules: MIGRATE_BOT_RULES },
  [HARNESS_DISCUSSION_CHANNEL]: { instructions: HARNESS_DISCUSSION_PROMPT, contract: DUPLICATE_CONTRACT, rules: HARNESS_DISCUSSION_RULES },
}

/**
 * The prompt one channel's session runs.
 * @param channel - the channel id, and the user's prompt when it replaces the built-in one.
 * @param evidence - the rendered evidence block.
 */
export function channelPrompt(channel: { id: string; prompt?: string | undefined }, evidence: string): string {
  const builtin = BUILTIN_PROMPTS[channel.id]
  if (channel.prompt !== undefined) {
    // An override replaces the instructions only: the output still has to parse
    // as the channel's own contract.
    return assemblePrompt({ instructions: channel.prompt, contract: builtin?.contract ?? REPORT_CONTRACT, evidence })
  }
  if (builtin === undefined) throw new Error(`report channel ${channel.id} has no prompt`)
  return assemblePrompt({ ...builtin, evidence })
}

function assemblePrompt(input: {
  instructions: string
  contract: string
  evidence: string
  rules?: readonly string[]
}): string {
  const rules = input.rules === undefined || input.rules.length === 0
    ? ''
    : `\n\nHard rules for this channel:\n${input.rules.map(rule => `- ${rule}`).join('\n')}`
  return `${input.instructions.trim()}
${rules}

## What you receive

Everything you get is below. Do not search the network for more context, and do not modify the plugin repository: this session only writes a report.

${input.evidence.trim()}

## Output contract

${input.contract}
`
}
