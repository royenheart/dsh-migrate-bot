/**
 * Build the benchmark report: a static site from the records on
 * `bench/records` and the state branches of the consumer repositories.
 *
 *   npm run site -- [--records DIR] [--out DIR] [--field]
 *
 * The pages are `site/`; this script adds the data they read: `data/index.json`
 * (one summary per record, newest first), every record directory as it is, the
 * compiled metric library, and with `--field` `data/field.json`. Records that
 * do not validate are refused. docs/design/evaluation.md describes the report.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { maintainerCommits } from '../src/activities/proposal.ts'
import { fieldMetrics, fieldMigrations, type FieldMetrics, type FieldMigration } from '../src/evaluation/field.ts'
import { recordSchema } from '../src/evaluation/record.ts'
import { git } from '../src/git/run.ts'
import { GitHubClient, repositoryOf } from '../src/github/client.ts'
import { StateStore } from '../src/state/store.ts'
import { validateRecords } from './bench.ts'
import { REPO_ROOT } from './repo.ts'

/** The repositories that run the Action; the Field page reports their proposals. */
export const CONSUMERS = [
  'royenheart/dsh-plugin-mcp-support',
  'royenheart/dsh-plugin-opencode-omo',
  'royenheart/dsh-plugin-skills-manager',
  'royenheart/dsh-plugin-structured-output',
]

const PAGES = join(REPO_ROOT, 'site')
/** The compiled metric library, beside this compiled script. */
const METRICS_MODULE = join(import.meta.dirname, '..', 'src', 'evaluation', 'metrics.js')

export function buildSite(records: string, out: string): number {
  const problems = validateRecords(records)
  if (problems.length > 0) throw new Error(`records do not validate:\n${problems.join('\n')}`)
  rmSync(out, { recursive: true, force: true })
  cpSync(PAGES, out, { recursive: true })
  cpSync(METRICS_MODULE, join(out, 'assets', 'metrics.js'))
  const dir = join(records, 'records')
  const summaries = (existsSync(dir) ? readdirSync(dir) : []).map((id) => {
    cpSync(join(dir, id), join(out, 'data', 'records', id), { recursive: true })
    const record = recordSchema.parse(JSON.parse(readFileSync(join(dir, id, 'record.json'), 'utf8')))
    return { id, createdAt: record.createdAt, producer: record.producer, subject: record.subject, suite: record.suite, model: record.model, metrics: record.metrics }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  mkdirSync(join(out, 'data'), { recursive: true })
  writeFileSync(join(out, 'data', 'index.json'), JSON.stringify({ records: summaries }))
  return summaries.length
}

interface ConsumerField {
  repository: string
  migrations: FieldMigration[]
  metrics?: FieldMetrics
  error?: string
}

/** Read one consumer's state branch, and count the maintainer commits of its merged proposals when a token allows. */
async function consumerField(repository: string, github: GitHubClient | undefined): Promise<ConsumerField> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-migrate-field-'))
  try {
    git(['init', '--quiet'], { cwd: dir })
    git(['remote', 'add', 'origin', `https://github.com/${repository}.git`], { cwd: dir })
    // A repository that cannot be read is reported as such, not as one without migrations.
    if (git(['ls-remote', 'origin', 'HEAD'], { cwd: dir }).status !== 0) throw new Error('the repository could not be read')
    const migrations = fieldMigrations(repository, new StateStore(dir).read().logs)
    for (const migration of migrations) {
      if (github === undefined || migration.proposal?.closed?.merged !== true) continue
      migration.proposal.maintainerCommits = await maintainerCommits(github, repositoryOf(repository), migration.proposal.pullRequest)
    }
    return { repository, migrations, metrics: fieldMetrics(migrations) }
  } catch (error) {
    return { repository, migrations: [], error: (error as Error).message }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function collectField(env: NodeJS.ProcessEnv): Promise<unknown> {
  const token = env.GITHUB_TOKEN
  const github = token === undefined || token === '' ? undefined : new GitHubClient(token, env)
  const consumers = await Promise.all(CONSUMERS.map(repository => consumerField(repository, github)))
  return { generatedAt: new Date().toISOString(), consumers, metrics: fieldMetrics(consumers.flatMap(consumer => consumer.migrations)) }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      records: { type: 'string', default: join(REPO_ROOT, '.bench', 'records') },
      out: { type: 'string', default: join(REPO_ROOT, '.bench', 'site') },
      field: { type: 'boolean', default: false },
    },
  })
  const count = buildSite(values.records, values.out)
  if (values.field) writeFileSync(join(values.out, 'data', 'field.json'), JSON.stringify(await collectField(process.env)))
  console.log(`built ${values.out} from ${String(count)} record(s)${values.field ? ' and the consumer state branches' : ''}`)
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error: unknown) => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}
