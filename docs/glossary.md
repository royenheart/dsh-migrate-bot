---
kind: glossary
description: Every project term once: its definition, its name in code and configuration, and the words it replaces.
---

# Glossary

Every document uses these terms as written here and does not redefine them. *Replaces* lists words that meant the same thing in older documents; `scripts/verify-terms.ts` fails when one of them appears in the prose of a Markdown document, `action.yml` or `examples/`, outside code spans and this page.

## Migrations

| Term | Definition | In code and configuration | Replaces |
|---|---|---|---|
| **release** | One `dsh-v*` tag of `deepseek-ai/deepseek-harness`. | `Release{tag, version}` | — |
| **target release** | The release a migration moves the plugin to. | `target` | — |
| **source release** | The release the plugin worked on before: the target of the last verified migration, or the lowest release the plugin's `@deepseek-ai/dsh-*` ranges admit. | `source` | baseline tag |
| **consumer** | A plugin repository that runs the Action. | `GITHUB_REPOSITORY` | consumer plugin repo, plugin repo |
| **plugin** | A directory whose `package.json` declares `dsh.bundle`; a consumer holds one at its root or several below it. | `Plugin`, `findPlugins` | — |
| **migration** | One consumer and one target release: the unit of work, identified by the target version. | `migrations/<version>/` | migrate run |
| **check** | One of the four keyless checks of a tree against a release: mechanical, boot, web, end-to-end. A check produces a **check result** with an outcome `pass`, `fail` or `skipped`. | `CheckName`, `CheckResult` | gate stack, verification layer, fast gate |
| **mechanical check** | The plugin's build, typecheck and tests with `@deepseek-ai/dsh-*` pinned to the release, and the plugin shape scan. | `mechanical` | — |
| **boot check** | Installing the tree into a temporary profile and starting dsh; it passes when dsh reaches the credential check. | `boot` | boot probe |
| **web check** | Serving a temporary web profile with the plugins mounted and waiting for its ready line. | `web` | web smoke |
| **end-to-end check** | Running the suite of the suite branch against a web profile of the release that serves the tree. | `e2e` | — |
| **end-to-end baseline** | The tests of the suite that pass against the unmodified tree on the source release; each must still pass on the target. | `e2eBaseline`, event `e2e.characterized` | — |
| **failure fingerprint** | The normalised first failing line of a check, compared across repair attempts. | `fingerprint` | failure signature |
| **baseline** | The boot checks of the unmodified tree on the source and the target release, which classify a failure as a `regression`, `pre-existing`, `unaffected` or `unknown`. | `classifyBaseline`, `BaselineClass` | — |
| **overlap review** | The session that decides, per plugin capability, whether the target release provides it. | session kind `overlap`, `prompts.overlap` | review A, absorption review |
| **extension-point review** | The session that maps the plugin's coupling to the extension points of the target release and edits the plugin. | session kind `extension-points`, `prompts.extensionPoints` | review B, alignment review, seam review |
| **repair attempt** | One repair session after a failing check, and the checks that follow it. | session kind `repair`, `repair.maxAttempts` | fix session |
| **stop reason** | Why the repair loop ended without a passing tree. | `STOP_REASONS` | — |
| **upstream blocker** | A repair report that ends in a valid `BLOCKER: upstream` block. | `blocker: valid` | — |
| **spend cap** | The USD one migration may spend. | `quota.limit` | — |
| **extension point** | A slot, RPC, setting or event the harness exposes to plugins. | — | seam |
| **review report** | The Markdown an overlap, extension-point or repair session writes. | `migrations/<version>/reports/` | — |
| **patch report** | A report on one change the plugin still needs from dsh, with the upstream threads that exist or a discussion draft. | `migrations/<version>/patch-reports/` | per-patch report |
| **changed tree** | A working tree with changes outside the ignored paths. | `isTreeChanged` | — |
| **ignored paths** | Paths a migration never commits or counts as a change. | `IGNORED_PATHS` | migrate noise |
| **proposal** | The branch, issue and pull request a migration publishes for a changed tree that passed. | `Proposal`, branch `dsh-migrate/proposal` | migrate PR, migration PR, migrate pull request, migration pull request |
| **state branch** | The branch that holds every migration's event log, its reports and the badge. | `dsh-migrate/state` | seen.json, seen state |
| **event log** | The append-only events of one migration, from which its state is replayed. | `migrations/<version>/events.jsonl` | — |
| **projection** | What is derived from the event logs: the processed release, the verified release and the open proposal. | `Projection` | watch cursor, seen tag |
| **report channel** | A destination and a prompt that receives a merge report when a proposal is merged. | `reports.channels.<id>` | feedback channel |
| **merge report** | The report one channel receives for one merged proposal. | `report.done` | feedback report |
| **comment command** | A `/dsh-migrate <verb>` comment on a proposal's issue or pull request. | `COMMANDS` | command surface |
| **agent runtime** | The dsh installation agent sessions run in, pinned by its own lockfile and independent of the target release. | `container/agent-runtime/` | — |
| **upgrade skills** | The `plugin-upgrade` skill of `oh-my-dsh/dsh-plugin-upgrade-skill`, at the commit the submodule pins. | `agent.upgradeSkills`, `UPGRADE_SKILLS` | community upgrade knowledge |
| **watchdog** | A wall-clock limit on one process or session. | `timeouts.*` | — |

## The deploy service

| Term | Definition | In code and configuration | Replaces |
|---|---|---|---|
| **deploy service** | The HTTP service a consumer runs that serves run log streams and preview deployments and receives preview commands. | `deploy.endpoint` | deploy target |
| **run log stream** | The read-only stream of a running migration's log lines. | `deploy.logStream` | live view |
| **preview deployment** | An instance of the deploy service serving the migrated plugin for manual trial. | `deploy.preview` | preview instance |
| **preview publish** | The `publish` command: the deploy service freezes a preview's working copy, and the Action applies it to the proposal branch and pushes it when the checks pass. | verb `publish`, `applyHandback` | publish hand-back |

## Evaluation

| Term | Definition | In code and configuration | Replaces |
|---|---|---|---|
| **benchmark suite** | The Harbor tasks of `oh-my-dsh/dsh-plugin-upgrade-skill` at the commit `vendor/dsh-plugin-upgrade-skill` pins. | `SUITE_DIR` | exam suite |
| **benchmark task** | One task directory of the suite. | `TaskEntry` | exam task |
| **subject** | What a benchmark run measures: `pipeline`, `pipeline+skills`, `session`, `session+skills` or `oracle`. | `SUBJECTS` | migration mode, native mode |
| **attempt** | One Harbor trial of a subject on a task. In a migration, the word is always **repair attempt**. | `Attempt` | — |
| **attempt outcome** | Why an attempt has its reward or has none: `scored`, `timeout`, `exception` or `infrastructure`. | `OUTCOMES` | — |
| **feasible task** | A task whose reference solution scored 1.0 on every attempt of the newest oracle record. | `feasible` | — |
| **benchmark record** | The immutable result of one benchmark run, on the `bench/records` branch. | `recordSchema` | — |
| **field outcome** | What became of a proposal in a consumer repository, derived from its event log. | `FieldMigration` | — |

## The repository

| Term | Definition | In code and configuration | Replaces |
|---|---|---|---|
| **rules** | The instructions in `AGENTS.md` that every agent session in this repository follows. | — | standing orders |
| **gate** | A deterministic repository check run by `npm run gates`. | `scripts/verify-*.ts` | — |
| **postmortem** | A dated account of an incident under `docs/postmortems/`. | — | — |
