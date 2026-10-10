---
kind: design
description: How a migration runs as a statechart over an event log on the state branch, and why it is built that way.
---

# The migration workflow

A migration is one consumer repository moving to one target release. This document explains how a migration is specified, executed, stored, and reported. The generated [workflow reference](../reference/workflow.md) lists every state, transition, guard and event.

## 1. Decisions

| Question | Decision | Reason |
|---|---|---|
| Where the workflow is defined | One XState v5 statechart, `src/workflow/machine.ts`, used as data | The machine is the only list of states, events and activities; the reference is generated from it and the tests replay it, so the three cannot disagree |
| How it is executed | The in-job engine, `src/workflow/engine.ts`, inside one GitHub Actions job | The project runs no long-lived host; a job is the only place code runs |
| Where state lives | An append-only event log per migration on the `dsh-migrate/state` branch of the consumer | A job keeps nothing between runs; the branch is the one durable store a consumer already grants write access to |
| What is stored | Events only; the processed release, the verified release and the open proposal are derived | A stored summary next to the log could disagree with it |
| How effects are made safe to repeat | Every effect finds what an earlier attempt made before it creates anything | A job can be cancelled between an effect and the log write that records it |
| Language | TypeScript | The domain code and its tests already exist in TypeScript; a Go rewrite was evaluated and rejected because its two advantages, a static binary for self-hosted workers and generated Temporal bindings, do not apply to a project whose workers are GitHub jobs |
| Durable engine (Temporal) | Not now | A Temporal server inside a job keeps nothing between jobs, so cross-event state would still live on the state branch. The engine interface (`start`, `deliver`, `status`) maps onto Temporal's start, signal and query; an adapter becomes useful when a long-lived server exists |
| Message schemas | zod schemas in `src/workflow/model.ts` | One language reads and writes the log; protobuf code generation would add a toolchain without a second consumer of the schemas |

## 2. The statechart

The machine performs no I/O. A state that needs work declares one `run` entry action whose parameters name an activity; the engine executes the activity and sends its result back as an event. Every state either runs exactly one activity, decides immediately from guards, or waits for an event from outside the job.

The lifecycle, in order:

1. **Pre-migration boot checks.** When the boot check is enabled, the unmodified tree is booted on the source release and on the target release. The two results classify a failure as a regression, pre-existing, or unaffected (`src/domain/outcome.ts`); the repair prompt and the proposal state the class.
2. **Initial checks.** Under the `when-checks-fail` review policy, and when the unmodified tree did not fail to boot on the target, every check runs on the unmodified tree. If all pass, the migration concludes without an agent session.
3. **Reviews.** The overlap review and the extension-point review run once. Both may edit the tree.
4. **Checks and repair attempts.** A pass of checks runs after the reviews and after every repair attempt. A failing check leads to a repair attempt while attempts are left and the failure fingerprint differs from the one the previous attempt was given; otherwise the migration fails, unless the only failure is an end-to-end check under the `advisory` policy.
5. **Final checks.** When the attempt pass ran only a subset of the end-to-end suite, the whole suite runs once more.
6. **End-to-end authoring.** An agent session writes or extends the suite on its own branch. Its failure becomes a warning in the proposal and never stops the migration.
7. **Conclusion.** An unchanged tree ends `compatible`. A changed tree becomes a proposal, or ends `unpublished` when publishing is off.
8. **Waiting for the merge.** The proposal waits in `awaitingMerge`. A merge starts the reporting pass and then `accepted`; a close without merge ends `rejected`; a later migration that takes over the proposal ends it `superseded`.

The checks of each pass are listed in the reference under *Check passes*; [the checks design](checks.md) explains each check.

## 3. Invariants

Each invariant is a fast-check property over generated runs of the machine (`tests/unit/workflow-machine.test.ts`), or a test of the start decision and the projection (`tests/unit/workflow-state.test.ts`).

| Id | Invariant | Where it holds |
|---|---|---|
| I1 | At most one open proposal per consumer; a newer release takes over the open proposal instead of opening a second | `decideStart` inherits the open proposal; a migration publishes at most once |
| I2 | A release is verified only by a compatible migration or a merged proposal | The projection |
| I3 | The repair loop runs at most `repair.maxAttempts` attempts and stops early only on a repeated failure fingerprint or an upstream blocker with every evidence field | The `canRepair` and `blockerValid` guards |
| I4 | Nothing is concluded from a tree whose last pass failed, except an advisory end-to-end failure | The `evaluating` state |
| I5 | A channel does not receive the same merge report twice unless the report is resent | `delivered` in the context |
| I6 | A comment delivered twice is handled once | The `newComment` guard; the reply marker |
| I7 | A spend-cap breach ends the migration before anything is published | The `spendCap` guard |
| I8 | Text from outside the Action (agent output, GitHub bodies) is collapsed to one line before it reaches a log line or a workflow command | `inline()` in `src/render/text.ts` at every log site |

## 4. The state branch

The state branch is the Action's database. It is written with git plumbing and never checked out, so the plugin working tree is untouched.

| Path | Content | Why it is stored |
|---|---|---|
| `migrations/<version>/events.jsonl` | The event log of the migration to `<version>`: one `started` entry per run, then one entry per event | Every later decision is derived from it, and it is the audit record of what the Action did |
| `migrations/<version>/reports/<name>.md` | The overlap, extension-point and repair reports | A merge report quotes them after the job that wrote them is gone |
| `migrations/<version>/patch-reports/<slug>.md` | The patch reports the reviews wrote | The duplicate check of `harness-discussion` posts these drafts |
| `badge.json` | The shields.io endpoint for the README badge | shields.io reads a file; it is rewritten from the projection in the same commit as every log write |

A forced re-run of a release appends a new `started` entry to the same log; only the latest run counts. A log line that does not validate stops the read with an error instead of being skipped, because skipping it would silently change the derived state.

The projection (`src/workflow/projection.ts`) replays each log and derives:

- the **processed release**: the newest release whose migration did not end in `error`, so a failure in the Action is retried on the next schedule and a failed migration is not;
- the **verified release**: the newest release whose migration ended `compatible` or whose proposal was merged;
- the **open proposal**: the migration waiting for its merge.

## 5. The engine

`InJobEngine.start` appends a `started` entry and advances the migration; `deliver` appends an external event and advances it; `status` returns the projection. To advance, the engine replays the log, runs the activity the current state asks for, appends the result, and repeats until the machine reaches a final or waiting state. An activity that throws becomes `activity.error`.

The log is pushed after every activity with an effect outside the job (`publishProposal`, `deliverReport`) and once when the engine stops. An activity without an outside effect is not pushed on its own, because its only product is the working tree, which a later job does not have. A replay keeps the activity a state asked for across an event that state ignores, so a reporting pass cut short by a cancelled job resumes when the merge event is delivered again.

Writers are serialised by the reusable workflow's concurrency group. A push that still loses a race is rebuilt on the new tip when the other writer changed none of this write's files, and is refused when it did; logs are never merged.

## 6. Starting a migration

`decideStart` (`src/workflow/start.ts`) runs before a migration exists, so a skipped run leaves no log. It skips when the target release was already processed and the run is not forced, and when the open proposal carries commits a maintainer pushed. Otherwise it starts the migration with the open proposal as input; when the new migration publishes, it updates that proposal's branch, issue and pull request, and the engine delivers `proposal.superseded` to the migration that opened it.

A run also stops before the machine starts when the agent runtime fails its self-test, which is reported as status `error` (see [the checks design](checks.md#the-agent-runtime)).

## 7. Activities and their effects

| Activity | Effect | How a repeat is harmless |
|---|---|---|
| `check` | None outside the job | — |
| `session` | API spend | Not repeated: a job that dies before publishing restarts the migration from its start |
| `authorE2E` | Pushes the suite branch | The branch is rebuilt and force-pushed with a lease |
| `inspectTree` | None | — |
| `publishProposal` | Pushes `dsh-migrate/proposal`; creates or updates the issue and the pull request; comments the patch reports | The branch is force-pushed; the issue and pull request are the inherited ones or the open ones carrying the proposal marker; the comments carry a marker per migration |
| `deliverReport` | Creates an issue or a discussion in the channel's repository | The log records each delivery before the next one, and the machine skips channels that already took the report |

## 8. Merge reports

When a proposal is merged, each enabled report channel receives one report. A channel is a destination, a token, and a prompt; the built-in channels and their tokens are in the [configuration reference](../reference/configuration.md).

| Channel | Destination | Session |
|---|---|---|
| `upgrade-skill` | An issue in `oh-my-dsh/dsh-plugin-upgrade-skill`, shaped as that project's bug report | Reports a version card that the migration contradicts, or a release edge without one |
| `migrate-bot` | An issue in `royenheart/dsh-migrate-bot` | Attributes what the maintainer fixed by hand to the stage that should have caught it |
| `harness-discussion` | A discussion in `deepseek-ai/deepseek-harness` | Decides whether each discussion draft the reviews wrote is still unasked; it posts the draft itself and writes nothing new |

The evidence of a report is collected when the report is due (`src/merge-reports/evidence.ts`): the pull request and its human comments and reviews from the GitHub API, the changes a maintainer pushed after the Action's last push (`compare/<proposal head>...<pull request head>`), and the reports and patch reports from the state branch. The duplicate check also searches the harness repository's issues, pull requests and discussions for each draft title. A session prints one fenced JSON block; output that does not validate is a failed channel, never a partial issue.

Patch reports reach the harness project in two ways. During the migration, the reviews write one report per dsh-side change the plugin still needs; a report without a link to an existing upstream thread is a discussion draft, and `publishProposal` comments it on the proposal issue with a link that opens a new Ideas discussion for a maintainer to paste it into. After the merge, the `harness-discussion` channel can post the drafts itself.

A channel needs its own token because the workflow's `GITHUB_TOKEN` is minted for the consumer repository only. Writing to a repository the consumer does not own needs a classic personal access token with `public_repo` scope, which can write every public repository its account can, or a GitHub App installed in the destination; a fine-grained token cannot reach an unaffiliated repository. Every channel is therefore off by default, and the migration itself never writes outside the consumer repository.

A channel without its token, or a run without an API key, is skipped with the reason. The `/dsh-migrate report` command sends the report before a merge, `--resend` sends it again, and `--dry-run` shows each channel's payload without delivering it.

## 9. Comment commands

A comment on a proposal's issue or pull request runs one command from the [command reference](../reference/commands.md). Only commenters whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` may run commands, and a bot never may. The reply is posted once per comment: it carries the comment id in a hidden marker, and a second delivery of the same comment finds it. The deploy-service commands send an `Idempotency-Key` derived from the comment, as [the preview design](preview-and-live-view.md) specifies.
