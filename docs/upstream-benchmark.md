# Scoring this Action against the community benchmark

One directory below `vendor/` holds the community migration exam suite, [`oh-my-dsh/dsh-plugin-upgrade-skill`](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill), as a git submodule pinned to a single commit. Harbor runs the tasks; `tools/harbor/` makes **this project's own agent** the one being scored.

## Why a vendor directory

`vendor/` is a collection point, not a binding to this one repository. The submodule pins a **commit**, never `main`, because the upstream project's own comparability rules require a frozen evaluation snapshot (`benchmark/snapshots/README.md`).

Pinned: `ecab245c6c1831c51b0240aca13573b94a6e525e`

```sh
git submodule update --init vendor/dsh-plugin-upgrade-skill
```

It is **not** part of the production image (`.dockerignore` excludes `vendor`): those tasks run in one-shot containers Harbor starts, so only a development machine or a Docker-capable CI job needs it.

## Two ways to run it

### 1. Oracle self-check — no Harbor, no API key

Every upstream task ships a reference answer, and `harbor run -p <task> -a oracle` must score exactly `1.0`; that is the grading system's own self-check.

```sh
npm run check:upstream                 # the M1 task, two arms
./scripts/run-upstream-oracle.sh <task-dir>
```

Harbor's execution model for these tasks is "build the task image, run the agent inside it, copy `tests/` in and run `test.sh`", so this script replicates those three steps with Docker and needs no Harbor at all. If the submodule is not initialized it materializes the single task from the pinned commit instead.

### 2. Harbor scoring this project's agent

```sh
# once: the upstream project pins this Harbor version
python3 -m venv .harbor-venv && .harbor-venv/bin/pip install harbor==0.22.0

DEEPSEEK_API_KEY=... ./tools/harbor/run-benchmark.sh M1-host-migration H1-plane-trap

# both modes, three attempts each, two trials at a time
DSH_HARBOR_SKILLS=upgrade-skills BENCH_RUNS=3 BENCH_CONCURRENCY=2 \
  DEEPSEEK_API_KEY=... ./tools/harbor/run-benchmark.sh <task-id> ...
```

Each invocation probes the provider once for the build that will serve it
(`tools/harbor/model_probe.py`), because dsh never sees the HTTP response and
the model name alone does not identify a served build.

`tools/harbor/dsh_agent.py` is a Harbor agent adapter. `setup()` uploads the migrate profile this repository ships in `container/profile/` into the task container; `run()` executes the same headless command production uses, with the task's `instruction.md` **verbatim** and no routing prompt, working directory `/app`, and **without overriding `$DSH_HOME`** — the upstream judge hardcodes `/root/.dsh/profiles`, and overriding it silently invalidates every runtime-graded task (measured: adding that one line takes a task from `1.0` to `0.4`).

Runner selection (`DSH_HARBOR_RUNNER`):

| Runner | Behaviour |
|---|---|
| `migrate` (default) | `container/profile/migrate-runner.js`, identical to production. The default because only this runner prints the session's own token accounting, and a record without usage and cost is not the record this project publishes |
| `stock` | the upstream `@deepseek-ai/dsh-headless` runner drives the same preset and task, and reports no usage |

The migration runner needs two things the stock runner does not, both fixed in this repository rather than worked around in the adapter: `container/profile/session-events.js` reads the session log through whichever accessor the running host provides (`events` on 0.1.1, `snapshotEvents` on 0.1.2), and `container/profile/cordis.patch.yml` disables the `plugin-package-inventory-deepseek` request decoration, which throws — and fails the whole request as `REQUEST_EXTENSION` — when a profile mounts a preset whose rows it cannot resolve to a package.

### The subject is a mode, and a run repeats

| Variable | Meaning | Default |
|---|---|---|
| `DSH_HARBOR_SKILLS` | `native` migrates from the harness source alone; `upgrade-skills` also loads the vendored community skills into the container's skill root | `native` |
| `BENCH_RUNS` | attempts per task; the record keeps every attempt and reports their median | `3` |
| `BENCH_CONCURRENCY` | concurrent trials | `1` |

The two modes are different subjects — one has the version cards and the corridor index available, the other does not — so a record names its mode and the table in [README.md](../README.md#upstream-benchmark) renders one section per mode rather than one mean across both. What every record pins, and what a comparison between two records is allowed to conclude, is in [reports/README.md](../reports/README.md#rules-that-make-the-record-reproducible).

## Running the suite on a shared machine

Every trial brings up its own compose network, and one network takes a whole subnet from the Docker daemon's address pool. How many trials may run at once is therefore bounded by that pool long before it is bounded by CPU, memory, or the model provider.

When the pool runs out, the failure is not a bad score: Harbor cannot start the trial's environment at all, and the trial is recorded as an exception. A record whose attempts carry `RuntimeError` in that shape is a record of a starved machine, not a result, and it must not be published as one.

What to do:

- **Lower the run's concurrency.** `BENCH_TASK_CONCURRENCY` and `BENCH_CONCURRENCY` together decide how many trials are live, and that product is what has to fit the pool. A slower suite is an acceptable outcome; a starved one is not.
- **Reclaim only what this run created.** `tools/harbor/run-benchmark.sh` removes the trial networks it made, and only those, and only when nothing is attached to them.
- **Never clean the host.** A machine that runs this benchmark generally runs other things too, and a `docker rm`, `docker network prune`, or volume operation without a filter scoped to this run's own resources will reach all of them. Losing somebody else's service to make a suite finish faster is not a trade this project makes, and the subnet pressure that suggests the cleanup is pressure the concurrency setting is there to absorb.

## Preparations

Applied to a **copy** of each task, so the vendored submodule stays pristine, and annotated in the generated Dockerfile.

1. **Harness in the image.** Tasks designed for a plain coding agent ship no
   global dsh; the prep bakes one in, because a dsh-based agent would otherwise
   spend the whole of such a task's 300-second agent budget installing it. The
   tasks that already ship dsh (`M1`, `H1`) are left alone. The fixture, the
   judge and the baseline commit are untouched.
2. **Registry mirror (opt-in).** With `NPM_REGISTRY` set, build-time
   `npm install -g` lines get `--registry`. The public registry is the default,
   so neither script is tied to one host's mirror.
3. **Prebuilt image.** Harbor builds on the docker bridge and has no way to pass
   a registry mirror through. The task image is therefore built here and handed
   to Harbor through `[environment] docker_image`, which Harbor supports natively
   and which skips its own build.

Every task's own `apt-get update && apt-get install -y --no-install-recommends git` step runs unmodified. Two build-host conditions make that step fail for reasons that have nothing to do with the task, and neither is a reason to weaken it.

A root filesystem with no free space makes `apt` report errors that read as broken archive signatures, so check `df -h /` before suspecting the archive keys. A route that drops large transfers makes `apt` report `Error reading from server`, which is intermittent and size-dependent: the small `InRelease` files succeed while the multi-megabyte `Packages` index is cut off mid-fetch, in a container and on the host alike. `Acquire::Retries` and the timeout values in the production `Dockerfile` cover the second case, and `DEBIAN_MIRROR` selects a different archive when a route is persistently bad.

What is not a fix is letting the install fail: an `apt-get install ... || true` produces an image that is silently missing the compiler or Python the task assumes, and the resulting failure surfaces later as an unrelated-looking task error.

## Reading the results

The rewards and durations themselves are generated into [README.md](../README.md#upstream-benchmark) from the records in [reports/](../reports/README.md). This document does not restate them: two copies of a number drift apart, and the generated one is checked by `npm run gates`.

Two facts about the shape of those results belong here rather than in a table.

`S1-static-scan` scores zero, and that is not a defect to fix. Its agent budget is the task's own 300-second limit, and upstream's own published validation report lists `AgentTimeoutError` there as a known outcome (12 with the skill, including `S1×2`; 9 without). The agent finishes its analysis before writing the report, which is a tight fit for a static task of that length.

The scored tasks reproduce their rewards across runs and across both build paths described above, which is the property worth monitoring. A single run is evidence that the pipeline works; only a sequence of them shows whether it still does, which is what [continuous quality tracking](design/continuous-quality-tracking.md#7-phasing) is designed to watch.

### The two modes are the point of the table

`native` and `upgrade-skills` run against the same frozen snapshot, the same build of the served model, and the same task set; the only difference is whether the community skills are loaded. Both records cover all 56 tasks with three attempts each, and the figures are in [README.md](../README.md#upstream-benchmark) — this document does not restate them.

What the comparison says today: the mode with the skills loaded scores **higher**, on the mean and on the count of full-score tasks, in the same direction. What it does not say: how much of that is the skills and how much is the sampling. Three attempts per task is enough for a median to mean something, but the gap is small next to the spread a stochastic subject produces, and two tasks per mode carry no score at all, so a difference of that size is a direction and not a measurement. Treat it as a reason to keep measuring, not as a number to quote.

## What this exercise exposed in our own code

### 1. The migrate profile is brittle across dsh versions

On dsh **0.1.2-alpha.2** (the version these tasks pin) the `standard` preset fails to mount:

```
tool-subagent: `modelSelectionSettings` requires
@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope
```

That host row is normally contributed by the **web-app bundle**; our composition is base + headless, which is what a headless agent should be. Adding the row (`tools/harbor/settings-row.cordis.patch.yml`) makes the preset mount — but the subpath does not exist on **0.1.1-rc.2**, the CLI version our image pins, where inserting it fails the boot outright:

```
Package subpath './model-selection-settings' is not defined by "exports"
```

So the adapter probes before appending. The wider point: our profile has only ever been validated against the one CLI version the image pins, and pointing the agent at someone else's harness is what surfaced that.

### 2. `migrate-runner.js` was incompatible with dsh 0.1.2-alpha.2

With the mount fixed, the runner failed with:

```
dsh-migrate: events is not iterable
```

It read `agent.session.events`. dsh 0.1.1 exposes that getter; 0.1.2-alpha.2 removed it in favour of `snapshotEvents(fromSeq, toSeqExclusive)`, alongside `ownEvents()` and `eventAt(seq)` — verified against the installed build. Reading `session.events` there yields `undefined` and iterating it throws.

Fixed in `container/profile/session-events.js`, a dependency-free helper the runner now uses; it supports all three accessors and returns an empty log rather than throwing when a host exposes none. Unit-tested in `tests/unit/session-events.test.ts` against every version's shape.

**This is why the answer to "do we need our own runner?" is "yes, but one
version-adaptive runner, not one per version":** the incompatibility was a single renamed accessor, not a different architecture.

### 3. The benchmark record silently dropped tasks

`run-benchmark.sh` decided which Harbor job directories belonged to the current invocation with `find jobs -newer "$WORK_ROOT"`. `prepare()` rewrites the work root once per task, so after the last task every earlier job directory was older than the reference point. A three-task run therefore produced a record holding one task and reported no error — a summary that understated its own coverage.

Fixed by snapshotting the job directories before the loop and taking a `comm` set difference afterwards, plus a warning when fewer records appear than tasks were requested. Regenerating the record for the run above yields all three tasks (`mean 0.6667`, one exception) instead of one (`mean 0.0000`).

### 4. A request decoration failed every session of a profile that mounts a preset

On dsh **0.1.2-alpha.2** the migration runner could not start a single task: every trial ended in two seconds with

```
dsh-migrate: REQUEST_EXTENSION: DeepSeek request extension preparation failed
```

The task was never the problem. dsh ships a request decoration that reports the active plugin inventory to the model provider, and it resolves every active Loader row to its owning package, throwing when one has no resolvable manifest. A profile that mounts a preset adds that preset's rows to the inventory, and this Action's migrate profile does exactly that — which is why the same suite scored `1.000` with the stock runner and `0.000` with ours, on the same task, in the same image. The cause is invisible from the session log, because dsh serializes the error without its `cause`; it took a stock-versus-migrate control run to localize it, and confirming the fix took one more.

`container/profile/cordis.patch.yml` disables the decoration. A migration session does not need the provider to receive this plugin's inventory, and not sending it is the smaller request. **This is a defect in the shipped profile, not only in the benchmark:** any user whose plugin repository runs a dsh version carrying that decoration would have had every agent session fail.

### 5. Token usage was reported as absent while the run was reporting it

The adapter read the runner's `dsh-migrate-status:` lines from the trial's stderr. Harbor's `exec` merges the container's streams, so those lines arrive on stdout and stderr is empty: every record said `usage: null`, and a whole suite would have been published claiming no token counts. Reading both streams, in order, is the fix. The recorder now also totals usage per task and per run, which is what the cost is derived from.

### 6. A truncated task id produced a record naming a task that does not exist

Harbor names a trial directory `<task-id>__<suffix>` and shortens the id when the container name it derives from would be too long, so the suite's `S17-external-ui-plugin-onboarding-trap` appears as `S17-external-ui-plugin-onboardin`. The record took the directory name, which is not a task in the suite: a reader comparing two records would have found a task that does not exist and silently missed the real one. `summarize.py` now maps an observed id back to the suite's directory name when exactly one task matches its prefix.

### 7. A repair run replaced a record instead of completing it

A suite run can lose a task to something outside the task — a build that failed, an environment that would not start. Re-running the whole suite to recover it would discard measurements that were already taken, so `--merge-into` folds the repair run's tasks into the existing record and recomputes the aggregate. It refuses a repair whose mode, upstream snapshot, or producer commit differs, because that is a different subject and has to be its own record.

## Isolation: the upstream suite does not require it

An exhaustive search of the upstream repository (`isolat`, `sandbox`, `escape`, `cap-drop`, `security-opt`, `seccomp`, `chroot`, `privileg`, `jailbreak`, `docker.sock`) returns **no rule, document or code** requiring that an agent cannot escape a sandbox. None of the 56 tasks sets `[agent] user` (root is the expectation); there are no read-only mounts and no resource-limit requirements. Their only statement on isolation delegates it to the container:

> security is guaranteed jointly by the one-shot container, the scope
> constraints, and the verifier.

"May not modify the fixture, the judge or the reference solution" is enforced by prose, by a git baseline commit made at image build time, and by `tests/` being uploaded only during `verify()` — after the agent has finished. Their own helper script states the same thing in the opposite direction: *"this is NOT a sandbox … Run it inside a throwaway Docker container"*, which is precisely this Action's architecture.

## Comparability

Their protocol asks for a frozen snapshot (the 40-character commit plus an explicit task list from `benchmark/snapshots/`), several runs per task reported as a median, and published token counts and durations. Three of those four are now in the record: `BENCH_RUNS` attempts per task with every attempt kept and their median in `reward`, token counts per task and per run, and the durations.

What is still missing is the **task list**: a record names the upstream commit, not which of its tasks the invocation selected, so two records can only be compared after checking that they covered the same set. Until that is pinned, treat a comparison between records as valid only when both ran the full task directory, and say so when quoting a number outside this repository.
