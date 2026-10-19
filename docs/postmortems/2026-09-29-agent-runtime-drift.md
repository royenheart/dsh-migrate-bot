---
kind: postmortem
description: Every agent session failed from 2026-09-29 because the image's dsh resolved a newer transitive release.
---

# 2026-09-29: every agent session failed after a transitive dependency release

## What broke

From the scheduled runs of 2026-09-29 until the fix, every migration in every consumer repository failed in its first agent session with `dsh agent failed (1)` and `Error: dsh: user patch-layer watching requires the Cordis HMR service`. No migration ran for two weeks.

## Why

The image installed `@deepseek-ai/dsh@0.1.1-rc.2` with `npm install -g`, without a lockfile. That release declares `@deepseek-ai/cordis` and `@deepseek-ai/cordis-plugin-hmr` as caret ranges. cordis 4.0.4 and cordis-plugin-hmr 1.0.19 were published on 2026-09-22 at 15:36 UTC; every image built after that resolved them. cordis-plugin-hmr 1.0.19 registers its service through `Inject`, so the old app-boot no longer found it, and the migrate profile's patch layer (`cordis.patch.yml`) requires that service. The run of 2026-09-22 started at 13:02 UTC and was the last to succeed.

The same coupling had caused the failures of 2026-09-08, when the `anchored-standard` preset no longer mounted `persona` on the dsh version the image carried. In both cases the dsh the agent sessions run in changed without any change in this repository, and the failure was reported as a failed migration rather than a fault of the Action.

## What changed

- The agent runtime is pinned by a committed lockfile and installed with `npm ci`, and it is upgraded deliberately ([the agent runtime](../design/checks.md#the-agent-runtime)).
- The runtime moved to dsh 0.2.0-rc.2, and the migrate profile no longer mounts the retired `@deepseek-ai/dsh-agent-presets`.
- A self-test starts one keyless session at image build and before every run's first session; a failure is reported as status `error`, not as a failed migration.
