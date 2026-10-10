---
kind: design
description: How the Action is evaluated on the community benchmark suite: the subjects, the outcomes of an attempt, the metrics, the comparison rule and the records.
---

# Evaluation

The Action is scored on the community migration suite [`oh-my-dsh/dsh-plugin-upgrade-skill`](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill), run by [Harbor](https://github.com/harbor-framework/harbor). A run produces one immutable record; every number this project reports is computed from records by `src/evaluation/metrics.ts`. [The benchmark procedure](../operations/benchmark.md) says how to run one; the [metrics](../reference/metrics.md) and [records](../reference/records.md) references are generated from the code.

## 1. Decisions

| Decision | Instead of | Why |
|---|---|---|
| The product is a subject: `pipeline` runs the whole migration a consumer gets | Scoring one agent session as "the agent" | A consumer receives the proposal of the workflow, with its checks and repairs, not the output of one session |
| Metrics are defined over what an attempt produced: the reward, the outcome, the usage, the durations | Metrics per workflow stage | A change to the workflow changes how an attempt is produced, not how it is scored |
| An attempt the environment failed is `infrastructure`, excluded from the quality metrics and counted by its own metric | Counting it as reward 0 | A starved machine is not a worse migration |
| A difference between two records is a verdict only when its paired 95% bootstrap interval excludes zero | A relative threshold, or a single-run delta | Rewards come in discrete bands, so a 10% drop means different things at 1.0 and at 0.4; one run of a stochastic subject is one draw |
| The tasks are resampled, not the attempts | Resampling attempts | Attempts of one task share their failure causes |
| Records are immutable and live on the `bench/records` branch | Records on `main` | A record is evidence produced outside a commit's review; `main` stays free of run output |
| Paid runs happen on the maintainer's machine; CI only validates records and runs the keyless oracle | A benchmark job in GitHub Actions | A run spends API budget, takes hours, and needs a Docker daemon with enough address space for its trial networks |

## 2. Subjects

| Subject | What runs as the Harbor agent (`tools/harbor/dsh_agent.py`) |
|---|---|
| `pipeline` | `dsh-migrate run --skip-github` on a copy of the task fixture, as a consumer repository with publishing off |
| `pipeline+skills` | The same, with `agent.upgradeSkills: true` |
| `session` | One `dsh --profile migrate` session with the task statement as its task, in `/app` |
| `session+skills` | The same, with the `plugin-upgrade` skill loaded |
| `oracle` | The task's reference solution |

Every subject but `oracle` runs in the agent runtime of `container/agent-runtime`, installed from its lockfile into the task container apart from the task's own dsh, and its setup ends with `dsh-migrate self-test`, so a runtime that cannot start a session fails the setup rather than scoring 0. The migrate profile goes into `/root/.dsh`, the home the task's dsh and its verifier read: a different home would hide the agent's changes from the verifier.

A pipeline does not read the task statement. It takes its target from the dsh release the task installs globally and its source from the fixture's declared dependencies, exactly as it would in a consumer repository. Two consequences follow, recorded per task as `applicable`:

- The static tasks (`S`) ask for a written analysis, which a pipeline does not produce, so they are not applicable to a pipeline.
- A task that installs no dsh release gives a pipeline no target, so it is not applicable either.

The fixture receives what a consumer would be proposed: the tree of a migration that ended `unpublished` (it changed and passed with publishing off). A migration that ended `failed`, `compatible` or `error` leaves the fixture as it was, and the verifier scores that.

Means are never averaged across subjects.

## 3. An attempt

Harbor runs the verifier after an agent run that timed out or exited non-zero, so a reward is the score whatever the agent did. The outcome of an attempt says why it has its reward or has none, from the phase the trial reached (`src/evaluation/harbor.ts`):

| Outcome | When | Counted as |
|---|---|---|
| `scored` | The verifier wrote a `reward` | That reward |
| `timeout` | No reward, and the agent run stopped at its timeout | 0 |
| `exception` | No reward, and the agent run stopped with another exception | 0 |
| `infrastructure` | No reward, and the trial stopped before the agent ran or in the verifier | Not counted; `infrastructureRate` |

A task is *feasible* when every attempt of the newest `oracle` record of the same suite commit scored 1.0 on it. A run of another subject refuses to start without that oracle record, and does not run infeasible tasks: the reference solution failing in this environment says the environment cannot judge the task.

## 4. Metrics

The metrics, their qualities (effectiveness, consistency, efficiency, infrastructure) and the conventions they share are in [the metrics reference](../reference/metrics.md), generated from the table that computes them. CI recomputes every record's metrics from its attempts and refuses a record whose stored values differ, so a change to a formula changes `FORMULA` and every record keeps the version that computed it.

What the metrics do not cover: whether a change is confined to what the migration needed (no reference-diff comparison), the agreement of the verifiers with themselves (no regrading), and steps per attempt (the adapter writes no trajectory). What happens to proposals in the consumer repositories is [the Field page](#7-the-report).

## 5. Comparing two records

`npm run bench -- compare <base> <head>` pairs the tasks both records scored and reports, for `meanReward` and `passRate@1.0`, the mean per-task difference with its 95% paired bootstrap interval (`compare` in `src/evaluation/metrics.ts`). The verdict is `regression` when the interval lies below zero, `improvement` when it lies above, and `no-change` otherwise; with fewer than ten shared tasks the resamples repeat a handful of values, so the pair is `not-comparable`. The command exits non-zero on a regression, and [the Compare page](#7-the-report) runs the same function. Records of different suite commits are paired over the tasks they share, and the command says so.

## 6. Records

A record is `records/<id>/record.json` on the `bench/records` branch, beside the files its attempts kept: `proposed.diff` (the fixture against its baseline commit), `agent.log`, for a pipeline `events.jsonl` and `status.json`, and the verifier's output. Each kept file carries its SHA-256. A record is written once, by the run that produced it, and never edited; a run that went wrong is rerun as a new record.

The working tree must be clean, or the run passes `--allow-dirty` and the record says `producer.dirty`.

## 7. The report

`npm run site` builds a static site from the records, and [the `bench-records` workflow](../../.github/workflows/bench-records.yml) publishes it to GitHub Pages. The pages are `site/`; the build adds the data they read and the compiled metric library, so a page computes a comparison with the same code as the command line. Every page keeps its state in the URL, so a view is a link.

| Page | Shows |
|---|---|
| Trend | Per subject, `meanReward` with its interval band and `passRate@1.0` over the records, and a table of every record; a point opens the comparison with the record before it |
| Compare | Two records: the paired verdicts, every metric side by side, and every attempt of every task as a chip that opens its diff |
| Task | One task across the records of a subject: the reward of each attempt, durations and cost |
| Diff | One artifact of two attempts, of two records or of one, in a Monaco diff editor; a `proposed.diff` also gets its file list and diffstat. `?subject&task&from&fromAttempt&to&toAttempt&artifact&view`, and `range=latest` for the two newest records |
| Field | The proposals in the consumer repositories |

The Field page is built from the consumers' state branches at build time, not from records: the event log keeps when each proposal was published and when its pull request closed, merged or not, so storing that again would be a copy to keep in step. The build asks GitHub only for the maintainer commits on merged proposals. It reports, per consumer and overall, the merge rate over decided proposals, the share merged without a maintainer commit, and the median hours from publishing to merging. The consumer list is `CONSUMERS` in `scripts/site.ts`.

The charts are [Vega-Lite](https://vega.github.io/vega-lite/), which draws an interval band declaratively; the diff editor is [Monaco](https://microsoft.github.io/monaco-editor/), loaded on the Diff page only. Both come from a pinned CDN version, so the site has no build step of its own. Record data is fetched per page as it is needed, not embedded, because the records grow with every run.

## 8. The suite

`vendor/dsh-plugin-upgrade-skill` is a submodule pinned to one commit, never a branch: the suite's own comparability rules require a frozen snapshot, and a record names the commit and the task list it ran.

The suite does not require isolation from its agent: it states that "security is guaranteed jointly by the one-shot container, the scope constraints, and the verifier", sets no `[agent] user`, and uploads `tests/` only after the agent has finished. The adapter therefore runs as root in the task container, like the suite's own agents.
