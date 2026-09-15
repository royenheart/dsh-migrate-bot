/**
 * Generate the README benchmark block from the records under `reports/upstream/`.
 *
 * The README used to state measured rewards as prose, which meant every new
 * benchmark run left the numbers stale until somebody remembered to edit them,
 * and nothing caught it when they did not. The figures now live in one place —
 * the report records the runs write — and this script projects them into the
 * README between two markers.
 *
 *   node dist/scripts/sync-readme-benchmark.js           # rewrite the block
 *   node dist/scripts/sync-readme-benchmark.js --check   # fail if it is stale
 *
 * `--check` is what CI runs, so a benchmark run that is not reflected in the
 * README fails the build instead of drifting.
 */

import { resolve } from 'node:path'
import { readText, REPO_ROOT, repoFiles } from './repo.ts'
import { writeFileSync } from 'node:fs'

/** Marker opening the generated region in the README. */
export const BLOCK_START = '<!-- benchmark:start -->'
/** Marker closing the generated region in the README. */
export const BLOCK_END = '<!-- benchmark:end -->'

/** The README path the block is rendered into. */
export const README_PATH = resolve(REPO_ROOT, 'README.md')

/** One attempt at a task, inside a record. */
export interface RecordAttempt {
  reward: number | null
  exception: string | null
  durationSeconds: number | null
  usage: { n_input_tokens?: number | null; n_cache_tokens?: number | null; n_output_tokens?: number | null } | null
}

/** One task's outcome inside a record. */
export interface RecordTask {
  id: string
  /** The median over the task's attempts; null when none scored. */
  reward: number | null
  rewardMin?: number | null
  rewardMax?: number | null
  exception: string | null
  durationSeconds?: number | null
  attempts?: RecordAttempt[]
  usage: unknown
}

/** The model build that served a run, as the probe recorded it. */
export interface RecordModelIdentity {
  requestedModel?: string | null
  servedModel?: string | null
  systemFingerprint?: string | null
  probedAt?: string | null
  error?: string | null
}

/** One benchmark or oracle record, as written by `tools/harbor/summarize.py`. */
export interface BenchmarkRecord {
  schema: number
  kind: string
  generatedAt: string
  producer: { commit: string | null; dirty: boolean }
  upstream: { repository: string; commit: string }
  agent: { name: string; version?: string; versions?: string[]; model?: string; task?: string; modelsObserved?: string[] }
  /** The migration mode under test; absent in schema 1. */
  mode?: { id?: string; runner?: string | null; profile?: string | null; skills?: { commit?: string | null; loaded?: string[] } }
  modelIdentity?: RecordModelIdentity | null
  runsPerTask?: number
  tasks: RecordTask[]
  summary: {
    tasks: number
    scored: number
    mean: number | null
    exceptions: number
    attempts?: number
    usage?: { inputTokens?: number; cacheHitTokens?: number; outputTokens?: number; attemptsReportingUsage?: number }
    cost?: { usd?: number | null; status?: string; model?: string | null; tableFetchedAt?: string; tableAgeDays?: number | null }
  }
  /** The file this record was read from, attached on load. */
  file?: string
}

/**
 * Load every report record under `reports/upstream/`.
 * @returns the parsed records, or an empty list when there are none.
 */
export function loadRecords(): BenchmarkRecord[] {
  const files = repoFiles(['.json'], resolve(REPO_ROOT, 'reports'))
  const records: BenchmarkRecord[] = []
  for (const file of files) {
    const parsed: unknown = JSON.parse(readText(file))
    if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed && 'tasks' in parsed) {
      records.push({ ...(parsed as BenchmarkRecord), file: file.slice(file.lastIndexOf('/') + 1) })
    }
  }
  return records
}

/**
 * Pick the most recent record of one kind.
 * @param records - candidate records.
 * @param kind - the `kind` field to match.
 * @returns the newest match, or `undefined` when none exists.
 */
export function latestOf(records: readonly BenchmarkRecord[], kind: string): BenchmarkRecord | undefined {
  return records
    .filter(record => record.kind === kind)
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
    .at(-1)
}

/** The migration mode a record describes, defaulting for schema-1 records. */
export function modeOf(record: BenchmarkRecord): string {
  return record.mode?.id ?? 'native'
}

/**
 * The newest record of one kind for each migration mode.
 *
 * Modes are different subjects — one migrates from the harness source alone and
 * one loads the community skills — so the table renders one section per mode
 * rather than averaging them into a single mean.
 * @param records - every record found on disk.
 * @param kind - the `kind` field to match.
 * @returns one record per mode, newest first by mode name.
 */
export function latestPerMode(records: readonly BenchmarkRecord[], kind: string): BenchmarkRecord[] {
  const newest = new Map<string, BenchmarkRecord>()
  for (const record of records.filter(entry => entry.kind === kind)) {
    const mode = modeOf(record)
    const current = newest.get(mode)
    if (current === undefined || current.generatedAt.localeCompare(record.generatedAt) < 0) {
      newest.set(mode, record)
    }
  }
  return [...newest.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(entry => entry[1])
}

/** A number of tokens, abbreviated for a table cell. */
function tokens(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

/** Format a reward, or an em dash when the task produced no score. */
function rewardCell(value: number | null): string {
  return value === null ? '—' : `**${value.toFixed(3)}**`
}

/** Format a duration in whole seconds, or an em dash when it is unknown. */
function durationCell(value: number | null): string {
  return value === null ? '—' : `${String(Math.round(value))}s`
}

/**
 * Shorten a 40-character commit to the 7 characters a reader can scan.
 * @param sha - a full commit id.
 * @returns the abbreviated id.
 */
function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * Render the README benchmark block from the newest records.
 *
 * Returns `undefined` when no benchmark record exists yet, so the caller can
 * leave a placeholder in place rather than publishing an empty table.
 * @param records - every report record found on disk.
 * @returns the block text, markers included.
 */
export function renderBenchmarkBlock(records: readonly BenchmarkRecord[]): string | undefined {
  const benchmarks = latestPerMode(records, 'upstream-benchmark')
  if (benchmarks.length === 0) return undefined
  const oracle = latestOf(records, 'oracle-selfcheck')

  const lines: string[] = [
    BLOCK_START,
    '<!-- Generated by scripts/sync-readme-benchmark.ts from reports/upstream/. Do not edit by hand. -->',
  ]

  for (const benchmark of benchmarks) {
    const mode = modeOf(benchmark)
    const identity = benchmark.modelIdentity ?? undefined
    const skills = benchmark.mode?.skills
    const summary = benchmark.summary
    const usage = summary.usage
    const cost = summary.cost
    lines.push(
      '',
      `### \`${mode}\` migration`,
      '',
      '| Scored | Attempts | Mean reward | Full score | Cache-miss in | Cache-hit in | Out | Cost |',
      '|---|---|---|---|---|---|---|---|',
      `| ${String(summary.scored)}/${String(summary.tasks)} | `
        + `${summary.attempts === undefined ? String(benchmark.tasks.length) : `${String(summary.attempts)} (${String(benchmark.runsPerTask ?? 1)}/task)`} | `
        + `${summary.mean === null ? '—' : `**${summary.mean.toFixed(3)}**`} | `
        + `${String(benchmark.tasks.filter(task => task.reward === 1).length)} | ${tokens(usage?.inputTokens)} | `
        + `${tokens(usage?.cacheHitTokens)} | ${tokens(usage?.outputTokens)} | `
        + `${cost?.usd === undefined || cost.usd === null ? `— (${String(cost?.status ?? 'unknown')})` : `$${cost.usd.toFixed(2)}`} |`,
      '',
      `Upstream \`${shortSha(benchmark.upstream.commit)}\`, dsh \`${(benchmark.agent.versions ?? [benchmark.agent.version]).filter(Boolean).join(', ') || 'unknown'}\`, `
        + `${String(benchmark.runsPerTask ?? 1)} attempt(s) per task`
        + `${skills === undefined || (skills.loaded ?? []).length === 0 ? '' : `, with ${String((skills.loaded ?? []).length)} community skills at \`${shortSha(skills.commit ?? '')}\``}. `
        + `Served by ${identity?.servedModel === undefined || identity?.servedModel === null ? 'an unidentified model' : `\`${identity.servedModel}\``}`
        + `${identity?.systemFingerprint === undefined || identity?.systemFingerprint === null ? '' : `, fingerprint \`${identity.systemFingerprint}\``}`
        + `${identity?.error === undefined || identity?.error === null ? '' : ` (${identity.error})`}.`,
      '',
      `Per-task rewards, ranges and token counts: [\`${recordName(benchmark)}\`](reports/upstream/${recordName(benchmark)}).`,
    )
  }

  if (oracle !== undefined) {
    const arms = oracle.tasks
      .map(task => `\`${task.id}\` ${task.reward === null ? '—' : task.reward.toFixed(3)}`)
      .join(', ')
    lines.push('', `Oracle self-check (reference solution, no API key): ${arms}.`)
  }

  lines.push(
    '',
    'Cite the section for the mode you mean: the two modes are different subjects and their means are not comparable.',
    BLOCK_END,
  )
  return lines.join('\n')
}

/**
 * Derive a record's filename from its timestamp, matching `summarize.py`.
 * @param record - a benchmark record.
 * @returns the file name under `reports/upstream/`.
 */
function recordName(record: BenchmarkRecord): string {
  if (record.file !== undefined) return record.file
  const stamp = record.generatedAt.replace(/[:]/g, '').replace(/[-]/g, '')
  return `${stamp}.json`
}

/**
 * Replace the marker-delimited region of a README with a rendered block.
 * @param readme - the README's current text.
 * @param block - the rendered block, markers included.
 * @returns the updated text.
 * @throws when either marker is missing or they are out of order.
 */
export function replaceBlock(readme: string, block: string): string {
  const start = readme.indexOf(BLOCK_START)
  const end = readme.indexOf(BLOCK_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md must contain ${BLOCK_START} before ${BLOCK_END}`)
  }
  return readme.slice(0, start) + block + readme.slice(end + BLOCK_END.length)
}

/**
 * Bring the README's benchmark block up to date, or report that it is stale.
 * @param check - when true, do not write; report a stale block as a failure.
 * @returns whether the README changed, and the current block text.
 */
export function syncReadme(check: boolean): { changed: boolean; block: string } {
  const block = renderBenchmarkBlock(loadRecords())
  if (block === undefined) {
    throw new Error('no upstream-benchmark record found under reports/upstream/')
  }
  const readme = readText(README_PATH)
  const updated = replaceBlock(readme, block)
  const changed = updated !== readme
  if (changed && !check) writeFileSync(README_PATH, updated, 'utf8')
  return { changed, block }
}

if (import.meta.filename === process.argv[1]) {
  const check = process.argv.includes('--check')
  const { changed } = syncReadme(check)
  if (!changed) {
    console.log('sync-readme-benchmark: README benchmark block is up to date.')
    process.exit(0)
  }
  if (check) {
    console.error('sync-readme-benchmark: README benchmark block is stale; run `npm run sync:readme`.')
    process.exit(1)
  }
  console.log('sync-readme-benchmark: README benchmark block updated.')
}
