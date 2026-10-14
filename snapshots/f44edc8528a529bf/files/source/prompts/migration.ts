export const OVERLAP_PROMPT = `You are reviewing a third-party DeepSeek Harness (dsh) plugin against a newer official harness release.

First principle: preserve the plugin's documented product form. Purpose is what the plugin itself documents — the README feature list, named UI entry points, host enforcement, required patches for a complete surface, and other shipped capabilities. Write that list first, as the plugin states it. Do not rewrite purpose as a residue after subtracting official overlap. Do not drop an entry because the plugin also has a fallback path or silent degrade for unpatched hosts. A degrade or best-effort path is how the plugin survives missing extension points; it is not permission to delete that entry point from the product.

An entry point is its own capability. Managing workspace skills from a workspace overflow menu is not the same capability as managing them from a settings page, even if both write the same overrides. Official overlap counts only when the harness covers that specific entry point (the same slot, menu, RPC, or setting). A coarser "same job" done through a different official extension point does not cover the entry point.

Task: decide whether the official harness covers, partially covers, or still lacks each documented capability.

Work in the plugin working directory. You MAY edit the plugin so it shrinks or retires an entry point only when the harness covers it (the harness now ships the same slot, menu, RPC, or behavior). You MAY stop duplicating an official entry point the plugin was shadowing. dsh-side patches are allowed — and should be kept or rebased — when a documented capability still needs a general-purpose harness change that official extension points do not provide. Do not drop such a patch because a fallback exists. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Plugin purpose (the plugin's documented capabilities and entry points, as the plugin states them — not a uniqueness residue)
2. Official overlap (packages, slots, settings, harness Agent Notes you read as evidence, or release notes that cover the same entry point — same slot, menu, RPC, or behavior — not a coarser substitute job)
3. Decision: keep | shrink | retire
4. Concrete edits you made or would make
5. Risks

The report is the last markdown document you print. Do not wrap it in a code fence.
`

export const EXTENSION_POINTS_PROMPT = `You are mapping a third-party DeepSeek Harness (dsh) plugin onto the official extension points of a harness release (plugin-first composition, self-contained dsh.bundle, slots, settings).

The harness records its design decisions as Agent Notes under its own \`.agents/notes/\`: read them as evidence, but never write design-note files into this third-party plugin repository — everything left in its tree is proposed to its maintainers as a reviewed pull request.

First principle: keep the plugin's documented unique behavior complete, including every documented entry point. Unique behavior is the plugin's product form, not "whatever remains after preferring official extension points".

Prefer an official extension point over a harness patch only when that extension point is the one the capability needs (the same slot, menu, RPC, or setting). If official extension points can host a coarser or different UX (for example a settings page instead of a workspace-row menu), that is not "doing the job" — keep or rebase the patch so the documented entry stays complete. Do not treat a plugin's silent degrade or best-effort fallback as a reason to drop the patch or the entry. Do not change unique behavior unless the harness covers that specific entry point.

If a patch is still required, update or write it so the documented behavior stays complete. You MAY run small checks. Do not commit. Do not open issues or pull requests.

Write a markdown report with these sections:
1. Extension points the plugin uses now (slots, RPCs, settings, dsh-side changes)
2. Official extension points it should use on this harness release
3. Edits you made
4. Remaining gaps that still need a harness patch or a general-purpose harness change (link Discussions if relevant)
5. Risks

The report is the last markdown document you print — printing it is the deliverable, and it is never written into the plugin tree. Do not wrap it in a code fence.
`

export const REPAIR_PROMPT = `You are fixing a third-party DeepSeek Harness (dsh) plugin after a compatibility check failed.

You receive:
- The overlap review report
- The extension-point review report
- The latest FAILING OUTPUT ONLY (the failing check's output, not every log)
- A note on what the plugin did before this migration
- The reports of earlier repair attempts, when this is not the first one

The failure can come from any check: the mechanical checks (typecheck, build, unit tests), the boot check (the plugin did not load, threw during apply, waited forever on a service, or hung the host), the web check, or the end-to-end suite. An end-to-end failure lists the tests that passed against the unmodified plugin on the source release and no longer pass: a feature a user could reach before this migration and cannot now.

Rules:
- Use the two review reports as the source of intent. Do not reopen product-scope debates.
- Treat the failing output as the only evidence you get. Do not ask for more logs.
- Make the smallest change that makes that failure go away while staying aligned with the review reports.
- Prefer official extension points. If a dsh-side patch is still required for completeness, update or write it.
- Do not add compiler or toolchain packages (including typescript) to the plugin just to satisfy typecheck. The migrator provides tsc.
- If the note says the plugin was already broken before this migration, the fault may come from any release since that version, not only the newest one. Look further back before assuming the latest change caused it.
- Never write design notes, Agent Notes, or other documentation files into the plugin repository; your report is the deliverable.
- Do not edit the end-to-end suite, its configuration, or its snapshots. Those live on a separate branch and are not yours to weaken. If you believe a test itself is wrong, say so in the report; do not change it.
- Do not commit. Do not open issues or pull requests.

Write a markdown report with:
1. Errors you addressed
2. Root cause
3. Files changed
4. Why this should pass the next checks
5. What you did not change

If, and only if, you conclude the fix cannot be made inside the plugin, end the report with exactly this block — every field is required, and an incomplete block is ignored:

BLOCKER: upstream
REASON: <one sentence>
ATTEMPTED: <the plugin-side fixes you tried, and what happened>
HARNESS: <path:line in the harness source where the change belongs>
WHY-NOT-PLUGIN: <why no plugin-side change can substitute for it>

Do not declare a blocker merely because the problem is hard, and do not declare one you have not tried to fix from the plugin side first. A blocker without all three evidence fields costs a wasted attempt and is discarded.

The report is the last markdown document you print. Do not wrap it in a code fence.
`

import { discussionDraftSpec } from './discussion-draft.ts'
import { inline } from '../render/text.ts'

export function harnessContextNote(input: { path: string; tag: string }): string {
  // The tag is a resolved version, and it is interpolated into a prompt an
  // agent reads with an API key in its environment: one line of it.
  return `Harness source for \`${inline(input.tag, 80)}\` is at \`${input.path}\`. First read the plugin README, other project docs, and the plugin's patches/ directory (the complete-surface requirement). Treat documented features and entry points as the product spec. Then, for each documented capability, decide whether the harness covers that specific entry point — official extension points cover a capability only when they are the same slot, menu, RPC, or behavior, not when a different official entry point could substitute a coarser job. If a patch is still required for a documented capability, update or write it, apply it on that checkout to test, and keep the plugin updated. Do not drop a patch because the plugin degrades without it. Do not commit the checkout.

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
 * The prompt of repair attempt n. Full mechanical logs stay out: only the
 * failing check's output is given.
 */
export function assembleRepairPrompt(input: {
  template: string
  overlapReport: string
  extensionPointsReport: string
  failingOutput: string
  priorRepairs: readonly string[]
  harness?: { path: string; tag: string } | undefined
  /** What the plugin did before this migration, which scopes how far back to look. */
  baselineNote?: string | undefined
}): string {
  const prior = input.priorRepairs.length === 0
    ? '(none: this is the first repair attempt)'
    : input.priorRepairs.map((body, index) => `### Repair attempt ${String(index + 1)}\n\n${body}`).join('\n\n')
  const baseline = input.baselineNote === undefined
    ? ''
    : `
## Before this migration

${input.baselineNote}
`
  return withHarnessContext(`${input.template}
${baseline}
## Overlap review report

${input.overlapReport}

## Extension-point review report

${input.extensionPointsReport}

## Latest failing output

${input.failingOutput}

## Earlier repair attempts

${prior}
`, input.harness)
}

/**
 * The change cards a migration crosses and the ledger the sessions keep of
 * them, appended to the extension-point review and to every repair attempt.
 */
export function cardLedgerNote(input: { cards: string; source: string; target: string; path: string }): string {
  return `## Change cards

The upgrade skill lists, card by card, the changes each release made a plugin face. This migration crosses these, after ${inline(input.source, 80)} up to ${inline(input.target, 80)}:

${input.cards}

Keep a ledger of them at \`${input.path}\`, outside the plugin tree, with one entry for every card above, shaped exactly like this:

\`\`\`json
{ "cards": [ { "id": "DSH-0.1.2-A1-25", "applies": true, "required": true, "status": "done", "evidence": ["client.js:12", "package.json"], "note": "imports moved to dsh-client-store" } ] }
\`\`\`

- \`applies\`: whether the change touches this plugin: it uses the API, package, slot, setting or behaviour the card names.
- \`required\`: whether this migration must act on it. A card that applies is required when its level is \`required\`, \`required-if-hit\`, or \`conditional\` with its condition met. An \`optional\` capability card that applies is required too when the plugin carries a patch, monkey-patch, shim, private API call or local workaround that the card's capability or recipe replaces: once the release offers the public way, a migration retires the workaround. Otherwise it is not required.
- \`status\`: \`done\` when acted on, with \`evidence\` naming the files that show it (\`path\` or \`path:line\`, relative to the plugin repository); \`not-needed\` when it does not apply or is not required; \`open\` when it is required and not done.
- \`note\`: one line on why.

After your edits the cards check fails while a card is missing from the ledger, a required card is not done, or its evidence names a file that does not exist. Update the ledger whenever you change the plugin.`
}
