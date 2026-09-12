"""Turn Harbor job output into this repository's benchmark report format.

The JSON this emits is the interface the quality-tracking framework consumes:
one stable, versioned record per benchmark invocation, holding the subject
(which commit of this Action ran, in which migration mode), the frozen upstream
snapshot, the model build that served the requests, and one entry per task with
every attempt behind its score.

Three things make a record reproducible, and each is here for that reason:

* **The mode.** `native` runs from the harness source alone; `upgrade-skills`
  additionally loads the vendored community skills. The two are different
  subjects and are never averaged together.
* **The model build.** A model name is a request; the response's
  `system_fingerprint` identifies the build. It is probed once per invocation by
  `tools/harbor/model_probe.py` because dsh does not surface it.
* **Every attempt.** A task is scored N times and summarised by its median, so a
  delta between two records is not one sample of a stochastic subject.

    python3 tools/harbor/summarize.py --out-dir reports/upstream --kind upstream-benchmark <job-dir> ...
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = 2

UPSTREAM_REPOSITORY = "oh-my-dsh/dsh-plugin-upgrade-skill"

#: How the agent entry is described in a report.
AGENT_LABEL = "dsh"

#: The price table's data home, shared with the TypeScript runtime.
PRICE_TABLE_PATH = Path(__file__).resolve().parents[2] / "pricing" / "deepseek.json"


def _git(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ("git", *args), capture_output=True, text=True, check=True
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration_seconds(trial: dict[str, Any]) -> float | None:
    execution = trial.get("agent_execution") or {}
    begin = _parse_time(execution.get("started_at"))
    finish = _parse_time(execution.get("finished_at"))
    if begin is None or finish is None:
        return None
    return round((finish - begin).total_seconds(), 1)


def _reward(trial: dict[str, Any]) -> float | None:
    rewards = (trial.get("verifier_result") or {}).get("rewards") or {}
    value = rewards.get("reward")
    return float(value) if isinstance(value, (int, float)) else None


def _exception(trial: dict[str, Any]) -> str | None:
    info = trial.get("exception_info")
    if not info:
        return None
    if isinstance(info, dict):
        return str(info.get("type") or info.get("exception_type") or "exception")
    return str(info)


def _usage(trial: dict[str, Any]) -> dict[str, Any] | None:
    result = trial.get("agent_result") or {}
    usage = {
        key: result.get(key)
        for key in ("n_input_tokens", "n_cache_tokens", "n_output_tokens")
    }
    if all(value is None for value in usage.values()):
        return None
    return usage


def _metadata(trial: dict[str, Any]) -> dict[str, Any]:
    return ((trial.get("agent_result") or {}).get("metadata")) or {}


def load_price_table() -> dict[str, Any] | None:
    """The published rates the cost is derived from, or None when unreadable."""
    try:
        return json.loads(PRICE_TABLE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _is_peak(table: dict[str, Any], at: datetime) -> bool:
    """Whether `at` falls in a published peak window (UTC, weekday)."""
    if at.weekday() > 4:
        return False
    minutes = at.hour * 60 + at.minute
    for window in table.get("peakWindowsUtc") or []:
        start = window.get("startMinute")
        end = window.get("endMinute")
        if isinstance(start, int) and isinstance(end, int) and start <= minutes < end:
            return True
    return False


def _priced_as(table: dict[str, Any], model: str, at: datetime) -> str:
    """The id to price under, following dated routing rules."""
    for override in table.get("routeOverrides") or []:
        if override.get("model") != model:
            continue
        from_time = _parse_time(override.get("from"))
        if from_time is not None and at >= from_time:
            return str(override.get("pricedAs") or model)
    return model


def _cost(
    table: dict[str, Any] | None,
    attempts: list[dict[str, Any]],
    model: str | None,
) -> dict[str, Any]:
    """Cost for the scored attempts, with the table and tier that produced it."""
    if table is None:
        return {"usd": None, "status": "no-price-table", "model": model, "detail": f"{PRICE_TABLE_PATH} is unreadable"}
    if not model:
        return {"usd": None, "status": "no-model", "model": None, "detail": "the record names no model to price"}
    fetched = str(table.get("fetchedAt") or "unknown")
    age_days: int | None = None
    fetched_at = _parse_time(f"{fetched}T00:00:00Z")
    if fetched_at is not None:
        age_days = max(0, (datetime.now(timezone.utc) - fetched_at).days)
    stale_after = table.get("staleAfterDays")
    stale = isinstance(stale_after, int) and age_days is not None and age_days > stale_after

    total = 0.0
    priced_attempts = 0
    tiers: set[str] = set()
    for attempt in attempts:
        usage = attempt.get("usage")
        if not usage:
            continue
        at = _parse_time(attempt.get("startedAt")) or datetime.now(timezone.utc)
        rates = (table.get("models") or {}).get(_priced_as(table, model, at))
        if rates is None:
            continue
        tier = "peak" if _is_peak(table, at) else "offPeak"
        tiers.add("peak" if tier == "peak" else "off-peak")
        priced_attempts += 1
        total += (usage.get("n_cache_tokens") or 0) / 1_000_000 * rates["cacheHit"][tier]
        total += (usage.get("n_input_tokens") or 0) / 1_000_000 * rates["cacheMiss"][tier]
        total += (usage.get("n_output_tokens") or 0) / 1_000_000 * rates["output"][tier]

    if priced_attempts == 0:
        return {
            "usd": None,
            "status": "unknown-model",
            "model": model,
            "tableFetchedAt": fetched,
            "tableAgeDays": age_days,
            "detail": f"no vendored rate for `{model}`; costs are unreported rather than zero",
        }
    return {
        "usd": round(total, 6),
        "status": "stale-table" if stale else "ok",
        "model": model,
        "tableFetchedAt": fetched,
        "tableAgeDays": age_days,
        "tier": "mixed" if len(tiers) > 1 else next(iter(tiers), None),
        "attemptsPriced": priced_attempts,
        "detail": (
            f"priced from the {fetched} snapshot, which is {age_days} days old"
            if stale
            else f"priced from the {fetched} snapshot"
        ),
    }


def _resolve_task_id(observed: str, known: list[str]) -> str:
    """Map a trial directory's task id back to the task directory's name.

    Harbor names a trial directory `<task-id>__<suffix>`, and truncates the id
    when the container name it derives from would be too long. A truncated id is
    a different string from the task it names, so an unqualified record would
    report a task that does not exist in the suite — and a comparison against
    another record would silently miss it.
    """
    if not known or observed in known:
        return observed
    matches = [candidate for candidate in known if candidate.startswith(observed)]
    return matches[0] if len(matches) == 1 else observed


def collect(
    job_dirs: list[Path],
    kind: str,
    upstream_commit: str | None,
    *,
    mode: str,
    model: str | None,
    probe: dict[str, Any] | None,
    out_dir: Path,
    known_tasks: list[str] | None = None,
) -> dict[str, Any]:
    """Build one report record from Harbor job directories."""
    by_task: dict[str, list[dict[str, Any]]] = {}
    agent: dict[str, Any] = {"name": AGENT_LABEL, "mode": mode}
    mode_detail: dict[str, Any] = {"id": mode}

    for job_dir in job_dirs:
        for trial_path in sorted(job_dir.glob("*/result.json")):
            trial = json.loads(trial_path.read_text(encoding="utf-8"))
            info = trial.get("agent_info") or {}
            if info:
                agent.setdefault("version", info.get("version"))
                # Tasks pin different harness versions, and the first trial read
                # is not representative of the suite: keep every version seen so
                # the record does not claim one harness for a run that used two.
                seen_versions = agent.setdefault("versions", [])
                if info.get("version") and info["version"] not in seen_versions:
                    seen_versions.append(info["version"])
                model_info = info.get("model_info") or {}
                if model_info.get("name"):
                    agent.setdefault("model", model_info.get("name"))
            metadata = _metadata(trial)
            for key in ("runner", "profile"):
                if metadata.get(key) is not None:
                    mode_detail.setdefault(key, metadata[key])
            if metadata.get("skills_commit") is not None or metadata.get("skills_loaded"):
                mode_detail["skills"] = {
                    "commit": metadata.get("skills_commit"),
                    "loaded": metadata.get("skills_loaded") or [],
                }
            observed = agent.setdefault("modelsObserved", [])
            for entry in metadata.get("models") or []:
                if entry not in observed:
                    observed.append(entry)

            task_id = _resolve_task_id(
                trial_path.parent.name.rsplit("__", 1)[0], known_tasks or []
            )
            execution = trial.get("agent_execution") or {}
            by_task.setdefault(task_id, []).append({
                "reward": _reward(trial),
                "exception": _exception(trial),
                "durationSeconds": _duration_seconds(trial),
                "startedAt": execution.get("started_at"),
                "usage": _usage(trial),
            })

    table = load_price_table()
    tasks = _task_rows(by_task)
    attempts = [attempt for task in tasks for attempt in task["attempts"]]
    priced_model = model
    if probe and probe.get("servedModel"):
        priced_model = str(probe["servedModel"])
    record = {
        "schema": SCHEMA,
        "kind": kind,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "producer": {
            "commit": _git("rev-parse", "HEAD"),
            "dirty": bool(_git("status", "--porcelain")),
        },
        "upstream": {"repository": UPSTREAM_REPOSITORY, "commit": upstream_commit},
        "mode": mode_detail,
        "agent": agent,
        "modelIdentity": probe,
        "runsPerTask": max((len(task["attempts"]) for task in tasks), default=0),
        "tasks": tasks,
        "summary": _summary(tasks, attempts, table, priced_model),
    }
    _ = out_dir
    return record


def _task_rows(by_task: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """One row per task, with its median reward over the attempts that scored."""
    rows: list[dict[str, Any]] = []
    for task_id in sorted(by_task):
        attempts = by_task[task_id]
        scored = [attempt["reward"] for attempt in attempts if attempt["reward"] is not None]
        rows.append({
            "id": task_id,
            "reward": round(statistics.median(scored), 4) if scored else None,
            "rewardMin": min(scored) if scored else None,
            "rewardMax": max(scored) if scored else None,
            "attempts": attempts,
            "attemptsScored": len(scored),
            "exception": next((a["exception"] for a in attempts if a["exception"]), None),
            "usage": {
                "inputTokens": sum((a["usage"] or {}).get("n_input_tokens") or 0 for a in attempts),
                "cacheHitTokens": sum((a["usage"] or {}).get("n_cache_tokens") or 0 for a in attempts),
                "outputTokens": sum((a["usage"] or {}).get("n_output_tokens") or 0 for a in attempts),
            },
        })
    return rows


def _summary(
    tasks: list[dict[str, Any]],
    attempts: list[dict[str, Any]],
    table: dict[str, Any] | None,
    priced_model: str | None,
) -> dict[str, Any]:
    """The aggregate block, recomputed so a merged record is not a sum of summaries."""
    scored = [task["reward"] for task in tasks if task["reward"] is not None]
    return {
        "tasks": len(tasks),
        "scored": len(scored),
        "attempts": len(attempts),
        "mean": round(sum(scored) / len(scored), 4) if scored else None,
        "exceptions": sum(1 for task in tasks if task["exception"] is not None),
        "usage": {
            "inputTokens": sum(task["usage"]["inputTokens"] for task in tasks),
            "cacheHitTokens": sum(task["usage"]["cacheHitTokens"] for task in tasks),
            "outputTokens": sum(task["usage"]["outputTokens"] for task in tasks),
            "attemptsReportingUsage": sum(1 for a in attempts if a["usage"]),
        },
        "cost": _cost(table, attempts, priced_model),
    }


def merge_into(base: dict[str, Any], repair: dict[str, Any]) -> dict[str, Any]:
    """Complete a record with a repair run's tasks instead of replacing it.

    A suite run can lose a task to something outside the task — a build that
    failed, an environment that would not start. Re-running the whole suite to
    recover it would replace a record whose other tasks are already measured, so
    the repair run's tasks are folded in and the aggregate is recomputed. The two
    runs must describe the same subject: same mode, same upstream snapshot, same
    producer commit. A repair that changed any of those is a different subject
    and has to be a record of its own.
    """
    for field in ("mode", "upstream", "producer"):
        if base.get(field) != repair.get(field):
            raise SystemExit(
                f"merge refuses: {field} differs between the record and the repair run "
                f"({json.dumps(base.get(field))} vs {json.dumps(repair.get(field))})"
            )
    by_id = {task["id"]: task for task in base["tasks"]}
    added = [task["id"] for task in repair["tasks"] if task["id"] not in by_id]
    for task in repair["tasks"]:
        by_id[task["id"]] = task
    tasks = [by_id[key] for key in sorted(by_id)]
    attempts = [attempt for task in tasks for attempt in task["attempts"]]
    merged = dict(base)
    merged["tasks"] = tasks
    merged["runsPerTask"] = max((len(task["attempts"]) for task in tasks), default=0)
    merged["summary"] = _summary(tasks, attempts, load_price_table(), _priced_model(base))
    merged["merge"] = {
        "mergedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "addedTasks": added,
        "addedAttempts": sum(len(task["attempts"]) for task in repair["tasks"]),
    }
    return merged


def _priced_model(record: dict[str, Any]) -> str | None:
    identity = record.get("modelIdentity") or {}
    return identity.get("servedModel") or (record.get("agent") or {}).get("model")


def render_markdown(report: dict[str, Any]) -> str:
    """Human-readable companion to the JSON record."""
    agent = report["agent"]
    mode = report.get("mode") or {}
    identity = report.get("modelIdentity") or {}
    summary = report["summary"]
    cost = summary.get("cost") or {}
    usage = summary.get("usage") or {}
    lines = [
        f"# Benchmark report: {report['kind']}",
        "",
        f"- generated: {report['generatedAt']}",
        f"- producer commit: `{report['producer']['commit']}`"
        f"{' (dirty tree)' if report['producer']['dirty'] else ''}",
        f"- upstream: {report['upstream']['repository']} @ `{report['upstream']['commit']}`",
        f"- mode: **{mode.get('id')}** (runner={mode.get('runner')}, profile={mode.get('profile')})",
        f"- agent: {agent.get('name')} {agent.get('version') or ''}"
        f" model={agent.get('model')}".rstrip(),
    ]
    skills = mode.get("skills")
    if skills:
        lines.append(f"- community skills: {', '.join(skills.get('loaded') or []) or 'none'} @ `{skills.get('commit')}`")
    if identity:
        lines.append(
            f"- served build: `{identity.get('servedModel')}`"
            f" fingerprint `{identity.get('systemFingerprint')}`"
            f"{' (probe failed: ' + str(identity.get('error')) + ')' if identity.get('error') else ''}"
        )
    lines += [
        f"- runs per task: {report.get('runsPerTask')}",
        "",
        "| task | reward (median) | range | duration | exception |",
        "|---|---|---|---|---|",
    ]
    for task in report["tasks"]:
        reward = "-" if task["reward"] is None else f"{task['reward']:.3f}"
        spread = "-"
        if task["rewardMin"] is not None and task["rewardMax"] is not None:
            spread = f"{task['rewardMin']:.3f}–{task['rewardMax']:.3f}"
        durations = [a["durationSeconds"] for a in task["attempts"] if a["durationSeconds"] is not None]
        duration = "-" if not durations else f"{round(sum(durations) / len(durations))}s"
        lines.append(
            f"| `{task['id']}` | {reward} | {spread} | {duration} | {task['exception'] or '-'} |"
        )
    cost_line = (
        f"cost {cost.get('usd')} USD ({cost.get('status')}, table {cost.get('tableFetchedAt')})"
        if cost.get("usd") is not None
        else f"cost unreported ({cost.get('status')})"
    )
    lines += [
        "",
        f"**Summary**: {summary['scored']}/{summary['tasks']} tasks scored over {summary['attempts']} attempt(s), "
        f"mean {summary['mean']}, {summary['exceptions']} exception(s)",
        f"**Usage**: {usage.get('inputTokens')} cache-miss + {usage.get('cacheHitTokens')} cache-hit input, "
        f"{usage.get('outputTokens')} output tokens; {cost_line}",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_dirs", nargs="*", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--kind", default="upstream-benchmark")
    parser.add_argument("--upstream-commit", default=None)
    parser.add_argument("--mode", default="native")
    parser.add_argument("--model", default=None)
    parser.add_argument("--probe-json", type=Path, default=None,
                        help="a model_probe.py record; omitted, the identity is recorded as unknown")
    parser.add_argument("--merge-into", type=Path, default=None,
                        help="complete an existing record with this run's tasks instead of writing a new one")
    parser.add_argument("--tasks-dir", type=Path, default=None,
                        help="the suite's task directory; used to undo Harbor's id truncation")
    args = parser.parse_args(argv)

    jobs = [path for path in args.job_dirs if path.is_dir()]
    if not jobs:
        print("dsh-migrate: no job directories given", file=sys.stderr)
        return 2

    probe: dict[str, Any] | None = None
    if args.probe_json is not None and args.probe_json.is_file():
        try:
            probe = json.loads(args.probe_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            probe = {"error": f"{args.probe_json} is not valid JSON"}

    known_tasks: list[str] = []
    if args.tasks_dir is not None and args.tasks_dir.is_dir():
        known_tasks = sorted(entry.name for entry in args.tasks_dir.iterdir() if entry.is_dir())

    report = collect(
        jobs,
        args.kind,
        args.upstream_commit,
        mode=args.mode,
        model=args.model,
        probe=probe,
        out_dir=args.out_dir,
        known_tasks=known_tasks,
    )
    args.out_dir.mkdir(parents=True, exist_ok=True)

    if args.merge_into is not None:
        base = json.loads(args.merge_into.read_text(encoding="utf-8"))
        merged = merge_into(base, report)
        target = args.merge_into.with_suffix(".json")
        target.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        args.merge_into.with_suffix(".md").write_text(render_markdown(merged), encoding="utf-8")
        print(f"dsh-migrate: merged {len(merged['merge']['addedTasks'])} task(s) into {target}", file=sys.stderr)
        print(render_markdown(merged))
        return 0

    stamp = report["generatedAt"].replace(":", "").replace("-", "")
    name = f"{stamp}-{args.mode}"
    json_path = args.out_dir / f"{name}.json"
    md_path = args.out_dir / f"{name}.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"dsh-migrate: wrote {json_path} and {md_path}", file=sys.stderr)
    print(render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
