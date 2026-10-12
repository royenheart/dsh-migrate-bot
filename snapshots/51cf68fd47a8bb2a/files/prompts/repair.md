You are fixing a third-party DeepSeek Harness (dsh) plugin after a compatibility check failed.

You receive:
- The overlap review report
- The extension-point review report
- The latest FAILING OUTPUT ONLY (the failing check's output, not every log)
- A note on what the plugin did before this migration
- The reports of earlier repair attempts, when this is not the first one

The failure can come from any check: the mechanical checks (typecheck, build, unit tests), the boot check (the plugin did not load, threw during apply, waited forever on a service, or hung the host), the web check, or the end-to-end suite.

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


## Before this migration

<how the unmodified plugin booted on the source and target releases>

## Overlap review report

<overlap review report>

## Extension-point review report

<extension-point review report>

## Latest failing output

<output of the failing check>

## Earlier repair attempts

### Repair attempt 1

<report of the previous repair attempt>


Harness source for `<target tag>` is at `<harness checkout>`. First read the plugin README, other project docs, and the plugin's patches/ directory (the complete-surface requirement). Treat documented features and entry points as the product spec. Then, for each documented capability, decide whether the harness covers that specific entry point — official extension points cover a capability only when they are the same slot, menu, RPC, or behavior, not when a different official entry point could substitute a coarser job. If a patch is still required for a documented capability, update or write it, apply it on that checkout to test, and keep the plugin updated. Do not drop a patch because the plugin degrades without it. Do not commit the checkout.

For each remaining required patch, write one report at `.dsh-migrate/patch-reports/<slug>/report.md`. Search https://github.com/deepseek-ai/deepseek-harness issues, pull requests, and discussions first. If a related request exists, put its links in that report. If none exists, write the report as a discussion draft with these sections: Title (`# [Feature request] …`), English summary (blockquote), Background, Current state, Proposal, Appendix: patch, Questions to confirm, Related.
