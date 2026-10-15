# Documentation index

The entry point to the documentation: `AGENTS.md` holds the rules and links here, and this table sends a reader to the one document, and the one section, that owns a subject. Read the two rows for [README.md](../README.md) and [AGENTS.md](../AGENTS.md) first; everything else is looked up when a task needs it rather than read up front.

`scripts/verify-doc-index.ts` computes every entry point below from the target document's actual headings, and fails when a section is renamed, a home disappears, or a document is added without a row. The shape is fixed for the same reason: one topic, one backticked home path, and exactly one link, whose path must equal the home and whose fragment must name a real section.

| Topic | Home | Entry point |
|---|---|---|
| The product, its inputs and outputs, and how to consume the Action | `README.md` | [Usage](../README.md#what-it-does) |
| Where to start as a contributor, and what to run before pushing | `README.md` | [Contributing](../README.md#contributing) |
| Installing the Action: secrets, the workflow, permissions, report channels, the deploy service | `docs/operations/install.md` | [The workflow](operations/install.md#the-workflow) |
| Setting the Action up in a plugin repository with a coding agent: what it looks up, what it asks, what it never does | `docs/operations/install.md` | [Setting it up with an agent](operations/install.md#setting-it-up-with-an-agent) |
| Releasing the Action | `docs/operations/release.md` | [Releasing](operations/release.md#releasing) |
| How a migration runs as a statechart over an event log, and why | `docs/design/workflow.md` | [Decisions](design/workflow.md#1-decisions) |
| The invariants the workflow keeps, and the tests that hold them | `docs/design/workflow.md` | [Invariants](design/workflow.md#3-invariants) |
| What the state branch stores, and what is derived from it | `docs/design/workflow.md` | [The state branch](design/workflow.md#4-the-state-branch) |
| Merge reports: the channels, their evidence, and their tokens | `docs/design/workflow.md` | [Merge reports](design/workflow.md#8-merge-reports) |
| Every state, transition and guard of the migration statechart | `docs/reference/workflow.md` | [States](reference/workflow.md#states) |
| The comment commands | `docs/reference/commands.md` | [Comment commands reference](reference/commands.md#comment-commands-reference) |
| The five checks, the change-card ledger, the end-to-end suite and its baseline, and watchdogs | `docs/design/checks.md` | [The five checks](design/checks.md#the-five-checks) |
| The agent runtime and its self-test | `docs/design/checks.md` | [The agent runtime](design/checks.md#the-agent-runtime) |
| The 2026-09-29 outage of every agent session | `docs/postmortems/2026-09-29-agent-runtime-drift.md` | [What broke](postmortems/2026-09-29-agent-runtime-drift.md#what-broke) |
| Every configuration key, its type and its default | `docs/reference/configuration.md` | [Configuration reference](reference/configuration.md#configuration-reference) |
| What is evaluated, the outcomes of an attempt, and the comparison rule | `docs/design/evaluation.md` | [Subjects](design/evaluation.md#2-subjects) |
| The benchmark report: its pages, the diff viewer, and the field outcomes of proposals | `docs/design/evaluation.md` | [The report](design/evaluation.md#7-the-report) |
| Running the benchmark, comparing records, and publishing them | `docs/operations/benchmark.md` | [A run](operations/benchmark.md#a-run) |
| Every benchmark metric and its definition | `docs/reference/metrics.md` | [Metrics reference](reference/metrics.md#metrics-reference) |
| Every field of a benchmark record | `docs/reference/records.md` | [Benchmark record reference](reference/records.md#benchmark-record-reference) |
| Where a migration session runs, and why only on the runner | `docs/design/deploy-service.md` | [Where a migration session runs](design/deploy-service.md#2-where-a-migration-session-runs) |
| The run log stream of a running migration | `docs/design/deploy-service.md` | [The run log stream](design/deploy-service.md#3-the-run-log-stream) |
| The preview deployment: the working copy, the safe entry, lifetime, and what it may not do | `docs/design/deploy-service.md` | [The preview deployment](design/deploy-service.md#4-the-preview-deployment) |
| Access control for the deploy service, and why a URL is not a secret | `docs/design/deploy-service.md` | [Access control](design/deploy-service.md#5-access-control) |
| Which actions run the checks, and which are advice | `docs/design/deploy-service.md` | [Check policy](design/deploy-service.md#7-check-policy) |
| The calls a deploy service must serve, and what it owes beyond their shape | `docs/design/deploy-service.md` | [The HTTP contract](design/deploy-service.md#8-the-http-contract) |
| What a deploy service answers for a publish, and who pushes the change | `docs/design/deploy-service.md` | [Preview publish](design/deploy-service.md#81-preview-publish) |
| How the reference deploy service is built: run store, idempotency, preview manager, instance providers | `docs/design/deploy-service.md` | [The reference implementation](design/deploy-service.md#9-the-reference-implementation) |
| Checking any deploy service against the Action's client | `docs/design/deploy-service.md` | [The conformance suite](design/deploy-service.md#10-the-conformance-suite) |
| Running the reference deploy service: images, configuration, compose, Terraform, wiring a repository, verifying | `docs/operations/deploy-service.md` | [Configuration](operations/deploy-service.md#configuration) |
| What a host needs to run the deploy service, at any provider | `docs/operations/deploy-service.md` | [On any host with Docker](operations/deploy-service.md#on-any-host-with-docker) |
| The rules for every agent session in this repository | `AGENTS.md` | [Rules](../AGENTS.md#rules) |
| Every project term, its name in code, and the words it replaces | `docs/glossary.md` | [Migrations](glossary.md#migrations) |
| How documentation is organised, written, and kept from drifting | `docs/AGENTS.md` | [The tier taxonomy: one home per fact](AGENTS.md#the-tier-taxonomy-one-home-per-fact) |
