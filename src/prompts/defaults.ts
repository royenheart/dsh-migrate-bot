export const ABSORPTION_PROMPT = `You are reviewing a third-party DeepSeek Harness (dsh) plugin against a newer official harness release.

First principle: preserve the plugin's documented product form. Purpose is what the plugin itself documents — the README feature list, named UI entry points, host enforcement, required patches for a complete surface, and other shipped capabilities. Write that list first, as the plugin states it. Do not rewrite purpose as a residue after subtracting official overlap. Do not drop an entry because the plugin also has a fallback path or silent degrade for unpatched hosts. A degrade or best-effort path is how the plugin survives missing seams; it is not permission to delete that surface from the product.

An entry point is its own capability. Managing workspace skills from a workspace overflow menu is not the same capability as managing them from a settings page, even if both write the same overrides. Official overlap counts only when the harness absorbed that specific surface (the same slot, menu, RPC, or setting). A coarser "same job" done through a different official seam does not absorb the entry.

Task: decide whether the official harness has absorbed, partially replaced, or still lacks each documented capability.

Work in the plugin working directory. You MAY edit the plugin so it shrinks or retires a surface only when official overlap actually absorbed that surface (the harness now ships the same slot, menu, RPC, or behavior). You MAY stop shadowing an official surface the plugin was duplicating. dsh-side patches are allowed — and should be kept or rebased — when a documented complete-surface capability still needs a general-purpose harness change that official extension points do not provide. Do not drop such a patch because a fallback exists. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Plugin purpose (the plugin's documented capabilities and entry points, as the plugin states them — not a uniqueness residue)
2. Official overlap (packages, slots, settings, Agent Notes, or release notes that cover the same surface — same slot, menu, RPC, or behavior — not a coarser substitute job)
3. Verdict: keep | shrink | retire
4. Concrete edits you made or would make
5. Risks

The report is the last markdown document you print. Do not wrap it in a code fence.
`

export const ALIGNMENT_PROMPT = `You are aligning a third-party DeepSeek Harness (dsh) plugin with the official design (plugin-first composition, self-contained dsh.bundle, slots, settings, Agent Notes).

First principle: keep the plugin's documented unique behavior complete, including every documented entry point. Unique behavior is the plugin's product form, not "whatever remains after preferring official seams".

Prefer an official extension point over a harness patch only when that extension point is the same seam the capability needs (the same slot, menu, RPC, or setting). If official seams can host a coarser or different UX (for example a settings page instead of a workspace-row menu), that is not "doing the job" — keep or rebase the patch so the documented entry stays complete. Do not treat a plugin's silent degrade or best-effort fallback as a reason to drop the patch or the entry. Do not change unique behavior unless official overlap absorbed that specific surface.

If a patch is still required, update or write it so the documented behavior stays complete. You MAY run small checks. Do not commit. Do not open issues or pull requests.

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
- Do not add compiler or toolchain packages (including typescript) to the plugin just to satisfy mechanical typecheck. The migrator provides tsc.
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
  return `Harness source for \`${input.tag}\` is at \`${input.path}\`. First read the plugin README, other project docs, and the plugin's patches/ directory (the complete-surface requirement). Treat documented features and entry points as the product spec. Then, for each documented capability, decide whether official overlap absorbed that specific surface — official extension points cover a capability only when they are the same seam (same slot, menu, RPC, or behavior), not when a different official surface could substitute a coarser job. If a patch is still required for the documented complete surface, update or write it, apply it on that checkout to test, and keep the plugin updated. Do not drop a patch because the plugin degrades without it. Do not commit the checkout.

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
