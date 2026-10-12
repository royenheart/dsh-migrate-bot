/**
 * The benchmark: run a subject on the upstream suite through Harbor and write a
 * record, compare two records, or validate a records tree.
 *
 *   npm run bench -- run --subject pipeline [--attempts 3] [--tasks M1-host-migration,H2-baseline-trap]
 *   npm run bench -- resume <job directory>
 *   npm run bench -- compare <base record id> <head record id>
 *   npm run bench -- validate [records dir]
 *   npm run bench -- publish [records dir]
 *
 * docs/operations/benchmark.md is the procedure; docs/design/evaluation.md the
 * design. Records are written to the `bench/records` worktree at `.bench/records`
 * and leave the machine only when the maintainer pushes that branch.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, type, release } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { z } from 'zod'
import { attemptOf, readTrial } from '../src/evaluation/harbor.ts'
import { compare, computeMetrics } from '../src/evaluation/metrics.ts'
import { recordSchema, RECORD_SCHEMA, SUBJECTS, type Attempt, type BenchmarkRecord, type SubjectId, type TaskEntry } from '../src/evaluation/record.ts'
import { UPGRADE_SKILLS } from '../src/skills/upgrade.ts'
import { REPO_ROOT } from './repo.ts'
import { botSnapshot, checkSnapshot, storeSnapshot } from './snapshot.ts'

const SUITE_REPOSITORY = 'oh-my-dsh/dsh-plugin-upgrade-skill'
const SUITE_DIR = join(REPO_ROOT, 'vendor', 'dsh-plugin-upgrade-skill')
const TASKS_DIR = join(SUITE_DIR, 'benchmark', 'tasks')
const RECORDS_DIR = join(REPO_ROOT, '.bench', 'records')
const AGENT = 'tools.harbor.dsh_agent:DshAgent'
/** The files of a trial a record keeps, relative to the trial directory. */
const AGENT_FILES = ['agent/proposed.diff', 'agent/agent.log', 'agent/events.jsonl', 'agent/status.json']

const git = (args: string[], cwd = REPO_ROOT): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const recordPath = (records: string, id: string): string => join(records, 'records', id, 'record.json')

function readRecord(path: string): BenchmarkRecord {
  return recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** The tasks of the suite, read with Python's own TOML parser, as Harbor reads them. */
function suiteTasks(python: string): Array<{ id: string; name: string; networkMode: string; agentTimeoutSec: number; shipsDsh: boolean; verifierEnv: string[] }> {
  const read = 'import json, sys, tomllib\nprint(json.dumps([tomllib.load(open(path, "rb")) for path in sys.argv[1:]]))'
  const ids = readdirSync(TASKS_DIR).filter(id => existsSync(join(TASKS_DIR, id, 'task.toml'))).sort()
  const configs = JSON.parse(execFileSync(python, ['-c', read, ...ids.map(id => join(TASKS_DIR, id, 'task.toml'))], { encoding: 'utf8' })) as Array<{ task?: { name?: string }; agent?: { timeout_sec?: number }; environment?: { network_mode?: string }; verifier?: { env?: Record<string, string> } }>
  return ids.map((id, index) => {
    const config = configs[index] ?? {}
    const dockerfile = join(TASKS_DIR, id, 'environment', 'Dockerfile')
    return {
      id,
      name: config.task?.name ?? id,
      networkMode: config.environment?.network_mode ?? 'public',
      agentTimeoutSec: config.agent?.timeout_sec ?? 0,
      shipsDsh: existsSync(dockerfile) && readFileSync(dockerfile, 'utf8').includes('@deepseek-ai/dsh@'),
      // Harbor fills `${NAME}` in the verifier's environment from the shell, and refuses the whole job when one is unset.
      verifierEnv: Object.values(config.verifier?.env ?? {}).flatMap(value => [...value.matchAll(/\$\{(\w+)\}/g)].map(match => match[1] ?? '')),
    }
  })
}

/** Tasks whose every attempt in the newest oracle record of this suite commit scored 1.0. */
function feasibleTasks(records: string, suiteCommit: string): Set<string> {
  const dir = join(records, 'records')
  const oracle = (existsSync(dir) ? readdirSync(dir) : [])
    .filter(id => existsSync(recordPath(records, id)))
    .map(id => readRecord(recordPath(records, id)))
    .filter(record => record.subject.id === 'oracle' && record.suite.commit === suiteCommit)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1)
  if (oracle === undefined) throw new Error(`no oracle record of suite commit ${suiteCommit}; run \`npm run bench -- run --subject oracle\` first`)
  const failed = new Set(oracle.attempts.filter(attempt => attempt.reward !== 1).map(attempt => attempt.task))
  return new Set(oracle.suite.tasks.filter(task => !failed.has(task.id) && oracle.attempts.some(attempt => attempt.task === task.id)).map(task => task.id))
}

/** Which build served the model, asked once with a one-token request; a failed probe is logged and omitted. */
async function probe(model: string, apiKey: string): Promise<BenchmarkRecord['model']['before']> {
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json() as { model?: string; system_fingerprint?: string }
    if (!response.ok || body.model === undefined) throw new Error(`HTTP ${String(response.status)}`)
    return { at: new Date().toISOString(), servedModel: body.model, ...(body.system_fingerprint === undefined ? {} : { fingerprint: body.system_fingerprint }) }
  } catch (error) {
    console.error(`model probe failed: ${(error as Error).message}`)
    return undefined
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(path => statSync(join(dir, path)).isFile())
}

/** Copy the kept files of a trial into the record and describe them. */
function keepArtifacts(trialDir: string, recordDir: string, trial: string): Attempt['artifacts'] {
  const kept = [...AGENT_FILES, ...filesUnder(join(trialDir, 'verifier')).map(path => join('verifier', path))]
  const artifacts: Attempt['artifacts'] = {}
  for (const name of kept) {
    const source = join(trialDir, name)
    if (!existsSync(source)) continue
    const path = join('attempts', trial, name)
    mkdirSync(dirname(join(recordDir, path)), { recursive: true })
    copyFileSync(source, join(recordDir, path))
    artifacts[name] = { path, sha256: sha256(source), bytes: statSync(source).size }
  }
  return artifacts
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'subject': { type: 'string' },
      'attempts': { type: 'string', default: '3' },
      'tasks': { type: 'string' },
      'concurrency': { type: 'string', default: '1' },
      'agent-timeout-multiplier': { type: 'string', default: '1' },
      'model': { type: 'string', default: 'deepseek-official/deepseek-v4-flash' },
      'harbor': { type: 'string', default: process.env.HARBOR_BIN ?? 'harbor' },
      'records': { type: 'string', default: RECORDS_DIR },
      'allow-dirty': { type: 'boolean', default: false },
    },
  })
  const subject = SUBJECTS.find(id => id === values.subject)
  if (subject === undefined) throw new Error(`--subject must be one of ${SUBJECTS.join(', ')}`)
  const records = values.records
  if (!existsSync(records)) throw new Error(`no records worktree at ${records}; docs/operations/benchmark.md sets it up`)
  if (!existsSync(TASKS_DIR)) throw new Error('the suite is missing: git submodule update --init vendor/dsh-plugin-upgrade-skill')
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== ''
  if (dirty && !values['allow-dirty']) throw new Error('the working tree has changes; commit them, or pass --allow-dirty and the record says so')
  const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
  if (subject !== 'oracle' && apiKey === '') throw new Error('DEEPSEEK_API_KEY is not set')

  const attempts = Number(values.attempts)
  const concurrency = Number(values.concurrency)
  const multiplier = Number(values['agent-timeout-multiplier'])
  const [provider = '', model = ''] = values.model.split('/')
  const producer = {
    commit: git(['rev-parse', 'HEAD']),
    version: (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version,
    dirty,
    message: git(['log', '-1', '--format=%s']),
    snapshot: storeSnapshot(records, await botSnapshot()),
  }
  const suiteCommit = git(['rev-parse', 'HEAD'], SUITE_DIR)
  const python = join(dirname(values.harbor), 'python3')
  const selected = values.tasks?.split(',').map(id => id.trim())
  const feasible = subject === 'oracle' ? undefined : feasibleTasks(records, suiteCommit)
  const suite = suiteTasks(existsSync(python) ? python : 'python3')
  const tasks: TaskEntry[] = suite
    .filter(task => selected === undefined || selected.includes(task.id))
    .map(task => {
      const unset = task.verifierEnv.filter(name => (process.env[name] ?? '') === '')
      const note = subject.startsWith('pipeline') && !task.shipsDsh
        ? 'The task installs no dsh release for the pipeline to target.'
        : unset.length > 0 ? `The verifier needs ${unset.join(', ')}, which this run does not set.` : undefined
      return {
        id: task.id,
        family: task.id[0] ?? '',
        networkMode: task.networkMode,
        agentTimeoutSec: task.agentTimeoutSec,
        applicable: (!subject.startsWith('pipeline') || (task.id[0] !== 'S' && task.shipsDsh)) && unset.length === 0,
        feasible: feasible === undefined || feasible.has(task.id),
        ...(note === undefined ? {} : { note }),
      }
    })
  /** Harbor names a trial's task by its `task.toml` name; a record by its directory. */
  const idOf = new Map(suite.map(task => [task.name, task.id]))
  const runnable = tasks.filter(task => task.applicable && task.feasible)
  if (runnable.length === 0) throw new Error('no selected task is applicable and feasible')

  const createdAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const id = `${producer.commit.slice(0, 12)}__${suiteCommit.slice(0, 12)}__${subject}__${createdAt.replace(/[-:]/g, '')}`
  const jobs = mkdtempSync(join(tmpdir(), 'dsh-migrate-bench-'))
  const harborArgs = ['run', '-p', TASKS_DIR, '-o', jobs, '--job-name', id, '-k', String(attempts), '-n', String(concurrency), '--agent-timeout-multiplier', String(multiplier)]
  for (const task of runnable) harborArgs.push('-i', task.id)
  if (subject === 'oracle') {
    harborArgs.push('-a', 'oracle')
  } else {
    const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', jobs], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n').at(-1) ?? ''
    harborArgs.push('-a', AGENT, '-m', values.model, '--ak', `subject=${subject}`, '--ak', `bot_tarball=${join(jobs, packed)}`)
  }

  const before = subject === 'oracle' ? undefined : await probe(model, apiKey)
  const plan: RunPlan = {
    id,
    createdAt,
    producer,
    subject,
    attempts,
    agentTimeoutMultiplier: multiplier,
    concurrency,
    model: { provider, model, ...(before === undefined ? {} : { before }) },
    suite: { commit: suiteCommit, tasks },
    names: Object.fromEntries(idOf),
  }
  const jobDir = join(jobs, id)
  writeFileSync(planPath(jobDir), `${JSON.stringify(plan, null, 2)}\n`)
  console.log(`harbor ${harborArgs.join(' ')}`)
  console.log(`an interrupted run continues with: npm run bench -- resume ${jobDir}`)
  return harborThenRecord(plan, jobDir, values.harbor, harborArgs, records, apiKey)
}

/**
 * What a run decided before Harbor started, written beside the job directory
 * so `resume` can continue an interrupted run into the same record.
 */
const runPlanSchema = z.strictObject({
  id: z.string(),
  createdAt: z.string(),
  producer: recordSchema.shape.producer,
  subject: z.enum(SUBJECTS),
  attempts: z.number().int().min(1),
  agentTimeoutMultiplier: z.number().positive(),
  concurrency: z.number().int().min(1),
  model: z.strictObject({ provider: z.string(), model: z.string(), before: recordSchema.shape.model.shape.before }),
  suite: z.strictObject({ commit: z.string(), tasks: recordSchema.shape.suite.shape.tasks }),
  /** Harbor names a trial's task by its `task.toml` name; a record by its directory. */
  names: z.record(z.string(), z.string()),
})
type RunPlan = z.infer<typeof runPlanSchema>

const planPath = (jobDir: string): string => `${jobDir}.plan.json`

/** Run Harbor (a new job or a resumed one), then write the record of every trial the job holds. */
async function harborThenRecord(plan: RunPlan, jobDir: string, harborBin: string, harborArgs: string[], records: string, apiKey: string): Promise<number> {
  const harbor = spawnSync(harborBin, harborArgs, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, PYTHONPATH: REPO_ROOT } })
  if (harbor.error !== undefined) throw harbor.error
  if (!existsSync(jobDir)) throw new Error(`harbor exited ${String(harbor.status)} without a job directory`)
  const after = plan.subject === 'oracle' ? undefined : await probe(plan.model.model, apiKey)

  const recordDir = join(records, 'records', plan.id)
  const trials = readdirSync(jobDir).filter(name => existsSync(join(jobDir, name, 'result.json')) && statSync(join(jobDir, name)).isDirectory())
    .map(name => ({ dir: join(jobDir, name), result: readTrial(join(jobDir, name)) }))
    .sort((a, b) => (a.result.started_at ?? '').localeCompare(b.result.started_at ?? ''))
  if (trials.length === 0) throw new Error(`harbor exited ${String(harbor.status)} before any trial; no record is written`)
  const counter = new Map<string, number>()
  const recorded: Attempt[] = trials.map(({ dir, result }) => {
    const parsed = attemptOf(result)
    const task = plan.names[parsed.task] ?? parsed.task
    const attempt = (counter.get(task) ?? 0) + 1
    counter.set(task, attempt)
    return { ...parsed, task, attempt, artifacts: keepArtifacts(dir, recordDir, parsed.trial) }
  })

  const { subject, attempts } = plan
  const tasks = plan.suite.tasks
  const agentRuntime = (JSON.parse(readFileSync(join(REPO_ROOT, 'container', 'agent-runtime', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@deepseek-ai/dsh'] ?? ''
  const record: BenchmarkRecord = recordSchema.parse({
    schema: RECORD_SCHEMA,
    id: plan.id,
    createdAt: plan.createdAt,
    producer: plan.producer,
    subject: {
      id: subject,
      agentRuntime: subject === 'oracle' ? 'none' : agentRuntime,
      ...(subject.endsWith('+skills') ? { skills: { commit: plan.suite.commit, names: [...UPGRADE_SKILLS] } } : {}),
      attempts,
      agentTimeoutMultiplier: plan.agentTimeoutMultiplier,
    },
    suite: { repository: SUITE_REPOSITORY, commit: plan.suite.commit, tasks },
    model: subject === 'oracle' ? { provider: 'none', model: 'none' } : { ...plan.model, ...(after === undefined ? {} : { after }) },
    environment: {
      harbor: execFileSync(harborBin, ['--version'], { encoding: 'utf8' }).trim(),
      docker: execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).trim(),
      os: `${type()} ${release()}`,
      concurrency: plan.concurrency,
    },
    attempts: recorded,
    metrics: computeMetrics({ tasks, attempts: recorded, k: attempts }),
  })
  mkdirSync(recordDir, { recursive: true })
  writeFileSync(join(recordDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
  console.log(`wrote ${relative(REPO_ROOT, join(recordDir, 'record.json'))}`)
  for (const [metric, value] of Object.entries(record.metrics.values)) console.log(`  ${metric}: ${value === null ? '—' : String(value)}`)
  const expected = tasks.filter(task => task.applicable && task.feasible).length * attempts
  if (recorded.length < expected) {
    console.error(`${String(expected - recorded.length)} of ${String(expected)} trials did not finish; continue with: npm run bench -- resume ${jobDir}`)
    return 1
  }
  if (subject !== 'oracle') return 0
  // An oracle run exists to say which tasks this environment can judge.
  const infeasible = tasks.filter(task => recorded.some(attempt => attempt.task === task.id && attempt.reward !== 1)).map(task => task.id)
  if (infeasible.length > 0) console.error(`the reference solution did not score 1.0 here, so these tasks are infeasible: ${infeasible.join(', ')}`)
  return infeasible.length === 0 ? 0 : 1
}

/**
 * Continue an interrupted run: Harbor resumes the job, keeping the trials that
 * finished, and the record is written as the original run would have written it.
 */
async function resume(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      harbor: { type: 'string', default: process.env.HARBOR_BIN ?? 'harbor' },
      records: { type: 'string', default: RECORDS_DIR },
    },
  })
  const jobDir = positionals[0]
  if (jobDir === undefined || !existsSync(planPath(jobDir))) throw new Error('resume needs the job directory a run printed, with its plan beside it')
  const plan = runPlanSchema.parse(JSON.parse(readFileSync(planPath(jobDir), 'utf8')))
  // The record names one producer commit; trials from different code would mix two subjects.
  if (git(['rev-parse', 'HEAD']) !== plan.producer.commit) throw new Error(`the run was started at ${plan.producer.commit}; check that commit out to resume it`)
  const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
  if (plan.subject !== 'oracle' && apiKey === '') throw new Error('DEEPSEEK_API_KEY is not set')
  return harborThenRecord(plan, jobDir, values.harbor, ['job', 'resume', '-p', jobDir], values.records, apiKey)
}

function compareRecords(argv: string[]): number {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { records: { type: 'string', default: RECORDS_DIR } } })
  const [baseId, headId] = positionals
  if (baseId === undefined || headId === undefined) throw new Error('compare needs a base and a head record id')
  const [base, head] = [baseId, headId].map(id => readRecord(recordPath(values.records, id))) as [BenchmarkRecord, BenchmarkRecord]
  const input = (record: BenchmarkRecord): Parameters<typeof compare>[0] => ({ tasks: record.suite.tasks, attempts: record.attempts, k: record.subject.attempts })
  console.log(`${base.subject.id} @ ${base.producer.commit.slice(0, 12)} → ${head.subject.id} @ ${head.producer.commit.slice(0, 12)}`)
  if (base.suite.commit !== head.suite.commit) console.log(`suite commits differ: ${base.suite.commit.slice(0, 12)} → ${head.suite.commit.slice(0, 12)}; only tasks in both are paired`)
  let regressed = false
  for (const row of compare(input(base), input(head))) {
    const interval = row.interval === undefined ? '' : ` [${row.interval.join(', ')}]`
    console.log(`  ${row.metric}: ${row.delta === null ? '—' : String(row.delta)}${interval} over ${String(row.tasks)} tasks: ${row.verdict}`)
    regressed ||= row.verdict === 'regression'
  }
  return regressed ? 1 : 0
}

/** Every record parses, its metrics recompute to the stored values, and its artifacts match their hashes. */
export function validateRecords(records: string): string[] {
  const problems: string[] = []
  const dir = join(records, 'records')
  for (const id of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const path = recordPath(records, id)
    let record: BenchmarkRecord
    try {
      record = readRecord(path)
    } catch (error) {
      problems.push(`${id}: ${(error as Error).message}`)
      continue
    }
    if (record.id !== id) problems.push(`${id}: the record names itself ${record.id}`)
    problems.push(...checkSnapshot(records, record.producer.snapshot).map(problem => `${id}: ${problem}`))
    const metrics = computeMetrics({ tasks: record.suite.tasks, attempts: record.attempts, k: record.subject.attempts })
    if (!isDeepStrictEqual(metrics, record.metrics)) problems.push(`${id}: the stored metrics differ from the metrics its attempts compute to`)
    for (const attempt of record.attempts) {
      for (const artifact of Object.values(attempt.artifacts)) {
        const file = join(records, 'records', id, artifact.path)
        if (!existsSync(file) || sha256(file) !== artifact.sha256) problems.push(`${id}: ${artifact.path} is missing or changed`)
      }
    }
  }
  return problems
}

/**
 * Commit the new records and snapshots in the records worktree. Pushing them
 * publishes them, so that is left to the maintainer, and printed.
 */
function publish(argv: string[]): number {
  const records = argv[0] ?? RECORDS_DIR
  const problems = validateRecords(records)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) return 1
  git(['add', 'records', 'snapshots'], records)
  const added = git(['diff', '--cached', '--name-only', '--diff-filter=A'], records).split('\n').filter(path => path.endsWith('/record.json'))
  if (git(['diff', '--cached', '--name-only'], records) === '') {
    console.log('nothing to publish')
    return 0
  }
  const lines = added.map((path) => {
    const record = readRecord(join(records, path))
    return `- ${record.id}: ${record.subject.id}, meanReward ${String(record.metrics.values.meanReward)} over ${String(record.metrics.values.eligibleTasks)} task(s) at "${record.producer.message}"`
  })
  git(['commit', '--quiet', '-m', `chore(bench): record ${String(added.length)} run(s)`, '-m', lines.join('\n')], records)
  console.log(`committed in ${records}:\n${lines.join('\n')}\npublish with:\n  git -C ${records} push origin bench/records\n  gh workflow run bench-records.yml`)
  return 0
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'run') return run(rest)
  if (command === 'resume') return resume(rest)
  if (command === 'publish') return publish(rest)
  if (command === 'compare') return compareRecords(rest)
  if (command === 'validate') {
    const problems = validateRecords(rest[0] ?? RECORDS_DIR)
    for (const problem of problems) console.error(problem)
    return problems.length === 0 ? 0 : 1
  }
  console.error('usage: npm run bench -- run|resume|compare|validate|publish …')
  return 2
}

if (process.argv[1] === import.meta.filename) {
  main().then((code) => { process.exitCode = code }, (error: unknown) => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}
