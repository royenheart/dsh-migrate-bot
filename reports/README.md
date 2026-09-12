# Test and benchmark reports

Committed records of what the test suites and the upstream benchmark actually produced. They exist so a change to this Action can be compared against what came before it, rather than judged from memory.

## Layout

```
reports/upstream/<timestamp>.json   machine-readable record
reports/upstream/<timestamp>.md     the same record, rendered for reading
```

Both are written together by `tools/harbor/summarize.py`, which every benchmark entry point calls: `tools/harbor/run-benchmark.sh` for Harbor runs, `scripts/run-upstream-oracle.sh` for the oracle self-check.

## The record format (`schema: 2`)

```jsonc
{
  "schema": 2,
  "kind": "upstream-benchmark",      // or "oracle-selfcheck"
  "generatedAt": "2026-09-12T08:41:11+00:00",
  "producer": {                      // what produced this, i.e. this Action
    "commit": "ba064944af7597136baff22884e3a13f6e017bba",
    "dirty": true                    // true when the tree had uncommitted changes
  },
  "upstream": {                      // the frozen evaluation snapshot
    "repository": "oh-my-dsh/dsh-plugin-upgrade-skill",
    "commit": "ecab245c6c1831c51b0240aca13573b94a6e525e"
  },
  "mode": {                          // the migration under test
    "id": "native",                  // or "upgrade-skills"
    "runner": "migrate",             // migrate reports usage; stock does not
    "profile": "migrate",
    "skills": { "commit": null, "loaded": [] }
  },
  "agent": {
    "name": "dsh",
    "version": "0.1.2-alpha.2",
    "model": "deepseek-v4-flash",    // the model the run REQUESTED
    "modelsObserved": ["deepseek-official/deepseek-flash"]
  },
  "modelIdentity": {                 // the build that actually served it
    "requestedModel": "deepseek-v4-flash",
    "servedModel": "deepseek-flash", // the response's model, not an echo
    "systemFingerprint": "aeb56401ca74e127821c4f9126dcb669",
    "probedAt": "2026-09-12T08:40:49+00:00",
    "error": null                    // set when the probe could not identify the build
  },
  "runsPerTask": 2,
  "tasks": [
    {
      "id": "M1-host-migration",
      "reward": 1.0,                 // MEDIAN over the attempts; null when none scored
      "rewardMin": 1.0, "rewardMax": 1.0,
      "attemptsScored": 2,
      "attempts": [                  // every attempt, so a median can be recomputed
        { "reward": 1.0, "exception": null, "durationSeconds": 344.0, "startedAt": "…",
          "usage": { "n_input_tokens": 97447, "n_cache_tokens": 6331008, "n_output_tokens": 69933 } }
      ],
      "usage": { "inputTokens": 194894, "cacheHitTokens": 12662016, "outputTokens": 139866 }
    }
  ],
  "summary": {
    "tasks": 1, "scored": 1, "attempts": 2, "mean": 1.0, "exceptions": 0,
    "usage": { "inputTokens": 194894, "cacheHitTokens": 12662016, "outputTokens": 139866 },
    "cost": { "usd": 0.15114, "status": "ok", "model": "deepseek-flash",
              "tableFetchedAt": "2026-09-12", "tableAgeDays": 0, "tier": "off-peak" }
  }
}
```

### Rules that make the record reproducible

- **The mode is part of the identity.** `native` migrates from the harness source alone; `upgrade-skills` additionally loads the vendored community skills at the commit named in `mode.skills.commit`. They are different subjects and their means are never averaged into one.
- **`producer.commit` is mandatory context.** A record without it cannot be attributed to a revision, and a `dirty: true` record describes a tree that never existed as a commit.
- **`upstream.commit` is the frozen snapshot, never a branch name.** The upstream project states the same requirement for its own benchmark (`benchmark/snapshots/README.md`), because the task set is a living benchmark that has already moved through 18 / 19 / 22 / 23-task states.
- **The served build is recorded, not just the requested model.** DeepSeek answers `deepseek-v4-flash` as `deepseek-flash` and gives no dated model id to pin, so `modelIdentity.systemFingerprint` is the only field that identifies the build serving the requests. It is probed once per invocation by `tools/harbor/model_probe.py`; a failed probe records `error` rather than omitting the field.
- **Every attempt is kept.** `tasks[].attempts` holds each run; `reward` is their median. A subject that samples a model has no single score, and a mean over one attempt per task cannot support a comparison between two records.
- **Token counts are facts; the price is an interpretation.** Usage comes from the run. The cost is derived from `pricing/deepseek.json` at the record's own attempt times, and carries the table's date, its age, and the peak/off-peak tier — so a stale figure is visible as stale rather than silently wrong.
- **A missing reward is `null`, never `0`.** Upstream's own reporting treats an unscored trial as an anomaly rather than a zero, and so does this format: only entries with a non-null `reward` contribute to `summary.mean`.
- **A missing cost is `null` with a status, never `0`.** `cost.status` distinguishes `ok`, `stale-table`, `unknown-model`, and `no-price-table`. A silent zero is indistinguishable from a free run.
- **Exceptions are recorded, not swallowed.** A trial that raises is evidence about the harness or the budget, not a quiet zero.

### Known limits

- The fingerprint identifies the **backend configuration** serving requests, not the model's weight artifact, and it is probed once per invocation rather than captured per request: dsh reads the session log and never surfaces the HTTP response, so a per-request fingerprint is not available to this harness today.
- A record from before schema 2 carries no mode, model identity, attempts, usage, or cost. It renders as `native` with those cells empty, which is a statement about the record and not about the run.

## How these records are consumed

`docs/design/continuous-quality-tracking.md` designs the framework that turns a sequence of these records into a trend, compares a revision against the one before it, and fails a workflow when migration quality drops. The format above is its input contract, and both benchmark entry points already write it.

Two consumers read these records today. `scripts/sync-readme-benchmark.ts` renders the benchmark table in [README.md](../README.md#upstream-benchmark) from the newest record of each kind, and `npm run gates` fails when that table is stale, so a run that is not reflected in the README breaks the build rather than drifting. `npm run bench:upstream` writes the records themselves.

## What is not here yet

- **A frozen task list.** The record names the upstream commit but not which
  tasks were selected; a comparison between records with different task sets has
  to check that manually.
- **A per-request model fingerprint.** The probe identifies the build at the
  start of an invocation; capturing it per request needs the provider's HTTP
  response, which the harness does not see.
