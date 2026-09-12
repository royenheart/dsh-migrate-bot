# Documentation index

The entry point for progressive disclosure: `AGENTS.md` carries the standing orders and links here, and this table sends a reader to the one document — and the one section — that owns a subject. Read the two rows for [README.md](../README.md) and [AGENTS.md](../AGENTS.md) first; everything else is looked up when a task needs it rather than read up front.

`scripts/verify-doc-index.ts` computes every entry point below from the target document's actual headings, and fails when a section is renamed, a home disappears, or a document is added without a row. The shape is fixed for the same reason: one topic, one backticked home path, and exactly one link, whose path must equal the home and whose fragment must name a real section.

| Topic | Home | Entry point |
|---|---|---|
| The product, its inputs and outputs, and how to consume the Action | `README.md` | [Usage](../README.md#usage) |
| Where to start as a contributor, and what to run before pushing | `README.md` | [Contributing](../README.md#contributing) |
| Installing the Action, and every configuration key and its default | `docs/installation.md` | [Install](installation.md#install) |
| Enabling a feedback channel, the token each one needs, and writing your own | `docs/installation.md` | [Feedback channels](installation.md#feedback-channels) |
| The checklist an agent follows when configuring this Action for someone | `docs/installation.md` | [Agent checklist](installation.md#agent-checklist) |
| How a merged migrate pull request becomes a report in someone else's repository | `docs/design/migration-feedback.md` | [Why the merge is the trigger](design/migration-feedback.md#1-why-the-merge-is-the-trigger) |
| The feedback stage's three built-in channels and what each one is for | `docs/design/migration-feedback.md` | [The three built-in channels](design/migration-feedback.md#4-the-three-built-in-channels) |
| Standing orders for every agent session in this repository | `AGENTS.md` | [Rules](../AGENTS.md#rules) |
| How documentation is organised, written, and kept from drifting | `docs/AGENTS.md` | [The tier taxonomy: one home per fact](AGENTS.md#the-tier-taxonomy-one-home-per-fact) |
| Open work, and what is deliberately not done yet | `docs/plans/README.md` | [Open work](plans/README.md#open-work) |
| The migration pipeline, its stages, and what each stage guarantees | `README.md` | [Pipeline](../README.md#pipeline) |
| Every configuration key, its default, and its effect | `README.md` | [Configuration](../README.md#configuration) |
| Why the verification layers exist, how they are ordered, and how a failure is attributed | `docs/design/e2e-migration-pipeline.md` | [The gate stack](design/e2e-migration-pipeline.md#3-the-gate-stack) |
| Baseline attribution: telling a pre-existing defect from a regression | `docs/design/e2e-migration-pipeline.md` | [Baseline attribution](design/e2e-migration-pipeline.md#4-baseline-attribution) |
| How the loop spends its attempt budget, and when it stops early | `docs/design/e2e-migration-pipeline.md` | [Budget policy](design/e2e-migration-pipeline.md#5-budget-policy) |
| The agent-authored end-to-end suite and the branch it lives on | `docs/design/e2e-migration-pipeline.md` | [The E2E suite branch](design/e2e-migration-pipeline.md#6-the-e2e-suite-branch) |
| UI and UX assertions: geometry, overflow, and screenshots | `docs/design/e2e-migration-pipeline.md` | [UI end-to-end testing](design/e2e-migration-pipeline.md#7-ui-end-to-end-testing) |
| Watchdogs: what each timeout covers and what a stall reports | `docs/design/e2e-migration-pipeline.md` | [Watchdogs](design/e2e-migration-pipeline.md#10-watchdogs) |
| Scoring this Action against the community benchmark suite | `docs/upstream-benchmark.md` | [Preparations](upstream-benchmark.md#preparations) |
| The latest measured rewards, generated from the run records | `README.md` | [Upstream benchmark](../README.md#upstream-benchmark) |
| What those results mean, and which of them are not defects | `docs/upstream-benchmark.md` | [Reading the results](upstream-benchmark.md#reading-the-results) |
| What the benchmark exercise found wrong in our own code | `docs/upstream-benchmark.md` | [Three real defects this exercise exposed in our own code](upstream-benchmark.md#three-real-defects-this-exercise-exposed-in-our-own-code) |
| The record format each benchmark run writes, and the rules that make it reproducible | `reports/README.md` | [The record format](../reports/README.md#the-record-format-schema-2) |
| The continuous quality-tracking framework this repository is converging on | `docs/design/continuous-quality-tracking.md` | [Proposed design](design/continuous-quality-tracking.md#5-proposed-design) |
| Official harness discussions: what ships today and what an auto-post would need | `docs/official-discussion-auto-post.md` | [Why a migrate run does not post](official-discussion-auto-post.md#why-a-migrate-run-does-not-post) |
