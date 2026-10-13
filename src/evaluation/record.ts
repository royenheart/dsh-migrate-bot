import { z } from 'zod'

/**
 * A benchmark record: one benchmark run of one subject on one suite snapshot,
 * at one commit of this repository.
 *
 * Records are immutable. The report is a pure function of the records, and CI
 * recomputes `metrics` from `attempts` and refuses a record whose stored
 * metrics differ. `docs/reference/records.md` is generated from this schema.
 */

export const RECORD_SCHEMA = 3

export const SUBJECTS = ['pipeline', 'pipeline+skills', 'session', 'session+skills', 'oracle', 'nop'] as const
export type SubjectId = (typeof SUBJECTS)[number]

export const OUTCOMES = ['scored', 'timeout', 'exception', 'infrastructure'] as const
export type Outcome = (typeof OUTCOMES)[number]

const artifactSchema = z.strictObject({
  path: z.string().min(1).describe('Path relative to the record directory.'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).describe('SHA-256 of the file, checked by `npm run bench -- validate`.'),
  bytes: z.number().int().min(0).describe('File size.'),
})

export const usageSchema = z.strictObject({
  inputTokens: z.number().int().min(0).describe('Input tokens that missed the cache.'),
  cacheHitTokens: z.number().int().min(0).describe('Input tokens served from the cache.'),
  outputTokens: z.number().int().min(0).describe('Output tokens, reasoning included.'),
  usd: z.number().min(0).optional().describe('Cost at the published rates, when the model has them.'),
})
export type Usage = z.infer<typeof usageSchema>

export const attemptSchema = z.strictObject({
  task: z.string().min(1).describe('The task id, its directory name in the suite.'),
  attempt: z.number().int().min(1).describe('1-based attempt number within the task.'),
  trial: z.string().min(1).describe('The Harbor trial name.'),
  outcome: z.enum(OUTCOMES).describe('`scored` when the verifier produced a reward; otherwise the phase that stopped the attempt: `timeout` and `exception` in the agent run, `infrastructure` in the environment setup or the verifier.'),
  reward: z.number().min(0).max(1).optional().describe('The `reward` the verifier wrote, present when scored.'),
  rewards: z.record(z.string(), z.number()).describe('Every reward the verifier wrote.'),
  exception: z.string().optional().describe('The Harbor exception type, when one was raised.'),
  agentExitCode: z.number().int().optional().describe('Exit code of the subject\'s command: `dsh` for a session, `dsh-migrate run` for a pipeline.'),
  durations: z.strictObject({
    agentSec: z.number().min(0).optional().describe('The agent run, from Harbor `agent_execution`.'),
    verifierSec: z.number().min(0).optional().describe('The verifier, from Harbor `verifier`.'),
    totalSec: z.number().min(0).optional().describe('The whole trial, environment setup included.'),
  }),
  usage: usageSchema.optional().describe('Token usage, when the subject reported it.'),
  artifacts: z.record(z.string(), artifactSchema).describe('Files the attempt produced, by name: `proposed.diff`, `events.jsonl`, `agent.log`, `verifier.log`, `reports/*.md`.'),
})
export type Attempt = z.infer<typeof attemptSchema>

export const taskSchema = z.strictObject({
  id: z.string().min(1).describe('The task directory name.'),
  family: z.string().min(1).describe('The task id prefix: `S` static, `M` migration, `H` hands-on.'),
  networkMode: z.string().min(1).describe('`network_mode` of the task.'),
  agentTimeoutSec: z.number().min(0).describe('`agent.timeout_sec` of the task, before the multiplier.'),
  applicable: z.boolean().describe('Whether the subject can attempt the task; a `pipeline` subject does not answer the static tasks.'),
  feasible: z.boolean().describe('Whether every attempt of the newest oracle record of this suite commit scored 1.0 on the task; always true in an oracle record.'),
  note: z.string().optional().describe('Why the task is not applicable or not feasible.'),
})
export type TaskEntry = z.infer<typeof taskSchema>

const probeSchema = z.strictObject({
  at: z.iso.datetime().describe('When the probe answered.'),
  servedModel: z.string().describe('The `model` of the probe response, which names the build rather than the request.'),
  fingerprint: z.string().optional().describe('The `system_fingerprint` of the probe response.'),
})

export const recordSchema = z.strictObject({
  schema: z.literal(RECORD_SCHEMA).describe('The record format version.'),
  id: z.string().min(1).describe('`<producer commit, 12 hex>__<suite commit, 12 hex>__<subject>__<UTC timestamp>`; the record directory name.'),
  createdAt: z.iso.datetime().describe('When the run started.'),
  producer: z.strictObject({
    commit: z.string().regex(/^[0-9a-f]{40}$/).describe('The commit of this repository that ran.'),
    version: z.string().min(1).describe('Its package version.'),
    dirty: z.boolean().describe('A dirty tree is refused unless the run asked for it, and then the report labels it.'),
    message: z.string().describe('The first line of the commit message; the commit may be rewritten later, the record keeps what it said.'),
    snapshot: z.string().regex(/^[0-9a-f]{16}$/).describe('The hash of what the Action brought to the run, stored under `snapshots/<hash>/`: the statechart, the configuration defaults, the prompts, the agent runtime, the upgrade skills and the source.'),
  }),
  subject: z.strictObject({
    id: z.enum(SUBJECTS).describe('What ran as the Harbor agent; docs/design/evaluation.md defines each.'),
    agentRuntime: z.string().describe('The dsh version of the agent runtime.'),
    skills: z.strictObject({
      commit: z.string().describe('The upgrade-skill commit the skills came from, for a `+skills` subject.'),
      names: z.array(z.string()).describe('The skills loaded.'),
    }).optional(),
    attempts: z.number().int().min(1).describe('Attempts per task.'),
    agentTimeoutMultiplier: z.number().positive().describe('Harbor `--agent-timeout-multiplier`.'),
  }),
  suite: z.strictObject({
    repository: z.string().describe('The suite repository.'),
    commit: z.string().regex(/^[0-9a-f]{40}$/).describe('For the upgrade-skill suite, the commit the `vendor/dsh-plugin-upgrade-skill` submodule pinned; for this repository\'s suite, the git tree of `bench/tasks`.'),
    tasks: z.array(taskSchema).describe('Every selected task, run or not.'),
    judge: z.strictObject({
      baseUrl: z.string(),
      model: z.string(),
    }).optional().describe('The model the suite\'s report judge scored written reports with (`REPORT_JUDGE_*`), when the run set one: scores from different judges do not compare.'),
  }),
  model: z.strictObject({
    provider: z.string().describe('The requested provider route.'),
    model: z.string().describe('The requested model.'),
    before: probeSchema.optional().describe('A one-token probe before the run; absent when it failed.'),
    after: probeSchema.optional().describe('The same probe after the run.'),
  }),
  environment: z.strictObject({
    harbor: z.string().describe('`harbor --version`.'),
    docker: z.string().describe('The Docker server version.'),
    os: z.string().describe('The host kernel.'),
    concurrency: z.number().int().min(1).describe('Harbor `-n`: trials at once.'),
  }),
  attempts: z.array(attemptSchema).describe('Every trial Harbor ran, numbered within its task in start order.'),
  metrics: z.strictObject({
    formula: z.string().describe('The version of `src/evaluation/metrics.ts` that computed the values.'),
    values: z.record(z.string(), z.number().nullable()).describe('Every metric of `docs/reference/metrics.md`, by id.'),
    intervals: z.record(z.string(), z.tuple([z.number(), z.number()])).describe('95% bootstrap intervals, by metric id.'),
  }),
})
export type BenchmarkRecord = z.infer<typeof recordSchema>
