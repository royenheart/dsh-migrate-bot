# Proposal: Consumer run evidence intake

Status: open

## Problem

`Run evidence` gives a consumer a private, per-run view of the prompts, stages, workflow and cost that produced a migration. The same evidence can improve the product: a repeated repair failure, an unused workflow branch, a prompt that leads a session away from the repository's own instructions, or a plugin class that the benchmark does not represent. Today the consumer can export `inspect.json` and show it to a maintainer; the project receives no durable, opt-in evidence stream and cannot compare qualitative behaviour across runs.

The product needs a path from a consumer-run bundle to a useful, private, consented feedback corpus. The path must preserve the state branch as the source of record and must not turn prompt text into a public benchmark artifact.

## Proposal

Add an opt-in **evidence intake** stage after a migration run:

```text
consumer run
  → inspect bundle (manifest + prompts + workflow)
  → local redaction and preview
  → authenticated upload or signed archive URL
  → private evidence store
  → derived evidence signals
  → aggregate analysis and benchmark proposals
```

The first stage stores a bounded snapshot for a fixed retention period, with the consumer's explicit consent. The project reads derived signals, not prompt text, for routine analysis. A maintainer can open one raw bundle through an authorized review path when a signal needs explanation.

An evidence submission carries:

- consumer repository and migration id;
- run id, workflow hash, target release and model;
- a bundle hash, schema version and size;
- consent and retention policy;
- a redaction report;
- the raw bundle reference in private storage;
- derived signals: stage outcomes, failure fingerprints, session kinds, workflow nodes and edges, duration, token and cost totals.

The bundle stays private. The public benchmark site reads only aggregate counts, task coverage and signal summaries. Prompt text and source excerpts never enter `bench/records` or the public wiki.

The intake path reuses the existing evidence contract and the deploy service's run identity where possible. A consumer that does not opt in uploads nothing; the manual `inspect.json` file path remains available for a one-off review.

## Decisions needed

**E1. Where the evidence is stored.** (a) A central project-owned private evidence service: one consent and access policy, but the project becomes a data custodian. (b) The consumer's deploy service stores the bundle, and the project receives only derived signals: the consumer keeps custody, but analysis sees less raw evidence. (c) A signed archive URL supplied by the consumer: minimal infrastructure, but the project must fetch and retain an external object. Recommended: (b) first, with an optional (a) only for consumers who explicitly request central retention. Blocks: the upload endpoint, storage schema and deletion API.

**E2. Consent and redaction.** (a) Upload by default with an opt-out: the corpus grows quickly and consent is weaker. (b) Upload only after an explicit per-migration or per-repository opt-in with a local preview and automated secret redaction. (c) Upload only a manually selected bundle: strongest control, lowest coverage. Recommended: (b). Blocks: the configuration key, the upload UI, the redaction engine and the retention notice.

**E3. Bundle identity and schema.** (a) Reuse `InspectData` unchanged and add submission metadata at the transport boundary. (b) Add a versioned `EvidenceSubmission` envelope around the bundle, with the bundle hash, consent record and redaction report. (c) Store only normalized signals and discard the bundle. Recommended: (b) initially, because the raw bundle explains a signal and a hash makes retention auditable; (c) becomes reasonable once the signal schema is stable. Blocks: the contract file, validation tests and storage layout.

**E4. Access and retention.** (a) Project maintainers can read every raw bundle. (b) Raw bundles are visible only to a named reviewer group; derived signals are visible to the product team; deletion is available by consumer, repository or retention expiry. (c) Keep raw bundles indefinitely for research. Recommended: (b) with a 90-day default retention and a documented deletion path. Blocks: access control, audit logging and the data-retention job.

**E5. Analysis output and its owner.** (a) Aggregate dashboards alone: safe and cheap, but hard to turn into product changes. (b) A recurring **evidence review** that converts repeated signals into benchmark tasks, prompt/workflow proposals and product issues, each owned by the relevant document. (c) Automatic prompt rewriting from evidence: high leverage, high risk, and premature before the signal schema is stable. Recommended: (b); (a) supports it and (c) waits for a separate proposal. Blocks: the analysis job, the review cadence and the benchmark task intake.

## Acceptance criteria

- A consumer that does not opt in uploads no bundle, and the run still completes.
- An opted-in upload requires an authenticated, bounded request; a bundle that fails schema, size, redaction or consent validation is refused with a recoverable reason.
- The submission records the consumer, migration, run, workflow hash, bundle hash, schema version, consent and retention policy.
- A repeated upload of the same bundle is idempotent; a changed bundle for the same run is refused or stored as a new revision under an explicit rule.
- Raw prompt text is visible only through the authorized reviewer path; public pages show counts, task coverage and signal summaries only.
- A consumer can delete a submission, and expiry removes the raw bundle while the derived aggregate remains explainable.
- A repeated failure fingerprint or an unused workflow branch becomes a candidate benchmark task or a product proposal, with a link to the evidence signal that produced it.
- The intake path has tests for first upload, repeat, interrupted upload, expired retention, invalid schema, oversized bundle and unauthorized access.

## Risks

- **Prompt text contains source and tool output.** Automated redaction catches known secrets; the local preview and private retention decide whether the remaining text may leave the consumer. A bundle is never public by default.
- **Selection bias.** Opted-in consumers and manually selected runs do not represent all migrations; aggregate claims state their denominator and compare against the record and Field populations.
- **Rights and provenance.** The consumer owns the source and prompts; the consent record and deletion path preserve that ownership, and derived tasks cite the evidence signal rather than republishing the prompt.
- **Storage and access cost.** A cap on bundle size, retention and submissions per repository bounds storage; derived signals are compact and can outlive the raw bundle.
- **Schema drift.** A versioned envelope and validation at the boundary make an old bundle readable; the site and intake share one schema definition.
- **Overfitting to vivid failures.** The evidence review weighs frequency, task coverage and record-level impact; a single memorable failure becomes a benchmark candidate, not an automatic product change.
- **Centralization pressure.** A central store becomes a data-custody product; the recommended private-deploy-service route keeps custody with the consumer until that decision is explicitly revisited.

## Related designs

- [Run evidence](../design/evaluation.md#7-the-report)
- [Deploy service HTTP contract](../design/deploy-service.md#8-the-http-contract)
- [Engineering principle 7](../engineering.md#7-end-to-end-flows-and-resource-symmetry)
