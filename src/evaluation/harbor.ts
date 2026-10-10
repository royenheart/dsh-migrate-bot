import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_TIMEOUT } from './metrics.ts'
import type { Attempt, Outcome, Usage } from './record.ts'

/**
 * Reading the trial directories Harbor writes: `<job>/<trial>/result.json`,
 * with the agent's files under `agent/` and the verifier's under `verifier/`.
 *
 * Only the fields an attempt is built from are parsed; the format is Harbor
 * 0.24's `TrialResult`, and any other field passes through unread.
 */

const timing = z.object({ started_at: z.string().nullish(), finished_at: z.string().nullish() }).nullish()

const trialSchema = z.object({
  task_name: z.string(),
  trial_name: z.string(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  agent_result: z.object({
    n_input_tokens: z.number().nullish(),
    n_cache_tokens: z.number().nullish(),
    n_output_tokens: z.number().nullish(),
    cost_usd: z.number().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  }).nullish(),
  verifier_result: z.object({ rewards: z.record(z.string(), z.number()).nullish() }).nullish(),
  exception_info: z.object({ exception_type: z.string() }).nullish(),
  agent_execution: timing,
  verifier: timing,
})
export type TrialResult = z.infer<typeof trialSchema>

export function readTrial(dir: string): TrialResult {
  return trialSchema.parse(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')))
}

/**
 * Why an attempt has its reward or has none, from the phase the trial reached.
 *
 * Harbor runs the verifier after an agent run that timed out or exited non-zero,
 * so a reward is the score whatever the agent did. Without one, the phases tell
 * the cause: a verifier that started and wrote no reward, or a trial that
 * stopped before the agent ran, is the environment's failure; a trial that
 * stopped in the agent run is the subject's.
 */
export function outcomeOf(trial: TrialResult): Outcome {
  if (trial.verifier_result?.rewards?.reward !== undefined) return 'scored'
  if (trial.verifier?.started_at != null) return 'infrastructure'
  if (trial.agent_execution?.started_at != null) return trial.exception_info?.exception_type === AGENT_TIMEOUT ? 'timeout' : 'exception'
  return 'infrastructure'
}

type Span = { started_at?: string | null | undefined; finished_at?: string | null | undefined }

function seconds(span: Span | null | undefined): number | undefined {
  if (span?.started_at == null || span.finished_at == null) return undefined
  return Math.round((Date.parse(span.finished_at) - Date.parse(span.started_at)) / 100) / 10
}

/** Harbor counts cache hits inside `n_input_tokens`; a record counts them apart. */
function usageOf(trial: TrialResult): Usage | undefined {
  const result = trial.agent_result
  if (result?.n_input_tokens == null && result?.n_output_tokens == null) return undefined
  const cacheHitTokens = result.n_cache_tokens ?? 0
  return {
    inputTokens: Math.max(0, (result.n_input_tokens ?? 0) - cacheHitTokens),
    cacheHitTokens,
    outputTokens: result.n_output_tokens ?? 0,
    ...(result.cost_usd == null ? {} : { usd: result.cost_usd }),
  }
}

/** An attempt of a trial, before it is numbered within its task and its files are copied. */
export function attemptOf(trial: TrialResult): Omit<Attempt, 'attempt' | 'artifacts'> {
  const rewards = trial.verifier_result?.rewards ?? {}
  const exitCode = trial.agent_result?.metadata?.agent_exit_code
  const usage = usageOf(trial)
  const durations = {
    agentSec: seconds(trial.agent_execution),
    verifierSec: seconds(trial.verifier),
    totalSec: seconds(trial),
  }
  return {
    task: trial.task_name,
    trial: trial.trial_name,
    outcome: outcomeOf(trial),
    ...(rewards.reward === undefined ? {} : { reward: rewards.reward }),
    rewards,
    ...(trial.exception_info == null ? {} : { exception: trial.exception_info.exception_type }),
    ...(typeof exitCode === 'number' ? { agentExitCode: exitCode } : {}),
    durations: Object.fromEntries(Object.entries(durations).filter(([, value]) => value !== undefined)),
    ...(usage === undefined ? {} : { usage }),
  }
}
