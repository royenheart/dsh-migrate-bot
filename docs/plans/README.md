# Open work and deliberate non-goals

What this repository intends to do next, and what it has decided not to do. Each item owns no design of its own: it names the state and links the document that works it out.

## Open work

| Item | State | Owner |
|---|---|---|
| Continuous quality tracking: store one metric per benchmark run against a moving baseline and detect a regression band before it is merged | Designed, not implemented; phasing in the linked section | [Phasing](../design/continuous-quality-tracking.md#7-phasing) |
| Benchmark comparability: freeze a snapshot and task list, run each task several times and report the median with token usage | Shipped in the record: a run takes `BENCH_RUNS` attempts per task, keeps every attempt, and reports the median, the token counts and the cost with the price table behind it | [The subject is a mode, and a run repeats](../upstream-benchmark.md#the-subject-is-a-mode-and-a-run-repeats) |
| Drive the benchmark with the shipped `migrate` runner instead of the stock runner | Shipped: `migrate` is the default and is what reports token usage; `stock` remains selectable but reports none | [Two ways to run it](../upstream-benchmark.md#two-ways-to-run-it) |
| Delivering dsh trace logs by email after a run | Deferred; no design recorded yet, so the delivery mechanism and its failure handling are still open | [The live view](../design/preview-and-live-view.md#3-the-live-view) rejects email for the live view, and nothing owns it for a finished run |
| Reporting a migration to the built-in feedback channels | Shipped, off by default; the mechanism is designed and the three channels are the ones this repository runs | [The migration feedback stage](../design/migration-feedback.md) |
| A read-only live view of a running migration, streamed to a deploy target the user supplies | Shipped in the Action; the target itself is the user's to run, and a missing one is a logged skip | [The live view](../design/preview-and-live-view.md#3-the-live-view) |
| A preview instance that runs the migrated plugin so it can be tried before merging | The Action's half is shipped: a `publish` freezes a revision, applies it, gates it, and pushes only a green tree. The instance itself is the deploy target's, which is the user's to run | [The preview instance](../design/preview-and-live-view.md#4-the-preview-instance) |
| Commands a comment can drive: status, feedback (with a dry run and a resend), redeploy, destroy, extend, publish | Shipped: parsing, permissions, delivery, idempotency, `status` reading the preview's own state, and the publish hand-back. The preview verbs need a deploy target the user runs | [Commands](../design/migration-feedback.md#6-commands) |
| Running a migration session on the deploy host rather than the GitHub runner | **Deliberately not implemented**; declared so the configuration and the live view are built against the right shape | [Two run paths](../design/preview-and-live-view.md#2-two-run-paths-one-of-them-shipped) |
| Aggregating feedback across many plugin repositories | Not started; every channel reports one migration to one destination, and nothing holds a fleet-wide view | [What this stage does not do](../design/migration-feedback.md#7-what-this-stage-does-not-do) |

## Non-goals

- **A feedback channel that reports on an opened pull request.** An opened pull request is an opinion, not a verdict; reporting every one of them would turn a signal into volume, and the channels write to repositories their enabler does not own.

- **Making the benchmark suite a per-pull-request gate.** It costs model budget and minutes per task, and the tasks grade a whole migration rather than a diff. `npm run check:upstream` is the keyless, cheap check that runs in CI.
- **Tuning the agent for `S1-static-scan`.** Its agent budget is the task's own 300-second limit, and upstream's published validation report lists `AgentTimeoutError` there as a known outcome. Treating it as a defect would mean optimising against one task's timeout rather than the migrations this Action exists to perform.
- **Escaping the agent sandbox.** The upstream suite requires no isolation beyond a one-shot container, so there is nothing to build against ([what the suite requires](../upstream-benchmark.md#isolation-the-upstream-suite-does-not-require-it)).
- **A hand-written changelog.** [CHANGELOG.md](../../CHANGELOG.md) is generated from the commit history; a fact that needs prose belongs in a document here, not in a release entry.
