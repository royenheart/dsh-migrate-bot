# Continuous migration-quality tracking

Research and design for measuring whether a change to this Action made migrations worse. Status: **partly implemented** — a benchmark record now carries the repetition, token usage, and subject identity this framework consumes (schema 2 in [reports/README.md](../../reports/README.md#the-record-format-schema-2)), while the trend, the threshold, and the regression gate below are still open. This document records what exists and why the rest is shaped the way it is.

## 1. The gap

The suites answer "does it work". None answers "did this commit make it worse".

| Layer | Command | What it proves |
|---|---|---|
| Unit | `npm test` | pure logic, fixtures, mocked subprocesses |
| Mechanical end-to-end | `npm test` | the mechanical suite against `fixtures/plugins/` |
| Live agent run | `DSH_MIGRATE_LIVE=1 npm run test:e2e` | one real migration session |
| Upstream oracle self-check | `npm run check:upstream` | the task environment scores `1.0` with the reference answer (no API cost) |
| Upstream benchmark | `npm run bench:upstream` | this Action's agent scored on the community exam tasks |

Migration quality moves for reasons none of the fast layers can see: a prompt rewrite, a preset or model change, a budget change, a new gate that fires too eagerly, a dsh version that changes an API the runner depends on. Two concrete examples already happened in this repository — the alignment prompt's wording caused an agent to write an Agent Note into a plugin repository, and a renamed session accessor broke the migration runner on a newer dsh. Both were found by running the agent, not by a test.

## 2. What is already reserved

1. **A versioned record per invocation** — `reports/README.md` defines
   `schema: 2`, and both benchmark entry points write it through
   `tools/harbor/summarize.py`: producer commit, frozen upstream snapshot, the
   migration mode and the skills commit it loaded, the served model build and
   its fingerprint, every attempt with its `reward` / `durationSeconds` /
   `exception` / token counts, and a cost carrying the price table it came from.
   A tracking framework needs exactly this shape, and the producers now write it.
2. **A free measurement and a paid one.** The oracle self-check detects
   environment drift at no API cost; the benchmark measures quality and costs a
   real agent session per task.
3. **A precedent for storing history outside `main`.** Migration state already
   lives on the `dsh-migrate/state` branch; benchmark history can follow the same
   pattern.

## 3. Prior art

### `benchmark-action/github-action-benchmark`

The best-known "action benchmark" — a GitHub Action for continuous benchmarking ([repository](https://github.com/benchmark-action/github-action-benchmark), [marketplace](https://github.com/marketplace/actions/continuous-benchmark)). Its model is worth copying almost wholesale:

- It reads a benchmark output file and extracts named metrics
  (`name` / `unit` / `value`, with optional `range` for variance and `extra` for
  context).
- It keeps the history on a branch (`gh-pages`, `dev/bench/data.js`) with a chart
  dashboard, or, with `external-data-json-path`, in a JSON file the workflow
  persists itself via `actions/cache`.
- It compares each result against the previous one and alerts when the result is
  worse by more than `alert-threshold` (default `200%`). `fail-on-alert` fails
  the workflow, `comment-on-alert` leaves a commit comment, `summary-always`
  writes a job summary.
- Two generic tool modes, `customBiggerIsBetter` and `customSmallerIsBetter`,
  accept any metric — which is the door our reward-per-task walks through.
- It warns that a virtual environment varies by ±10–20%, and recommends
  self-hosted runners when that is unacceptable.

### Agent-evaluation tooling

Newer projects apply the same shape to non-deterministic subjects — running evals on every pull request and reporting what changed before merge, for example [agentura](https://github.com/SyntheticSynaptic/agentura) ("CI/CD checks for AI agents … like pytest, but for AI agents"). They differ from latency benchmarks in exactly the way ours differs: the subject samples a model, so a single run is not a measurement.

### The upstream project's own protocol

The community benchmark this repository vendors states its own comparability rules (`benchmark/snapshots/README.md`, `benchmark/README.md`): freeze an immutable snapshot (commit plus an explicit task list), run each task three times and take the median, and publish token counts and durations next to the scores. Any tracking framework here must at least not contradict them, or its numbers cannot be compared to anything outside this repository.

## 4. What transfers, and what does not

| Aspect | Performance benchmark | This project |
|---|---|---|
| Metric | latency, throughput | task reward, `0.0`–`1.0`, higher is better |
| Determinism | deterministic given a fixed machine | **stochastic**: the model samples, so one run is one draw |
| Noise | ±10–20% per the tool's own warning | much larger: a task is all-or-nothing, and an agent can fail on phrasing |
| Alert semantics | relative change vs the previous value | a *relative* rule is wrong here — `1.0 → 0.9` is a 10% regression but crosses a scoring band, while `0.4 → 0.36` is also 10% and means nothing |
| Cost | CPU seconds | a real agent session per task, plus API spend |
| Failure modes | slow, but rarely "no result" | timeouts and exceptions are a normal outcome |

Two conclusions follow:

- **Aggregate over tasks, not over runs of one task.** The mean reward across a
  fixed task set is far more stable than any single task, and the record already
  carries both.
- **Alert on absolute movement, not a percentage.** The upstream tasks score in
  discrete bands (`100 / 40 / 30 / 0`), so the meaningful threshold is a drop in
  the mean or in the count of full-score tasks, not a ratio.

## 5. Proposed design

### Metric shape

Feed `github-action-benchmark`'s `customBiggerIsBetter` mode, or an equivalent consumer, one metric per task plus one aggregate:

```json
[
  { "name": "mean-reward", "unit": "reward", "value": 0.667, "range": "0.471" },
  { "name": "tasks-full-score", "unit": "tasks", "value": 2 },
  { "name": "M1-host-migration", "unit": "reward", "value": 1.0, "range": "0.0" }
]
```

`range` is the tool's own field for variance, so a median-and-spread of N runs maps onto it directly; `extra` can carry the upstream commit and the task list.

### Storage

Two options, both already precedented in this repository:

| Option | How | Trade-off |
|---|---|---|
| **A — `external-data-json-path`** with `actions/cache` | nothing is committed; the JSON history lives in the workflow cache | zero repository noise, but the history is evictable and invisible in review |
| **B — a dedicated branch** (`bench-quality`, like `dsh-migrate/state`) | the record is committed and reviewable, and `gh-pages` can render the chart | keeps `main`'s history clean; needs a push permission and a token |

Recommendation: **B**, with the JSON records under `reports/upstream/` on `main` as they exist today, and the derived metric history on the branch. The records are the evidence; the chart is the view.

### Trigger and gate

- Run **on pushes that can change behaviour** — `src/prompts/`, `src/pipeline/`,
  `src/verify/`, `src/e2e/`, `src/config/`, `container/`, `Dockerfile` — rather
  than every commit, because each task costs an agent session.
- Keep the **oracle self-check on every push**: it is free and catches the class
  of failure that invalidated a real run once already (a `DSH_HOME` line).
- Gate on **mean reward over a fixed task subset**, with a threshold expressed in
  reward points, and report the per-task deltas rather than only the verdict.
- **Never run the paid benchmark on pull requests from forks** — it spends the
  API key and, on some designs, needs write access.

### Task subset

The suite is 56 tasks and 30 are hands-on. A per-commit trigger wants a small fixed subset that spans the three families (`S` read-only, `M` mutable, `H` hands-on trap). The record already names the upstream commit, so the subset can be declared later without changing the schema.

## 6. Open questions

1. **How many repetitions?** Upstream recommends three per task; three is also
   the minimum that makes a median meaningful. For a subset of three tasks that
   is nine agent sessions per trigger — the dominant cost, and the reason the
   subset must stay small.
2. **Where does the threshold come from?** It needs a baseline spread, which
   needs a few recorded runs of the same commit first. Until then any threshold
   is a guess.
3. **What counts as a regression when the task set changes?** The record pins the
   upstream commit; a comparison across different upstream commits is not a
   comparison of this Action.
4. **Who pays?** A scheduled benchmark consumes API budget continuously. The
   `quota.limit` mechanism exists for a single run, not for a fleet of them.

## 7. Phasing

| Phase | Work | Cost |
|---|---|---|
| 0 (done) | report format with `schema`, both producers writing records, the oracle self-check separated from the paid benchmark | — |
| 1 | an adapter that turns a record into the `customBiggerIsBetter` metric shape, plus a workflow that runs it on the behavioural paths | no new API spend; consumes existing records |
| 2 (done) | repeat runs recorded per task: `BENCH_RUNS` attempts, every attempt kept, `reward` reported as their median with its range | recurring agent sessions |
| 3 | regression gate: fail the workflow on a mean drop beyond a threshold calibrated from phase 2 | as phase 2 |
| 4 | chart history on a branch, and the record directory pruned by policy | — |

Phase 1 is worth doing early because it costs nothing per run and immediately makes historical records visible as a trend instead of a directory of JSON.
