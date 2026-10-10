import { AGENT_TIMEOUT } from './harbor.ts'
import type { Attempt, TaskEntry } from './record.ts'

/**
 * The metrics of a benchmark record, computed from its attempts.
 *
 * Every metric belongs to one quality and is defined over the attempts and the
 * task list alone, never over a stage of the workflow, so a change to the
 * workflow changes how an attempt is produced and not how it is scored.
 * `docs/reference/metrics.md` is generated from {@link METRICS}.
 *
 * The conventions every metric applies are stated in that reference.
 */

export const FORMULA = 'v1'

/** The success threshold of a full migration; `passRate@0.7` uses the lower one. */
const FULL = 1
const USABLE = 0.7
const BOOTSTRAP_SAMPLES = 10_000
const BOOTSTRAP_SEED = 0x5eed

export type Quality = 'effectiveness' | 'consistency' | 'efficiency' | 'infrastructure'

export interface Metric {
  id: string
  quality: Quality
  description: string
  compute: (input: MetricInput) => number | null
  /** The metric over a resample of task scores, for metrics that report a 95% bootstrap interval. */
  interval?: (sample: readonly TaskScores[]) => number | null
}

export interface MetricInput {
  tasks: readonly TaskEntry[]
  attempts: readonly Attempt[]
  /** Attempts per task the run asked for. */
  k: number
}

interface TaskScores {
  task: string
  family: string
  rewards: number[]
}

/** The counted rewards of every eligible task that has at least one. */
export function taskScores(input: Pick<MetricInput, 'tasks' | 'attempts'>): TaskScores[] {
  const scores: TaskScores[] = []
  for (const task of input.tasks) {
    if (!task.applicable || !task.feasible) continue
    const rewards = input.attempts
      .filter(attempt => attempt.task === task.id)
      .flatMap((attempt) => {
        if (attempt.outcome === 'scored') return [attempt.reward ?? 0]
        if (attempt.outcome === 'timeout' || attempt.outcome === 'exception') return [0]
        return []
      })
    if (rewards.length > 0) scores.push({ task: task.id, family: task.family, rewards })
  }
  return scores
}

const mean = (values: readonly number[]): number | null => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const below = Math.floor(position)
  const above = Math.ceil(position)
  const low = sorted[below] as number
  const high = sorted[above] as number
  return low + (high - low) * (position - below)
}

function sd(values: readonly number[]): number {
  const m = mean(values) ?? 0
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1))
}

/** n choose k, exact for the small numbers attempts are. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let result = 1
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i
  return result
}

const taskMean = (scores: readonly TaskScores[], value: (rewards: number[]) => number): number | null =>
  mean(scores.map(score => value(score.rewards)))

const meanReward = (scores: readonly TaskScores[]): number | null => taskMean(scores, rewards => mean(rewards) ?? 0)
const passRate = (scores: readonly TaskScores[], threshold: number): number | null =>
  taskMean(scores, rewards => rewards.filter(reward => reward >= threshold).length / rewards.length)

function passAt(input: MetricInput, hat: boolean): number | null {
  const values: number[] = []
  for (const score of taskScores(input)) {
    const n = score.rewards.length
    if (n < input.k) continue
    const c = score.rewards.filter(reward => reward >= FULL).length
    values.push(hat ? choose(c, input.k) / choose(n, input.k) : 1 - choose(n - c, input.k) / choose(n, input.k))
  }
  return mean(values)
}

function eligibleAttempts(input: MetricInput): Attempt[] {
  const eligible = new Set(input.tasks.filter(task => task.applicable && task.feasible).map(task => task.id))
  return input.attempts.filter(attempt => eligible.has(attempt.task))
}

function sumOf(attempts: readonly Attempt[], field: 'inputTokens' | 'cacheHitTokens' | 'outputTokens'): number {
  return attempts.reduce((sum, attempt) => sum + (attempt.usage?.[field] ?? 0), 0)
}

function rate(input: MetricInput, match: (attempt: Attempt) => boolean): number | null {
  const attempts = eligibleAttempts(input)
  return attempts.length === 0 ? null : attempts.filter(match).length / attempts.length
}

const FAMILIES = ['S', 'M', 'H'] as const

export const METRICS: readonly Metric[] = [
  { id: 'meanReward', quality: 'effectiveness', interval: meanReward, description: 'Mean reward: the mean over tasks of the mean counted reward.', compute: input => meanReward(taskScores(input)) },
  { id: 'passRate@1.0', quality: 'effectiveness', interval: sample => passRate(sample, FULL), description: 'Share of counted attempts that fully migrate (reward 1.0), averaged per task (pass@1).', compute: input => passRate(taskScores(input), FULL) },
  { id: 'passRate@0.7', quality: 'effectiveness', description: 'Share of counted attempts with a usable migration (reward ≥ 0.7), averaged per task.', compute: input => passRate(taskScores(input), USABLE) },
  { id: 'passAtK', quality: 'effectiveness', description: 'pass@k with k = attempts per task: the chance that at least one of k attempts fully migrates; `1 − C(n−c,k)/C(n,k)` per task.', compute: input => passAt(input, false) },
  ...FAMILIES.map((family): Metric => ({
    id: `meanReward.${family}`,
    quality: 'effectiveness',
    description: `Mean reward over the \`${family}\` tasks.`,
    compute: input => meanReward(taskScores(input).filter(score => score.family === family)),
  })),
  { id: 'passHatK', quality: 'consistency', description: 'pass^k with k = attempts per task: the chance that all k attempts fully migrate; `C(c,k)/C(n,k)` per task.', compute: input => passAt(input, true) },
  { id: 'fragility', quality: 'consistency', description: '`passRate@1.0 − passHatK`: how much of the success rate is luck.', compute: (input) => {
    const once = passRate(taskScores(input), FULL)
    const always = passAt(input, true)
    return once === null || always === null ? null : once - always
  } },
  { id: 'dispersion', quality: 'consistency', description: 'Mean over tasks with two or more counted attempts of the standard deviation of their rewards.', compute: input => mean(taskScores(input).filter(score => score.rewards.length > 1).map(score => sd(score.rewards))) },
  { id: 'unstableTaskShare', quality: 'consistency', description: 'Share of tasks whose attempts both fully migrated and did not.', compute: input => mean(taskScores(input).map((score) => {
    const passed = score.rewards.filter(reward => reward >= FULL).length
    return passed > 0 && passed < score.rewards.length ? 1 : 0
  })) },
  { id: 'inputTokens', quality: 'efficiency', description: 'Mean uncached input tokens per attempt that reported usage.', compute: input => mean(eligibleAttempts(input).filter(attempt => attempt.usage !== undefined).map(attempt => attempt.usage?.inputTokens ?? 0)) },
  { id: 'outputTokens', quality: 'efficiency', description: 'Mean output tokens per attempt that reported usage.', compute: input => mean(eligibleAttempts(input).filter(attempt => attempt.usage !== undefined).map(attempt => attempt.usage?.outputTokens ?? 0)) },
  { id: 'cacheHitRatio', quality: 'efficiency', description: '`cache-hit tokens / (cache-hit + uncached input tokens)` over every attempt that reported usage.', compute: (input) => {
    const attempts = eligibleAttempts(input)
    const hits = sumOf(attempts, 'cacheHitTokens')
    const total = hits + sumOf(attempts, 'inputTokens')
    return total === 0 ? null : hits / total
  } },
  { id: 'costPerAttempt', quality: 'efficiency', description: 'Mean USD per attempt that reported a cost.', compute: input => mean(eligibleAttempts(input).flatMap(attempt => attempt.usage?.usd === undefined ? [] : [attempt.usage.usd])) },
  { id: 'costPerSuccess', quality: 'efficiency', description: 'Total USD divided by the number of attempts that fully migrated.', compute: (input) => {
    const attempts = eligibleAttempts(input)
    const successes = attempts.filter(attempt => attempt.outcome === 'scored' && (attempt.reward ?? 0) >= FULL).length
    const priced = attempts.flatMap(attempt => attempt.usage?.usd === undefined ? [] : [attempt.usage.usd])
    return successes === 0 || priced.length === 0 ? null : priced.reduce((sum, usd) => sum + usd, 0) / successes
  } },
  { id: 'agentSecP50', quality: 'efficiency', description: 'Median agent wall time per attempt, in seconds.', compute: input => quantile(eligibleAttempts(input).flatMap(attempt => attempt.durations.agentSec ?? []), 0.5) },
  { id: 'agentSecP90', quality: 'efficiency', description: '90th percentile of the agent wall time per attempt, in seconds.', compute: input => quantile(eligibleAttempts(input).flatMap(attempt => attempt.durations.agentSec ?? []), 0.9) },
  { id: 'timeoutRate', quality: 'efficiency', description: 'Share of attempts on eligible tasks that hit the agent timeout, scored or not.', compute: input => rate(input, attempt => attempt.exception === AGENT_TIMEOUT) },
  { id: 'infrastructureRate', quality: 'infrastructure', description: 'Share of attempts on eligible tasks that failed for a reason outside the subject: environment start, setup, verifier.', compute: input => rate(input, attempt => attempt.outcome === 'infrastructure') },
  { id: 'eligibleTasks', quality: 'infrastructure', description: 'Tasks that are applicable to the subject and feasible in the environment.', compute: input => input.tasks.filter(task => task.applicable && task.feasible).length },
  { id: 'infeasibleTasks', quality: 'infrastructure', description: 'Applicable tasks the environment cannot run: the oracle scored below 1.0, or the network policy could not be enforced.', compute: input => input.tasks.filter(task => task.applicable && !task.feasible).length },
]

/** A deterministic generator, so a recomputed interval equals the stored one. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * A 95% percentile bootstrap interval of a statistic over tasks.
 * @param tasks - one value per task.
 * @param statistic - the statistic of a resample.
 */
export function bootstrap<T>(tasks: readonly T[], statistic: (sample: readonly T[]) => number | null): [number, number] | undefined {
  if (tasks.length < 2) return undefined
  const next = random(BOOTSTRAP_SEED)
  const values: number[] = []
  for (let i = 0; i < BOOTSTRAP_SAMPLES; i += 1) {
    const sample = tasks.map(() => tasks[Math.floor(next() * tasks.length)] as T)
    const value = statistic(sample)
    if (value !== null) values.push(value)
  }
  const low = quantile(values, 0.025)
  const high = quantile(values, 0.975)
  return low === null || high === null ? undefined : [round(low), round(high)]
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6

/** Every metric of a record, and the intervals of those that report one. */
export function computeMetrics(input: MetricInput): { formula: string; values: Record<string, number | null>; intervals: Record<string, [number, number]> } {
  const values: Record<string, number | null> = {}
  const intervals: Record<string, [number, number]> = {}
  const scores = taskScores(input)
  for (const metric of METRICS) {
    const value = metric.compute(input)
    values[metric.id] = value === null ? null : round(value)
    if (metric.interval === undefined) continue
    const interval = bootstrap(scores, metric.interval)
    if (interval !== undefined) intervals[metric.id] = interval
  }
  return { formula: FORMULA, values, intervals }
}

export interface Comparison {
  metric: 'meanReward' | 'passRate@1.0'
  tasks: number
  delta: number | null
  interval?: [number, number] | undefined
  verdict: 'regression' | 'improvement' | 'no-change' | 'not-comparable'
}

/**
 * Compare two records of the same subject and suite, task by task.
 *
 * A difference is a regression or an improvement only when its 95% paired
 * bootstrap interval excludes zero; the tasks are resampled, not the attempts,
 * because attempts of one task share their failure causes.
 */
export function compare(base: MetricInput, head: MetricInput): Comparison[] {
  const before = new Map(taskScores(base).map(score => [score.task, score]))
  const pairs = taskScores(head).flatMap((score) => {
    const old = before.get(score.task)
    return old === undefined ? [] : [{ before: old.rewards, after: score.rewards }]
  })
  return (['meanReward', 'passRate@1.0'] as const).map((metric) => {
    const value = (rewards: number[]): number => metric === 'meanReward'
      ? mean(rewards) ?? 0
      : rewards.filter(reward => reward >= FULL).length / rewards.length
    const deltaOf = (sample: readonly (typeof pairs)[number][]): number | null => mean(sample.map(pair => value(pair.after) - value(pair.before)))
    if (pairs.length === 0) return { metric, tasks: 0, delta: null, verdict: 'not-comparable' as const }
    const delta = deltaOf(pairs)
    const interval = bootstrap(pairs, deltaOf)
    const verdict = interval === undefined ? 'no-change' as const : interval[1] < 0 ? 'regression' as const : interval[0] > 0 ? 'improvement' as const : 'no-change' as const
    return { metric, tasks: pairs.length, delta: delta === null ? null : round(delta), interval, verdict }
  })
}
