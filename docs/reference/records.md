---
kind: reference
description: Every field of a benchmark record, schema 3.
---

# Benchmark record reference

A record is `records/<id>/record.json` on the `bench/records` branch, schema 3, beside the files its attempts kept. This page is generated from `src/evaluation/record.ts` by `scripts/references.ts`; edit the source, not this page.

| Field | Type | Description |
| --- | --- | --- |
| `schema` | number | The record format version. |
| `id` | string | `<producer commit, 12 hex>__<suite commit, 12 hex>__<subject>__<UTC timestamp>`; the record directory name. |
| `createdAt` | string | When the run started. |
| `producer.commit` | string | The commit of this repository that ran. |
| `producer.version` | string | Its package version. |
| `producer.dirty` | boolean | A dirty tree is refused unless the run asked for it, and then the report labels it. |
| `producer.message` | string | The first line of the commit message; the commit may be rewritten later, the record keeps what it said. |
| `producer.snapshot` | string | The hash of what the Action brought to the run, stored under `snapshots/<hash>/`: the statechart, the configuration defaults, the prompts, the agent runtime, the upgrade skills and the source. |
| `subject.id` | `pipeline` \| `pipeline+skills` \| `session` \| `session+skills` \| `oracle` \| `nop` | What ran as the Harbor agent; docs/design/evaluation.md defines each. |
| `subject.agentRuntime` | string | The dsh version of the agent runtime. |
| `subject.skills.commit` | string | The upgrade-skill commit the skills came from, for a `+skills` subject. |
| `subject.skills.names` | list of string | The skills loaded. |
| `subject.attempts` | integer | Attempts per task. |
| `subject.agentTimeoutMultiplier` | number | Harbor `--agent-timeout-multiplier`. |
| `suite.repository` | string | The suite repository. |
| `suite.commit` | string | For the upgrade-skill suite, the commit the `vendor/dsh-plugin-upgrade-skill` submodule pinned; for this repository's suite, the git tree of `bench/tasks`. |
| `suite.tasks` | list | Every selected task, run or not. |
| `suite.tasks[].id` | string | The task directory name. |
| `suite.tasks[].family` | string | The task id prefix: `S` static, `M` migration, `H` hands-on. |
| `suite.tasks[].networkMode` | string | `network_mode` of the task. |
| `suite.tasks[].agentTimeoutSec` | number | `agent.timeout_sec` of the task, before the multiplier. |
| `suite.tasks[].applicable` | boolean | Whether the subject can attempt the task; a `pipeline` subject does not answer the static tasks. |
| `suite.tasks[].feasible` | boolean | Whether every attempt of the newest oracle record of this suite commit scored 1.0 on the task; always true in an oracle record. |
| `suite.tasks[].note` | string | Why the task is not applicable or not feasible. |
| `model.provider` | string | The requested provider route. |
| `model.model` | string | The requested model. |
| `model.before.at` | string | When the probe answered. |
| `model.before.servedModel` | string | The `model` of the probe response, which names the build rather than the request. |
| `model.before.fingerprint` | string | The `system_fingerprint` of the probe response. |
| `model.after.at` | string | When the probe answered. |
| `model.after.servedModel` | string | The `model` of the probe response, which names the build rather than the request. |
| `model.after.fingerprint` | string | The `system_fingerprint` of the probe response. |
| `environment.harbor` | string | `harbor --version`. |
| `environment.docker` | string | The Docker server version. |
| `environment.os` | string | The host kernel. |
| `environment.concurrency` | integer | Harbor `-n`: trials at once. |
| `attempts` | list | Every trial Harbor ran, numbered within its task in start order. |
| `attempts[].task` | string | The task id, its directory name in the suite. |
| `attempts[].attempt` | integer | 1-based attempt number within the task. |
| `attempts[].trial` | string | The Harbor trial name. |
| `attempts[].outcome` | `scored` \| `timeout` \| `exception` \| `infrastructure` | `scored` when the verifier produced a reward; otherwise the phase that stopped the attempt: `timeout` and `exception` in the agent run, `infrastructure` in the environment setup or the verifier. |
| `attempts[].reward` | number | The `reward` the verifier wrote, present when scored. |
| `attempts[].rewards` | object | Every reward the verifier wrote. |
| `attempts[].exception` | string | The Harbor exception type, when one was raised. |
| `attempts[].agentExitCode` | integer | Exit code of the subject's command: `dsh` for a session, `dsh-migrate run` for a pipeline. |
| `attempts[].durations.agentSec` | number | The agent run, from Harbor `agent_execution`. |
| `attempts[].durations.verifierSec` | number | The verifier, from Harbor `verifier`. |
| `attempts[].durations.totalSec` | number | The whole trial, environment setup included. |
| `attempts[].usage.inputTokens` | integer | Input tokens that missed the cache. |
| `attempts[].usage.cacheHitTokens` | integer | Input tokens served from the cache. |
| `attempts[].usage.outputTokens` | integer | Output tokens, reasoning included. |
| `attempts[].usage.usd` | number | Cost at the published rates, when the model has them. |
| `attempts[].artifacts` | mapping | Files the attempt produced, by name: `proposed.diff`, `events.jsonl`, `agent.log`, `verifier.log`, `reports/*.md`. |
| `attempts[].artifacts.<id>.path` | string | Path relative to the record directory. |
| `attempts[].artifacts.<id>.sha256` | string | SHA-256 of the file, checked by `npm run bench -- validate`. |
| `attempts[].artifacts.<id>.bytes` | integer | File size. |
| `metrics.formula` | string | The version of `src/evaluation/metrics.ts` that computed the values. |
| `metrics.values` | object | Every metric of `docs/reference/metrics.md`, by id. |
| `metrics.intervals` | object | 95% bootstrap intervals, by metric id. |
