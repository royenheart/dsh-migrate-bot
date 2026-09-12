export const ABSORPTION_PROMPT = `You are reviewing a third-party DeepSeek Harness (dsh) plugin against a newer official harness release.

First principle: preserve the plugin's documented product form. Purpose is what the plugin itself documents — the README feature list, named UI entry points, host enforcement, required patches for a complete surface, and other shipped capabilities. Write that list first, as the plugin states it. Do not rewrite purpose as a residue after subtracting official overlap. Do not drop an entry because the plugin also has a fallback path or silent degrade for unpatched hosts. A degrade or best-effort path is how the plugin survives missing seams; it is not permission to delete that surface from the product.

An entry point is its own capability. Managing workspace skills from a workspace overflow menu is not the same capability as managing them from a settings page, even if both write the same overrides. Official overlap counts only when the harness absorbed that specific surface (the same slot, menu, RPC, or setting). A coarser "same job" done through a different official seam does not absorb the entry.

Task: decide whether the official harness has absorbed, partially replaced, or still lacks each documented capability.

Work in the plugin working directory. You MAY edit the plugin so it shrinks or retires a surface only when official overlap actually absorbed that surface (the harness now ships the same slot, menu, RPC, or behavior). You MAY stop shadowing an official surface the plugin was duplicating. dsh-side patches are allowed — and should be kept or rebased — when a documented complete-surface capability still needs a general-purpose harness change that official extension points do not provide. Do not drop such a patch because a fallback exists. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Plugin purpose (the plugin's documented capabilities and entry points, as the plugin states them — not a uniqueness residue)
2. Official overlap (packages, slots, settings, harness Agent Notes you read as evidence, or release notes that cover the same surface — same slot, menu, RPC, or behavior — not a coarser substitute job)
3. Verdict: keep | shrink | retire
4. Concrete edits you made or would make
5. Risks

The report is the last markdown document you print. Do not wrap it in a code fence.
`

export const ALIGNMENT_PROMPT = `You are aligning a third-party DeepSeek Harness (dsh) plugin with the official design (plugin-first composition, self-contained dsh.bundle, slots, settings).

The harness records its design decisions as Agent Notes under its own \`.agents/notes/\`: read them as evidence, but never write design-note files into this third-party plugin repository — everything left in its tree is proposed to its maintainers as a reviewed pull request.

First principle: keep the plugin's documented unique behavior complete, including every documented entry point. Unique behavior is the plugin's product form, not "whatever remains after preferring official seams".

Prefer an official extension point over a harness patch only when that extension point is the same seam the capability needs (the same slot, menu, RPC, or setting). If official seams can host a coarser or different UX (for example a settings page instead of a workspace-row menu), that is not "doing the job" — keep or rebase the patch so the documented entry stays complete. Do not treat a plugin's silent degrade or best-effort fallback as a reason to drop the patch or the entry. Do not change unique behavior unless official overlap absorbed that specific surface.

If a patch is still required, update or write it so the documented behavior stays complete. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Current seams the plugin uses (slots, RPCs, settings, dsh-side changes)
2. Official seams it should use on this harness version
3. Edits you made
4. Remaining gaps that still need a harness patch or a general-purpose harness change (link Discussions if relevant)
5. Risks

The report is the last markdown document you print — printing it is the deliverable, and it is never written into the plugin tree. Do not wrap it in a code fence.
`

export const FIX_PROMPT = `You are fixing a third-party DeepSeek Harness (dsh) plugin after a compatibility check failed.

You receive:
- Report A (official overlap)
- Report B (design alignment)
- The latest FAILING OUTPUT ONLY (the failing gate's output, not every log)
- A baseline note describing what the plugin did before this run
- Prior fix reports C1..Cn-1 when this is not the first repair attempt

The failure can come from any gate: the fast gate (typecheck, build, unit tests), the boot probe (the plugin did not load, threw during apply, waited forever on a service, or hung the host), or the end-to-end suite.

Rules:
- Use A and B as the source of intent. Do not reopen product-scope debates.
- Treat the failing output as the only evidence you get. Do not ask for more logs.
- Make the smallest change that makes that failure go away while staying aligned with A and B.
- Prefer official extension points. If a dsh-side patch is still required for completeness, update or write it.
- Do not add compiler or toolchain packages (including typescript) to the plugin just to satisfy typecheck. The migrator provides tsc.
- If the baseline note says the plugin was already broken before this run, the fault may come from any harness hop since that version, not only the newest one. Look further back before assuming the latest change caused it.
- Never write design notes, Agent Notes, or other documentation files into the plugin repository; your report is the deliverable.
- Do not edit the end-to-end suite, its configuration, or its snapshots. Those live on a separate branch and are not yours to weaken. If you believe a test itself is wrong, say so in the report; do not change it.
- Do not commit. Do not open issues or pull requests.

Write a markdown report Cn with:
1. Errors you addressed
2. Root cause
3. Files changed
4. Why this should pass the next verification round
5. What you did not change

If, and only if, you conclude the fix cannot be made inside the plugin, end the report with exactly this block — every field is required, and an incomplete block is ignored:

BLOCKER: upstream
REASON: <one sentence>
ATTEMPTED: <the plugin-side fixes you tried, and what happened>
HARNESS: <path:line in the harness source where the change belongs>
WHY-NOT-PLUGIN: <why no plugin-side change can substitute for it>

Do not declare a blocker merely because the problem is hard, and do not declare one you have not tried to fix from the plugin side first. A blocker without all three evidence fields costs a wasted round and is discarded.

The report is the last markdown document you print. Do not wrap it in a code fence.
`

import { discussionDraftSpec } from '../discussion-draft.ts'

export function harnessContextNote(input: { path: string; tag: string }): string {
  return `Harness source for \`${input.tag}\` is at \`${input.path}\`. First read the plugin README, other project docs, and the plugin's patches/ directory (the complete-surface requirement). Treat documented features and entry points as the product spec. Then, for each documented capability, decide whether official overlap absorbed that specific surface — official extension points cover a capability only when they are the same seam (same slot, menu, RPC, or behavior), not when a different official surface could substitute a coarser job. If a patch is still required for the documented complete surface, update or write it, apply it on that checkout to test, and keep the plugin updated. Do not drop a patch because the plugin degrades without it. Do not commit the checkout.

For each remaining required patch, write one report at \`.dsh-migrate/patch-reports/<slug>/report.md\`. Search https://github.com/deepseek-ai/deepseek-harness issues, pull requests, and discussions first. If a related request exists, put its links in that report. If none exists, write the report as a discussion draft with these sections: ${discussionDraftSpec()}.
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
  /** Baseline-vs-target attribution, which scopes how far back to look. */
  baselineNote?: string | undefined
}): string {
  const prior = input.priorFixes.length === 0
    ? '(none — this is C1)'
    : input.priorFixes.map((body, index) => `### C${index + 1}\n\n${body}`).join('\n\n')
  const baseline = input.baselineNote === undefined
    ? ''
    : `
## Baseline (what the plugin did before this run)

${input.baselineNote}
`
  return withHarnessContext(`${input.template}
${baseline}
## Report A — official overlap

${input.reportA}

## Report B — design alignment

${input.reportB}

## Latest failing output

${input.errors}

## Prior fix reports

${prior}
`, input.harness)
}
