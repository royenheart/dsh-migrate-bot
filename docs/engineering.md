# Engineering principles

These principles bind every change to this repository, whether a person or an agent makes it. [AGENTS.md](../AGENTS.md) carries one standing order for each principle and links here; this document is the complete statement. Terms follow the [glossary](glossary.md).

## 1. Persistent data design

Business correctness, data integrity, and maintainability come first. Make the smallest structural change that serves the business need. Before changing a persisted format, read the existing model and every read and write path, and reuse a field, query, or service with the same meaning. A new table, file, or field states its business meaning, why it must persist, and why the existing structure is insufficient. Do not persist derivable or temporary display data; a historical snapshot, an audit record, or a measured performance need is an exception only when the change states how the copy stays consistent. Do not mix meanings in one field, reserve fields without a concrete use, or use free-form JSON to avoid modelling.

In this repository persistent data means every durable file: the state branch, run manifests, prompt snapshots, benchmark records, deploy-service run records, and any wire format a released client reads.

## 2. CRUD and consistency

For each piece of data, state where it is created, what reads it, who updates it, and when it is deleted or retained. Implement only the operations the business needs. Check permissions, validation, atomic writes, and compatibility; do not apply a generic CRUD template that adds fields or endpoints nobody asked for.

## 3. Replacing implementations and removing temporary content

Finish a replacement according to the target design and delete the old implementation. Do not keep compatibility branches, dual paths, or fallbacks for unconfirmed needs. When compatibility is required, state its scope and removal condition: keep it only for a released client or data already written, and name which one. One-off migrations and switch-overs run in their target environment, are verifiable and recoverable, and their steps and results go into the report. Do not leave temporary scripts, manual commands, transition notes, or operation logs in code, comments, or long-lived documentation. Keep the mechanisms that continuous deployment, environment rebuilds, and routine maintenance need, and keep comments and documents aligned with the current implementation.

## 4. Flow modules and state machines

A flow module is a state machine. One interpreter writes state; handlers and timers emit events; states form a closed set; errors carry machine-readable reasons. Do not scatter flow logic across callbacks, which invites races. The migration workflow follows this rule through `src/workflow/machine.ts`.

## 5. Implementation complexity

Watch for complexity that accumulates through regex and string-replacement chains, stacked special cases, combinations of boolean flags, compatibility and fallback chains, nested retries, repeated wrapping, and premature generalisation. Before using one of these techniques, check that the data model, interface boundaries, and business rules are clear, and look for a standard-library facility, a structured parser, an existing project capability, or established practice ([principle 6](#6-reuse-and-cross-project-unity)). Prefer the mature option that meets the current need with the least complexity. Avoid regexes and ad-hoc patches, and do not over-design for generality.

When a technique is genuinely needed, state why and where it applies. Compatibility code states its removal condition; retries share one budget and termination condition; each gets targeted verification. All later changes follow this rule.

## 6. Reuse and cross-project unity

**Look before building.** Before writing code, search this repository and its related projects for an API, function, module, data model, or internal framework that does the same thing or overlaps heavily. Related projects are those that share fields, APIs, or data: upstream and downstream services, the harness and its SDK, submodules, vendored copies, frontends, and released clients. Reuse or extend what exists. When reuse is impossible, state why, and delete or merge the superseded implementation so two never coexist.

**No reinvented wheels**, at two levels. Security- and reliability-sensitive parts such as cryptography, authentication, signing, input parsing, concurrency control, and retries use mature, security-reviewed libraries or frameworks. Inside the project, do not create a second API or framework that duplicates an existing one.

**One definition per concept.** Fields, enums, error codes, API payloads, and configuration keys shared across modules, languages, services, or repositories live in one schema, contract file, or generated artefact; everything else references or validates against it. Where two definitions already exist, converge on the authoritative one or state why this change does not.

**Trace every field end to end.** For each added or changed field, follow it from writer to reader: the production path passes a value rather than relying on a default, an empty value, or test-only setup; name, type, unit, and nullability agree on both sides; every reader of a renamed or removed field is updated. Add no field that no production path writes.

**Account for every caller.** When a function or interface changes its preconditions, defaults, exceptions, return-value meaning, error codes, or state transitions, list all callers, including other languages, services, repositories, and released clients in support, and confirm each still works. A new or stricter check must not reject a user flow that used to complete; when rejection is intended, the user sees why and can recover.

**Changes in related projects** follow that project's own rules, branch, and pull request. The two pull requests reference each other and state the merge and release order. Version pins point at the version that contains the change. Permissions, quotas, secrets, and configuration that a new external call needs ship in the same release.

**CI runs against the real contract** of the other side, not each side's own mock. Where changing one side alone would drift silently, add a contract test or check; such tests are exempt from the rule against superfluous tests.

**Shared implementations** called from several places have at least one test that enters through a production entry point.

## 7. End-to-end flows and resource symmetry

After implementing, follow every user flow this change fixes or adds, from the user action (interface, command line, webhook, timer) to the point where the external dependency is actually invoked: the third-party API accepts valid credentials, billing or settlement happens, the notification arrives, the background task finishes, and the user sees the final state. At each step confirm that every prerequisite (credential, reserved quota, record state, lock, configuration, secret, permission, feature flag) has a provider in production code. A provider that exists only in tests, a local development implementation, or a manual step leaves the flow incomplete.

Walk each flow through first run, interruption, parent work already finished, retry and restart (including replay of an outbox or queue after a worker restart), and delayed start; state why a case does not apply. Also confirm it completes under production configuration (feature flags, secrets, and builds differ from development), while old and new versions coexist, and against existing data. Resources released on failure, cancellation, timeout, or settlement (credentials, reserved quota, authorisations, locks, quotas, external tasks, temporary files) are restored on retry and recovery paths or documented as deliberately not restored. A reopened object has everything it depends on; an old terminal-state marker is cleared or its retention justified. Each outcome happens once: duplicate delivery, replay, or two concurrent workers leave charges, refunds, notifications, and external calls idempotent.

## 8. Data scale

For anything that processes data, files, model context, or batches, establish the real magnitude from read-only aggregate queries, monitoring, or logs: record counts, object size, file count, input volume, concurrency, and growth rate. When that is impossible, state the assumption and its basis; never assume development or test data is representative. Reason at the current scale, 10×, 100×, and the largest known single input about time (N+1 queries, nested loops, unindexed reads, full recomputation), memory (full loads versus paging or streaming), disk (limits and cleanup of temporary files, logs, and artefacts), model context and tokens (truncation, chunking, caps, and cost growth), external calls (rate limits, quotas, timeouts, and batch size), storage (lock duration, transaction size, table and index growth), and queues (backlog, retry storms, large jobs blocking others). The design states its caps, batching, or degradation; only problems that appear at a realistic scale need handling.

## 9. Design decisions

When a design proposal needs the owner's decision because options carry real costs or the choice changes functionality, responsibility, the data model, or an external contract, do not choose alone. Write the question, options and their costs, recommendation and reason, and what remains blocked in an open [proposal](proposals/README.md); continue with the unblocked work. Before implementing, read the existing decisions: the Design decisions section of the pull request description, decision items in review comments, Decision paragraphs in this pull request's commit messages, and the Design decisions sections of the authoritative documents. Implement decided items as decided; when a requirement contradicts an existing decision, stop and state the conflict.

## 10. Documentation and language

Update every affected document in the same change. First identify which documents the change touches, where each fact belongs, and how they reference each other; keep the complete account of a topic in one or two authoritative documents, and let other places carry only necessary context or a link. Fix duplication, conflicts, contradictions, and stale content across the set rather than patching one sentence. Do not mark a stale document as superseded: move its content into the authoritative document and delete it. Technical reports are exempt only when they intentionally preserve rejected options and revision history.

A design decision that will constrain later code belongs in the Design decisions section of the topic's authoritative document. The `docs/decisions.md` index links each decision and each open question to its owner. Code, comments, documents, and commit messages are English; reports to the owner are Chinese.

## 11. Git commits

Commit atomically by function: a pull request consists of a few independently explainable and reviewable commits with no unrelated edits. Fold a revision into the commit it belongs to (`git commit --fixup=<sha>` plus `git rebase -i --autosquash <base>`, or `--amend` for the last commit); do not add a commit per review round. Commit messages follow Conventional Commits; the body states the final design and its reasons, not the process. A commit that implements a design decision carries a complete Decision paragraph:

```text
Decision: <one-sentence conclusion>
Question: <the question as it was raised>
Options: <options considered, one line each>
Chosen by: owner, <PR link, review round>
Why: <reason>
Constraint: <what later code must keep doing>
Revisit when: <the condition for reconsideration>
```

When a decision spans commits, the commit that mainly implements it carries the full paragraph and the others reference it in one line. Every commit passes its relevant tests on its own and does not reference something only a later commit adds.

## 12. Verification

Run the targeted checks that cover this change and its directly affected paths, including affected tests and contract checks in related projects; do not run the full suite by default. The pre-commit gates and CI's full run are gates, not a substitute for choosing those checks. Do not add a test for every small change or force tests onto a feature already slated for deletion. When a shared path's preconditions change, each affected caller lifecycle from [principle 7](#7-end-to-end-flows-and-resource-symmetry) gets at least one case. Tests enter through production entry points and let production code perform its own prerequisite steps; a test never performs a step production code should have done. Test doubles are never looser than the real implementation: they lock, validate state, simulate failure, and return per the real contract. Assertions state user-visible results. Every new failure path emits a traceable log line or event at a level that matches whether a human must act.

## 13. Reporting

A report to the owner covers the changes listed by commit; the end-to-end flows and each lifecycle with the verification method or the note that only code reading was used; the data magnitude and its source, plus caps or batching; changes in related projects, their pull requests, and the merge and release order; the design decisions implemented with their commits and documents; questions still awaiting the owner; one-off migrations, repairs, or switch-overs with steps and results; and verification results with what remains uncovered.
