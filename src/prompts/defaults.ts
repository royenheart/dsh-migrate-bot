export const ABSORPTION_PROMPT = `You are reviewing a third-party DeepSeek Harness (dsh) plugin against a newer official harness release.

Task: decide whether the official harness has absorbed, partially replaced, or still lacks this plugin's purpose.

Work in the plugin working directory. You MAY edit the plugin so it shrinks, retires features, or stops shadowing official surfaces. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Plugin purpose (what it still uniquely does)
2. Official overlap (packages, slots, settings, Agent Notes, or release notes that cover the same job)
3. Verdict: keep | shrink | retire
4. Concrete edits you made or would make
5. Risks

The report is the last markdown document you print. Do not wrap it in a code fence.
`

export const ALIGNMENT_PROMPT = `You are aligning a third-party DeepSeek Harness (dsh) plugin with the official design (plugin-first composition, self-contained dsh.bundle, slots, settings, Agent Notes).

Task: re-implement or tidy the plugin so it uses official seams instead of harness forks, private patches, or shadowed internals — without changing the plugin's unique product behavior unless official overlap already requires a shrink.

Work in the plugin working directory. You MAY edit code. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Current seams the plugin uses (slots, RPCs, settings, patches)
2. Official seams it should use on this harness version
3. Edits you made
4. Remaining gaps that still need a general-purpose harness change (link Discussions if relevant)
5. Risks

The report is the last markdown document you print. Do not wrap it in a code fence.
`

export const FIX_PROMPT = `You are fixing a third-party DeepSeek Harness (dsh) plugin after a mechanical compatibility test failed.

You receive:
- Report A (official overlap)
- Report B (design alignment)
- The latest mechanical ERROR LINES ONLY (not the full test log)
- Prior fix reports C1..Cn-1 when this is not the first repair attempt

Rules:
- Use A and B as the source of intent. Do not reopen product-scope debates.
- Treat the error lines as the only test evidence. Do not ask for the full log.
- Make the smallest change that makes those errors go away while staying aligned with A and B.
- Do not commit. Do not open issues or pull requests.

Write a markdown report Cn with:
1. Errors you addressed
2. Root cause
3. Files changed
4. Why this should pass the next mechanical run
5. What you did not change

The report is the last markdown document you print. Do not wrap it in a code fence.
`

/**
 * Assemble the follow-up fix session. Full mechanical logs stay out.
 */
export function assembleFixPrompt(input: {
  template: string
  reportA: string
  reportB: string
  errors: string
  priorFixes: readonly string[]
}): string {
  const prior = input.priorFixes.length === 0
    ? '(none — this is C1)'
    : input.priorFixes.map((body, index) => `### C${index + 1}\n\n${body}`).join('\n\n')
  return `${input.template}

## Report A — official overlap

${input.reportA}

## Report B — design alignment

${input.reportB}

## Latest mechanical errors (errors only)

${input.errors}

## Prior fix reports

${prior}
`
}
