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

The oracle comes first: it decides which tasks this machine can judge, and costs no API key.

```sh
npm run bench -- run --subject oracle --attempts 1 --harbor ~/.harbor/bin/harbor
DEEPSEEK_API_KEY=… npm run bench -- run --subject pipeline --attempts 3 --harbor ~/.harbor/bin/harbor
```

| Option | Meaning | Default |
|---|---|---|
| `--subject` | `pipeline`, `pipeline+skills`, `session`, `session+skills` or `oracle` | required |
| `--attempts` | Attempts per task | `3` |
| `--tasks` | Comma-separated task ids | every task |
| `--concurrency` | Trials at once (Harbor `-n`) | `1` |
| `--agent-timeout-multiplier` | Harbor's multiplier of each task's agent timeout | `1` |
| `--model` | `provider/model` of the agent sessions | `deepseek-official/deepseek-v4-flash` |
| `--harbor` | The Harbor executable (or `HARBOR_BIN`) | `harbor` |
| `--allow-dirty` | Run from a tree with uncommitted changes; the record says so | off |

The run builds this repository, packs it for the task containers, probes the served model before and after, runs Harbor, and writes `records/<id>/record.json` with the files each attempt kept. It prints every metric. Harbor's job directory is left in the system temporary directory for inspection.

A run of three attempts on the whole suite is a few hundred agent sessions and several hours. Lower `--tasks` to try a change, and keep the full suite for a record worth comparing against.

A run writes its plan beside Harbor's job directory before Harbor starts, and prints the command that continues it. When a run is interrupted (the machine sleeps, the terminal closes, a process limit stops it), `npm run bench -- resume <job directory>` lets Harbor finish the trials that did not, keeps those that did, and writes the record the run would have written. It refuses to resume from another commit than the one the run started at, because the record names one. A run that ends with trials unfinished exits non-zero and prints the same command. For a long run, detach it from the terminal (`setsid nohup npm run bench -- run … > run.log 2>&1 &`).

## Comparing and publishing

```sh
npm run bench -- compare <base record id> <head record id>
npm run bench -- validate
git -C .bench/records add records && git -C .bench/records commit -m "chore(bench): record <subject> at <commit>"
git -C .bench/records push origin bench/records
gh workflow run bench-records.yml
```

`compare` exits non-zero on a regression. `validate` checks that every record parses, its metrics recompute to the stored values, and its kept files match their hashes. [The `bench-records` workflow](../../.github/workflows/bench-records.yml) builds the report from the pushed records, refusing any that do not validate, and publishes it to GitHub Pages; it runs on request, daily, and on every push to `main`. `npm run site` builds the same site into `.bench/site` to look at before pushing. A pushed record is public.

An oracle run exits non-zero when a reference solution scored below 1.0, after writing its record: those tasks are infeasible on this machine, and the other subjects skip them.

## On a shared machine

Every trial brings up its own compose network, and each network takes a whole subnet from the Docker daemon's address pool. The pool, not CPU, bounds `--concurrency`: when it runs out, trials fail to start and are recorded as `infrastructure`, and a record with many of those measures the machine, not the Action. Lower the concurrency and run again.

Never clean the host to make room. A `docker rm`, `docker network prune` or volume command without a filter scoped to this run's own resources reaches other people's workloads.

A full root filesystem makes the tasks' `apt-get` report errors that read as broken archive signatures; check `df -h /` before suspecting the archive.
