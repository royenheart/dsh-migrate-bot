# Documentation index

The entry point for progressive disclosure: `AGENTS.md` carries the standing orders and links here, and this table sends a reader to the one document — and the one section — that owns a subject. Read the two rows for [README.md](../README.md) and [AGENTS.md](../AGENTS.md) first; everything else is looked up when a task needs it rather than read up front.

`scripts/verify-doc-index.ts` computes every entry point below from the target document's actual headings, and fails when a section is renamed, a home disappears, or a document is added without a row. The shape is fixed for the same reason: one topic, one backticked home path, and exactly one link, whose path must equal the home and whose fragment must name a real section.

| Topic | Home | Entry point |
|---|---|---|
| The product, its inputs and outputs, and how to consume the Action | `README.md` | [Usage](../README.md#what-it-does) |
| Where to start as a contributor, and what to run before pushing | `README.md` | [Contributing](../README.md#contributing) |
| Installing the Action: secrets, the workflow, permissions, report channels, the deploy service | `docs/operations/install.md` | [The workflow](operations/install.md#the-workflow) |
| Releasing the Action | `docs/operations/release.md` | [Releasing](operations/release.md#releasing) |
| How a migration runs as a statechart over an event log, and why | `docs/design/workflow.md` | [Decisions](design/workflow.md#1-decisions) |
| The invariants the workflow keeps, and the tests that hold them | `docs/design/workflow.md` | [Invariants](design/workflow.md#3-invariants) |
| What the state branch stores, and what is derived from it | `docs/design/workflow.md` | [The state branch](design/workflow.md#4-the-state-branch) |
| Merge reports: the channels, their evidence, and their tokens | `docs/design/workflow.md` | [Merge reports](design/workflow.md#8-merge-reports) |
| Every state, transition and guard of the migration statechart | `docs/reference/workflow.md` | [States](reference/workflow.md#states) |
| The comment commands | `docs/reference/commands.md` | [Comment commands reference](reference/commands.md#comment-commands-reference) |
| The four checks, the end-to-end suite branch, and watchdogs | `docs/design/checks.md` | [The four checks](design/checks.md#the-four-checks) |
| The agent runtime and its self-test | `docs/design/checks.md` | [The agent runtime](design/checks.md#the-agent-runtime) |
| The 2026-09-29 outage of every agent session | `docs/postmortems/2026-09-29-agent-runtime-drift.md` | [What broke](postmortems/2026-09-29-agent-runtime-drift.md#what-broke) |
| Every configuration key, its type and its default | `docs/reference/configuration.md` | [Configuration reference](reference/configuration.md#configuration-reference) |
| The two places a migration session can run, one of them shipped | `docs/design/preview-and-live-view.md` | [Two run paths, one of them shipped](design/preview-and-live-view.md#2-two-run-paths-one-of-them-shipped) |
| The read-only live view of a running migration | `docs/design/preview-and-live-view.md` | [The live view](design/preview-and-live-view.md#3-the-live-view) |
| The calls a deploy target must serve, and what it owes beyond their shape | `docs/design/preview-and-live-view.md` | [The target's API](design/preview-and-live-view.md#8-the-targets-api) |
| What a target must answer for a publish, and who pushes the change | `docs/design/preview-and-live-view.md` | [The publish hand-back](design/preview-and-live-view.md#81-the-publish-hand-back) |
| The preview instance: scratch iteration, the safe entry, lifetime, and what it may not do | `docs/design/preview-and-live-view.md` | [The preview instance](design/preview-and-live-view.md#4-the-preview-instance) |
| Access control for a preview, and why a URL is not a secret | `docs/design/preview-and-live-view.md` | [Access control](design/preview-and-live-view.md#5-access-control) |
| Which actions run the gates, and which are advice | `docs/design/preview-and-live-view.md` | [Gate policy](design/preview-and-live-view.md#7-gate-policy) |
| Standing orders for every agent session in this repository | `AGENTS.md` | [Rules](../AGENTS.md#rules) |
| How documentation is organised, written, and kept from drifting | `docs/AGENTS.md` | [The tier taxonomy: one home per fact](AGENTS.md#the-tier-taxonomy-one-home-per-fact) |
| Scoring this Action against the community benchmark suite | `docs/upstream-benchmark.md` | [Preparations](upstream-benchmark.md#preparations) |
| The latest measured rewards, generated from the run records | `README.md` | [Upstream benchmark](../README.md#benchmark) |
| What those results mean, and which of them are not defects | `docs/upstream-benchmark.md` | [Reading the results](upstream-benchmark.md#reading-the-results) |
| What the benchmark exercise found wrong in our own code | `docs/upstream-benchmark.md` | [What this exercise exposed in our own code](upstream-benchmark.md#what-this-exercise-exposed-in-our-own-code) |
| The record format each benchmark run writes, and the rules that make it reproducible | `reports/README.md` | [The record format](../reports/README.md#the-record-format-schema-2) |
| The continuous quality-tracking framework this repository is converging on | `docs/design/continuous-quality-tracking.md` | [Proposed design](design/continuous-quality-tracking.md#5-proposed-design) |
