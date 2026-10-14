---
kind: operations
description: Running the benchmark on the maintainer's machine, comparing records, and publishing them.
---

# Running the benchmark

[The evaluation design](../design/evaluation.md) defines the subjects and what a record means. A run spends API budget and takes hours, so it runs on the maintainer's machine and never in GitHub Actions.

## Setup

```sh
python3 -m venv ~/.harbor && ~/.harbor/bin/pip install harbor==0.24.0
git submodule update --init vendor/dsh-plugin-upgrade-skill
git fetch origin bench/records && git worktree add .bench/records bench/records
```

Harbor 0.24.0 is the version `src/evaluation/harbor.ts` reads; a record names the version that produced it. The run needs Docker and network access from the task containers. Records are written to the `bench/records` worktree at `.bench/records`; the first time, before the branch exists, create it with `git worktree add --orphan -b bench/records .bench/records`.

## A run

The oracle comes first: it decides which tasks this machine can judge, and costs no API key. A `nop` run, also keyless, finds the tasks that doing nothing passes; the span suite needs one, the upgrade-skill suite may have one.

```sh
npm run bench -- run --subject oracle --attempts 1 --harbor ~/.harbor/bin/harbor
npm run bench -- run --suite spans --subject nop --attempts 1 --harbor ~/.harbor/bin/harbor
DEEPSEEK_API_KEY=… npm run bench -- run --subject pipeline --attempts 3 --harbor ~/.harbor/bin/harbor
```

The upgrade-skill suite's static tasks and some others grade a written report with an LLM judge. They run only when the shell sets `REPORT_JUDGE_BASE_URL` (an OpenAI-compatible API prefix), `REPORT_JUDGE_MODEL` and `REPORT_JUDGE_API_KEY`; the judge must answer non-streamed chat completions with `response_format: json_object`. Read the key from its file inline, as the DeepSeek key is, and keep the same judge across the records you compare.

| Option | Meaning | Default |
|---|---|---|
| `--subject` | `pipeline`, `pipeline+skills`, `session`, `session+skills`, `oracle` or `nop` | required |
| `--suite` | `upgrade-skill` or `spans` ([the suites](../design/evaluation.md#8-the-suites)) | `upgrade-skill` |
| `--attempts` | Attempts per task | `3` |
| `--tasks` | Comma-separated task ids | every task |
| `--concurrency` | Trials at once (Harbor `-n`) | `1` |
| `--agent-timeout-multiplier` | Harbor's multiplier of each task's agent timeout | `1` |
| `--agent-setup-timeout-multiplier` | Harbor's multiplier of the 360 s agent setup, which installs the agent runtime and, for a pipeline, Playwright and Chromium; several setups at once take longer | `4` |
| `--model` | `provider/model` of the agent sessions | `deepseek-official/deepseek-v4-flash` |
| `--harbor` | The Harbor executable (or `HARBOR_BIN`) | `harbor` |
| `--allow-dirty` | Run from a tree with uncommitted changes; the record says so | off |

The run builds this repository, packs it for the task containers, probes the served model before and after, runs Harbor, and writes `records/<id>/record.json` with the files each attempt kept. It prints every metric. Harbor's job directory is left in the system temporary directory for inspection.

A run of three attempts on the whole suite is a few hundred agent sessions and several hours. Lower `--tasks` to try a change, and keep the full suite for a record worth comparing against.

A run writes its plan beside Harbor's job directory before Harbor starts, and prints the command that continues it. When a run is interrupted (the machine sleeps, the terminal closes, a process limit stops it), `npm run bench -- resume <job directory>` lets Harbor finish the trials that did not, keeps those that did, and writes the record the run would have written. It refuses to resume from another commit than the one the run started at, because the record names one. A run that ends with trials unfinished exits non-zero and prints the same command. For a long run, detach it from the terminal (`setsid nohup npm run bench -- run … > run.log 2>&1 &`).

## Comparing and publishing

```sh
npm run bench -- compare <base record id> <head record id>
npm run site                              # the report from .bench/records, in .bench/site
npm run bench -- publish                  # validate, then commit the new records and snapshots
git -C .bench/records push origin bench/records
gh workflow run bench-records.yml
```

`compare` exits non-zero on a regression. `validate`, which `publish` runs first, checks that every record parses, its metrics recompute to the stored values, its kept files match their hashes, and its snapshot matches its manifest. `publish` commits in the records worktree only, with one line per new record: its subject, its `meanReward` and the commit message of the run. [The `bench-records` workflow](../../.github/workflows/bench-records.yml) builds the report from the pushed records, refusing any that do not validate, and publishes it to GitHub Pages; it runs on request, daily, and on every push to `main`. A pushed record is public.

While the Action is being changed, the loop is: commit the change, run the subject the change concerns (`--tasks` narrows it while iterating), then publish. The Trend page puts each run on the subject's line with its commit message, and the Changes page shows what the change did to the statechart, the prompts and the source next to what it did to the score. A run needs a commit, not a pushed one: the snapshot keeps what the commit held.

An oracle run exits non-zero when a reference solution scored below 1.0, after writing its record: those tasks are infeasible on this machine, and the other subjects skip them.

## On a shared machine

Every trial brings up its own compose network, and each network takes a whole subnet from the Docker daemon's address pool. The pool, not CPU, bounds `--concurrency`: when it runs out, trials fail to start and are recorded as `infrastructure`, and a record with many of those measures the machine, not the Action. Lower the concurrency and run again.

Never clean the host to make room. A `docker rm`, `docker network prune` or volume command without a filter scoped to this run's own resources reaches other people's workloads.

A full root filesystem makes the tasks' `apt-get` report errors that read as broken archive signatures; check `df -h /` before suspecting the archive.
