---
kind: reference
description: Every benchmark metric: its quality, its definition and the conventions all of them share.
---

# Metrics reference

The metrics of a benchmark record, formula `v1`. This page is generated from `src/evaluation/metrics.ts` by `scripts/references.ts`; edit the source, not this page.

Conventions, applied by every metric:

- An *eligible* task is applicable to the subject and feasible in the environment.
- A *counted* attempt is one on an eligible task whose outcome is `scored` (its reward), `timeout` or `exception` (reward 0). `infrastructure` attempts are not counted; `infrastructureRate` measures them.
- Suite means weight every task equally: the attempts of a task are averaged first.
- A metric with an interval reports a 95% percentile bootstrap over tasks, 10,000 resamples with a fixed seed, so a recomputed interval equals the stored one.
- A metric without its inputs, such as a cost when no attempt reported one, is `null`, never 0.

| Metric | Quality | Interval | Definition |
| --- | --- | --- | --- |
| `meanReward` | effectiveness | yes | Mean reward: the mean over tasks of the mean counted reward. |
| `passRate@1.0` | effectiveness | yes | Share of counted attempts that fully migrate (reward 1.0), averaged per task (pass@1). |
| `passRate@0.7` | effectiveness | no | Share of counted attempts with a usable migration (reward ≥ 0.7), averaged per task. |
| `passAtK` | effectiveness | no | pass@k with k = attempts per task: the chance that at least one of k attempts fully migrates; `1 − C(n−c,k)/C(n,k)` per task. |
| `meanReward.S` | effectiveness | no | Mean reward over the `S` tasks. |
| `meanReward.M` | effectiveness | no | Mean reward over the `M` tasks. |
| `meanReward.H` | effectiveness | no | Mean reward over the `H` tasks. |
| `passHatK` | consistency | no | pass^k with k = attempts per task: the chance that all k attempts fully migrate; `C(c,k)/C(n,k)` per task. |
| `fragility` | consistency | no | `passRate@1.0 − passHatK`: how much of the success rate is luck. |
| `dispersion` | consistency | no | Mean over tasks with two or more counted attempts of the standard deviation of their rewards. |
| `unstableTaskShare` | consistency | no | Share of tasks whose attempts both fully migrated and did not. |
| `inputTokens` | efficiency | no | Mean uncached input tokens per attempt that reported usage. |
| `outputTokens` | efficiency | no | Mean output tokens per attempt that reported usage. |
| `cacheHitRatio` | efficiency | no | `cache-hit tokens / (cache-hit + uncached input tokens)` over every attempt that reported usage. |
| `costPerAttempt` | efficiency | no | Mean USD per attempt that reported a cost. |
| `costPerSuccess` | efficiency | no | Total USD divided by the number of attempts that fully migrated. |
| `agentSecP50` | efficiency | no | Median agent wall time per attempt, in seconds. |
| `agentSecP90` | efficiency | no | 90th percentile of the agent wall time per attempt, in seconds. |
| `timeoutRate` | efficiency | no | Share of attempts on eligible tasks that hit the agent timeout, scored or not. |
| `infrastructureRate` | infrastructure | no | Share of attempts on eligible tasks that failed for a reason outside the subject: environment start, setup, verifier. |
| `eligibleTasks` | infrastructure | no | Tasks that are applicable to the subject and feasible in the environment. |
| `infeasibleTasks` | infrastructure | no | Applicable tasks the environment cannot run: the oracle scored below 1.0, or the network policy could not be enforced. |
