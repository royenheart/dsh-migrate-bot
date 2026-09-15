#!/usr/bin/env bash
# Prepare and run upstream benchmark tasks through Harbor with this project's agent.
#
#   tools/harbor/run-benchmark.sh <task-id> [<task-id> ...]
#
# The tasks are copied before preparation, so the vendored submodule stays
# pristine. A task's Dockerfile is used verbatim except for two declared,
# opt-out-able deviations:
#
#   1. The agent's harness (dsh + pnpm) is installed at build time when the task
#      does not already ship it. The tasks made for a dsh-based agent ship it
#      themselves; a task designed for a plain coding agent would otherwise
#      spend its whole budget installing tooling instead of solving the task.
#   2. When NPM_REGISTRY is set, build-time `npm install -g` gets `--registry`.
#      Opt-in, and only about which host the bytes come from.
#
# The fixture, the judge and the baseline commit are never touched.
#
# The image is built here and handed to Harbor as a prebuilt image, because
# Harbor's own build path has no way to pass a registry mirror through and would
# rebuild the same base layers once per task.
#
# The subject is a migration MODE, and a run repeats each task before it reports:
#
#   DSH_HARBOR_SKILLS=native|upgrade-skills   which migration is under test
#   BENCH_RUNS=<n>                           attempts per task (default 3)
#   BENCH_CONCURRENCY=<n>                    concurrent attempts inside a task (default 1)
#   BENCH_TASK_CONCURRENCY=<n>               tasks prepared and run at once (default 1)
#
# Optional environment:
#   NPM_REGISTRY              npm registry mirror for the build-time install
#   DSH_BENCH_VERSION         harness version baked into tasks that lack one
#                             (default: the version the tasks themselves pin)
#
# See docs/upstream-benchmark.md for what the deviations do and do not change.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASKS_DIR="$ROOT/vendor/dsh-plugin-upgrade-skill/benchmark/tasks"
WORK_ROOT="${HARBOR_TASK_WORK:-/tmp/harbor-tasks}"
HARBOR="${HARBOR_BIN:-$ROOT/.harbor-venv/bin/harbor}"
AGENT="${HARBOR_AGENT:-tools.harbor.dsh_agent:DshAgent}"
MODEL="${HARBOR_MODEL:-deepseek-official/deepseek-v4-flash}"
NPM_REGISTRY="${NPM_REGISTRY:-}"
DSH_BENCH_VERSION="${DSH_BENCH_VERSION:-0.1.2-alpha.2}"
REPORT_DIR="${BENCHMARK_REPORT_DIR:-$ROOT/reports/upstream}"
MODE="${DSH_HARBOR_SKILLS:-native}"
if [[ "$MODE" != "native" && "$MODE" != "upgrade-skills" ]]; then
  echo "DSH_HARBOR_SKILLS must be native or upgrade-skills, got: $MODE" >&2
  exit 2
fi
RUNS="${BENCH_RUNS:-3}"
CONCURRENCY="${BENCH_CONCURRENCY:-1}"
# Tasks are independent: each prepares its own copy, builds its own image and
# writes its own job directory. Running several at once is what makes a
# 56-task, two-mode suite finish in hours rather than days.
TASK_CONCURRENCY="${BENCH_TASK_CONCURRENCY:-1}"
# `-m` is the requested model; the response names the model that served it, and
# the probe below records that separately.
MODEL_ID="${MODEL##*/}"

# The public registry is the default, so the script is not tied to any host's
# mirror; a caller on a slow route sets NPM_REGISTRY.
registry_flag=""
if [[ -n "$NPM_REGISTRY" ]]; then
  registry_flag="--registry=$NPM_REGISTRY "
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <task-id> [<task-id> ...]" >&2
  exit 2
fi

mkdir -p "$WORK_ROOT"

prepare() {
  local task_id="$1" src="$TASKS_DIR/$1" dest="$WORK_ROOT/$1"
  [[ -d "$src" ]] || { echo "no such task: $task_id" >&2; return 1; }
  rm -rf "$dest"
  cp -R "$src" "$dest"

  local dockerfile="$dest/environment/Dockerfile"
  [[ -f "$dockerfile" ]] || { echo "$dest"; return 0; }

  # Deviation 2: point every build-time global install at the mirror. The copy
  # is rewritten, never the submodule.
  if [[ -n "$NPM_REGISTRY" ]]; then
    sed -i -E "s#(npm install -g )#\1${registry_flag}#g" "$dockerfile"
  fi

  # Deviation 1: only for tasks that ship no harness of their own.
  if ! grep -q "@deepseek-ai/dsh@" "$dockerfile"; then
    cat >> "$dockerfile" <<EOF

# DECLARED DEVIATION (not part of the task): this task does not ship a harness,
# and the agent being benchmarked needs one. Installed here so the task's own
# timeout is spent on the task, not on tooling. The fixture, judge and baseline
# commit are unchanged. See tools/harbor/run-benchmark.sh.
RUN npm install -g ${registry_flag}pnpm@11.24.0 @deepseek-ai/dsh@$DSH_BENCH_VERSION
EOF
  fi
  echo "$dest"
}

# Snapshot the job directories before running, so the record below can cover
# exactly the runs this invocation produced. Comparing mtimes instead is unsafe:
# prepare() rewrites the work root for every task, so only the last task would
# look new and the earlier results would vanish from the record with no error.
jobs_before="$(mktemp)"
jobs_after="$(mktemp)"
probe_file="$(mktemp)"
trap 'rm -f "$jobs_before" "$jobs_after" "$probe_file"' EXIT

# Identify the build that will serve this experiment before it runs. dsh does
# not surface the response fingerprint, so it is asked for once here; a failed
# probe is recorded, never fatal.
# Look before touching Docker: a `docker` command acts on the whole daemon, and
# this machine's baseline is however many unrelated containers and networks are
# already running. Printing it here is what makes the scoped reclamation below
# checkable — the run may only ever return the daemon to this state.
echo "== docker baseline =="
echo "containers running: $(docker ps -q | wc -l), networks: $(docker network ls -q | wc -l)"

echo "== model probe =="
python3 "$ROOT/tools/harbor/model_probe.py" --model "$MODEL_ID" --out "$probe_file" >/dev/null || true
if [[ -d "$ROOT/jobs" ]]; then
  find "$ROOT/jobs" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort > "$jobs_before"
fi

# One task failing must not discard the tasks that already ran: a suite run is
# hours long, and a batch that aborts halfway still has to produce a record of
# what it measured. Each task runs in its own function so several can be in
# flight at once; failures are collected and reported at the end.
mkdir -p "$WORK_ROOT"
FAILED_FILE="$WORK_ROOT/failed-tasks.txt"
rm -f "$FAILED_FILE"

run_task() {
  local task_id="$1"
  local log="$WORK_ROOT/$task_id.log"
  local dest image dockerfile
  : > "$log"
  # Each trial brings up its own compose network, and one network takes a whole
  # subnet from the daemon's pool, so how many trials may run at once is bounded
  # by that pool rather than by CPU. Once a task is done, take back the networks
  # THAT TASK made, and only when nothing is attached: a name filter of `__env`
  # alone would also match a task still starting up next to this one, whose
  # network briefly has no container yet, and deleting that network kills a trial
  # of a task this one has nothing to do with.
  local prefix
  prefix="$(echo "$task_id" | tr 'A-Z' 'a-z')__"
  for net in $(docker network ls --format '{{.Name}}' | grep "^${prefix}" || true); do
    if [[ "$(docker network inspect -f '{{len .Containers}}' "$net" 2>/dev/null || echo 1)" == "0" ]]; then
      docker network rm "$net" >/dev/null 2>&1 || true
    fi
  done
  if ! dest="$(prepare "$task_id" 2>>"$log")"; then
    echo "$task_id (prepare)" >> "$FAILED_FILE"
    return 0
  fi
  image="dsh-migrate-bench-$(echo "$task_id" | tr 'A-Z' 'a-z'):latest"
  dockerfile="$dest/environment/Dockerfile"
  if [[ -f "$dockerfile" ]]; then
    if ! docker build --network host -t "$image" "$dest/environment" >>"$log" 2>&1; then
      echo "$task_id (build)" >> "$FAILED_FILE"
      return 0
    fi
  else
    echo "no Dockerfile; relying on the task's declared docker_image" >>"$log"
  fi

  python3 - "$dest/task.toml" "$image" >>"$log" 2>&1 <<'TASKTOML'
import sys
path, image = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
if "docker_image" not in text:
    text = text.replace(
        "[environment]\n",
        "[environment]\n# DECLARED DEVIATION: prebuilt outside Harbor so build\n"
        "# arguments can be passed (see tools/harbor/run-benchmark.sh).\n"
        f'docker_image = "{image}"\n', 1)
open(path, "w", encoding="utf-8").write(text)
TASKTOML

  if ! PYTHONPATH="$ROOT" "$HARBOR" run -p "$dest" -a "$AGENT" -m "$MODEL" \
    --n-attempts "$RUNS" --n-concurrent "$CONCURRENCY" >>"$log" 2>&1; then
    echo "$task_id (run)" >> "$FAILED_FILE"
  fi
  echo "$task_id finished" >> "$log"
}

for task_id in "$@"; do
  while [[ "$(jobs -rp | wc -l)" -ge "$TASK_CONCURRENCY" ]]; do
    wait -n || true
  done
  echo "queued $task_id"
  run_task "$task_id" &
done
wait

if [[ -f "$FAILED_FILE" ]]; then
  echo "dsh-migrate: $(wc -l < "$FAILED_FILE") task(s) did not complete: $(tr '\n' ' ' < "$FAILED_FILE")" >&2
fi
# One versioned record per invocation, in the format a tracking framework reads.
if [[ -d "$ROOT/jobs" ]]; then
  find "$ROOT/jobs" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort > "$jobs_after"
  mapfile -t NEW_JOBS < <(comm -13 "$jobs_before" "$jobs_after")

  # A run that produced no job directory is a failure worth surfacing, rather
  # than an empty record that reads like success.
  if [[ ${#NEW_JOBS[@]} -lt $# ]]; then
    echo "dsh-migrate: $# task(s) requested but ${#NEW_JOBS[@]} new job record(s) appeared" >&2
  fi
  if [[ ${#NEW_JOBS[@]} -gt 0 ]]; then
    UPSTREAM_COMMIT="$(git -C "$ROOT/vendor/dsh-plugin-upgrade-skill" rev-parse HEAD 2>/dev/null || true)"
    python3 "$ROOT/tools/harbor/summarize.py" --out-dir "$REPORT_DIR" \
      --mode "$MODE" --model "$MODEL_ID" --probe-json "$probe_file" --tasks-dir "$TASKS_DIR" \
      --upstream-commit "${UPSTREAM_COMMIT:-unknown}" "${NEW_JOBS[@]}" || true
  fi
fi
