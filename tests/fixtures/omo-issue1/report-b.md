# dsh-plugin-opencode-omo alignment report for `dsh-v0.1.1-rc.2`

## 1. Current seams the plugin uses (slots, RPCs, settings, dsh-side changes)

**Bundle and preset publication**

- The package is a self-contained dsh bundle: `package.json#dsh.bundle.patch`
  points at `cordis.patch.yml`, and `cordis.patch.yml` inserts the plugin's own
  host row plus `@deepseek-ai/dsh-web-fetch-http` into the shared `ctx.web`.
- The browser half is packaged through the official `dsh.client` manifest
  (`platform: web`, inject edges to `dsh-client-connection`, `-runtime`,
  `-ui-conversation`, `-ui-settings`, and `-ui-settings-general`).

## 2. Official seams it should use on this harness version

Keep the published preset root and `conversation.input.left` slot. Prefer the
native `agent/pre-step` return once `assistantPrefill` lands upstream.

## 3. Edits you made

Updated README and design.md to describe the remaining patch and the degraded
system-prompt fallback. Left the patch file in `patches/`.

## 4. Remaining gaps that still need a harness patch

`PreStepDecision.assistantPrefill` — tracked in discussion #2407. Format and
toolChoice stay a proposal; omo's regular path does not use them.

## 5. Risks

Applying the patch on a future harness tag may need a refresh if the loop
types move.
