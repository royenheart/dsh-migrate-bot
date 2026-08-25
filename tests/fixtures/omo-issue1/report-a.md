# dsh-plugin-opencode-omo review against `dsh-v0.1.1-rc.2`

Reviewed harness checkout: `/github/workspace/.dsh-migrate/harness`, tag
`dsh-v0.1.1-rc.2`, commit `b150a55` (“Merge pull request #2908 from
deepseek-harness/release/dsh-0.1.1-rc.2”). Plugin tested with npm packages at
`@deepseek-ai/*@0.1.1-rc.2`.

GitHub search was run first (issues, pull requests, and discussions; the repo
has discussions enabled and issues disabled). The exact upstream request for
the one remaining dsh patch already exists as
[discussion #2407](https://github.com/deepseek-ai/deepseek-harness/discussions/2407).
An adjacent but non-substitute proposal is a later format/toolChoice discussion
that does not replace the assistantPrefill request.

## 1. Plugin purpose (what it still uniquely does)

opencode-omo keeps a native dsh loop that restores opencode maxSteps, role
routing, and ultrawork behavior. That is still unique after `dsh-v0.1.1-rc.2`.

## 2. Official overlap

Official slots, presets, and system-prompt seams now cover the composer picker
and most prompt assembly. `PreStepDecision.assistantPrefill` is still missing.

## 3. Verdict

keep

## 4. Concrete edits

Documented the remaining patch against discussion #2407 and changed the
unpatched fallback from a synthetic user message to a system-prompt section.

## 5. Risks

The shipped patch still has to be applied on the harness checkout for full
maxSteps fidelity. Without it, text is identical but position degrades.
