/**
 * What every feedback prompt shares: the evidence block the session reasons
 * over, and the report contract it must print.
 *
 * The evidence is rendered by the Action, not gathered by the model. A feedback
 * session runs after a migrate PR is merged, when the repository it would have
 * to read is one the model has no token for — so everything it needs is inlined
 * here, and the prompt's job is analysis, not retrieval.
 */

/** What the model must print for an `analysis` channel. */
export const FEEDBACK_REPORT_CONTRACT = `Print exactly one fenced \`\`\`json block as the last thing in your output, with this shape:

{
  "title": "<the issue or pull request title, one line, no markdown>",
  "body": "<the complete markdown body>",
  "files": [{ "path": "<repository-relative path>", "content": "<full file content>" }]
}

Rules for that block:
- \`title\` and \`body\` are always required and are never empty.
- \`files\` is required only when this channel delivers a pull request; use an empty array otherwise.
- Write only files the report genuinely needs. Never write into a repository's protected or generated paths.
- Reproduce evidence exactly: exact \`dsh-v*\` tags, full card ids, file paths and line numbers. Never invent a version, a card, or a URL.
- State what you could not check. An unverified boundary is reported, never implied away.
- Do not print anything after the block.`

/** What the model must print for the duplicate-check channel. */
export const FEEDBACK_DUPLICATE_CONTRACT = `Print exactly one fenced \`\`\`json block as the last thing in your output, with this shape:

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
 * Wrap a channel's instructions with the shared contract and the evidence.
 * @param input - the channel prompt, the contract, the rendered evidence and the extra rules.
 */
export function assembleFeedbackPrompt(input: {
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
