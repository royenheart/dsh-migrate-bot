export const ABSORPTION_PROMPT = `You are reviewing a third-party DeepSeek Harness (dsh) plugin against a newer official harness release.

Task: decide whether the official harness has absorbed, partially replaced, or still lacks this plugin's purpose.

Work in the plugin working directory. You MAY edit the plugin so it shrinks, retires features, or stops shadowing official surfaces. dsh-side patches are allowed when the plugin still needs them and official extension points cannot do the job. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Plugin purpose (what it still uniquely does)
2. Official overlap (packages, slots, settings, Agent Notes, or release notes that cover the same job)
3. Verdict: keep | shrink | retire
4. Concrete edits you made or would make
5. Risks

The report is the last markdown document you print. Do not wrap it in a code fence.
`

export const ALIGNMENT_PROMPT = `You are aligning a third-party DeepSeek Harness (dsh) plugin with the official design (plugin-first composition, self-contained dsh.bundle, slots, settings, Agent Notes).

Task: prefer official extension points over a harness patch. First decide whether an existing dsh-side change is still needed. If official seams can do the job, drop or shrink the patch. If they cannot, update or write a patch so the plugin's unique behavior stays complete. Do not change that unique behavior unless official overlap already requires a shrink.

Work in the plugin working directory. You MAY edit code. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Current seams the plugin uses (slots, RPCs, settings, dsh-side changes)
2. Official seams it should use on this harness version
3. Edits you made
4. Remaining gaps that still need a harness patch or a general-purpose harness change (link Discussions if relevant)
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
- Prefer official extension points. If a dsh-side patch is still required for completeness, update or write it.
- Do not commit. Do not open issues or pull requests.

Write a markdown report Cn with:
1. Errors you addressed
2. Root cause
3. Files changed
4. Why this should pass the next mechanical run
5. What you did not change

The report is the last markdown document you print. Do not wrap it in a code fence.
`

export function harnessContextNote(input: { path: string; tag: string }): string {
  return `Harness source for \`${input.tag}\` is at \`${input.path}\`. First read the plugin README and other project docs. Then decide whether any dsh-side change is still needed, or whether official extension points now cover it. If a patch is still required, update or write it, apply it on that checkout to test, and keep the plugin updated. Do not commit the checkout.

For each remaining required patch, write one report at \`.dsh-migrate/patch-reports/<slug>/report.md\`. Search https://github.com/deepseek-ai/deepseek-harness issues, pull requests, and discussions first. If a related request exists, put its links in that report. If none exists, write the report as a discussion draft with these sections: Title (\`# [Feature request] …\`), English summary (blockquote), Background, Current state, Proposal, Appendix: patch, Questions to confirm, Related.
`
}

export function withHarnessContext(
  prompt: string,
  harness: { path: string; tag: string } | undefined,
): string {
  if (harness === undefined) return prompt
  return `${prompt}\n\n${harnessContextNote(harness)}`
}

/**
 * Assemble the follow-up fix session. Full mechanical logs stay out.
 */
export function assembleFixPrompt(input: {
  template: string
  reportA: string
  reportB: string
  errors: string
  priorFixes: readonly string[]
  harness?: { path: string; tag: string } | undefined
}): string {
  const prior = input.priorFixes.length === 0
    ? '(none — this is C1)'
    : input.priorFixes.map((body, index) => `### C${index + 1}\n\n${body}`).join('\n\n')
  return withHarnessContext(`${input.template}

## Report A — official overlap

${input.reportA}

## Report B — design alignment

${input.reportB}

## Latest mechanical errors (errors only)

${input.errors}

## Prior fix reports

${prior}
`, input.harness)
}
