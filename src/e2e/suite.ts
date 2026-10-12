import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import { botEnv, git, gitOut } from '../git/run.ts'
import { inline } from '../render/text.ts'

/**
 * The end-to-end suite: a self-contained Playwright project that drives the
 * plugins in a browser through a `dsh web` the Action serves. It never starts
 * dsh itself; it opens `DSH_MIGRATE_WEB_URL`. So the same tests run against
 * any release: on the source release before a migration they record what
 * the plugins do (the end-to-end baseline), and on the target release after
 * it they say what stopped working.
 *
 * The suite lives in `checks.e2e.dir` on its own branch, which holds nothing
 * else, so a proposal never carries test assets.
 */

/** The Playwright version of the image; the suite pins `@playwright/test` to it so the browser build matches. */
export const PLAYWRIGHT_VERSION = '1.61.1'
export const INDEX_FILE = 'index.json'
export const INDEX_MARKDOWN = 'INDEX.md'
/** Where a suite writes and installs what is never committed. */
const LOCAL = ['node_modules', 'test-results', 'playwright-report', 'blob-report']

const indexSchema = z.object({
  features: z.array(z.object({
    id: z.string().min(1),
    entry: z.string().describe('How a user reaches the feature.'),
    expect: z.string().describe('What must be true afterwards.'),
    test: z.string().describe('The spec file, relative to the suite.'),
  })),
})
export type SuiteIndex = z.infer<typeof indexSchema>

/** The coverage ledger the suite keeps beside its specs, or `undefined` when it is missing or malformed. */
export function readIndex(suiteDir: string): SuiteIndex | undefined {
  const path = join(suiteDir, INDEX_FILE)
  if (!existsSync(path)) return undefined
  try {
    const parsed = indexSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function renderIndexMarkdown(index: SuiteIndex, release: string): string {
  const cell = (text: string): string => inline(text, 200).replaceAll('|', '\\|')
  return `# End-to-end coverage

Each row is a user-visible feature of the plugins and the spec that exercises it. Written by dsh-migrate's agent; last checked against ${release}.

| Feature | Entry | Expected | Spec |
|---|---|---|---|
${index.features.map(feature => `| \`${cell(feature.id)}\` | ${cell(feature.entry)} | ${cell(feature.expect)} | \`${cell(feature.test)}\` |`).join('\n')}
`
}

function branchRef(workdir: string, branch: string): string | undefined {
  const remote = git(['remote', 'get-url', 'origin'], { cwd: workdir }).status === 0
  if (remote) git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: workdir })
  const ref = remote ? `refs/remotes/origin/${branch}` : `refs/heads/${branch}`
  const tip = git(['rev-parse', '--verify', '--quiet', ref], { cwd: workdir })
  return tip.status === 0 ? tip.stdout.trim() : undefined
}

/**
 * Copy the suite on its branch into `dest`.
 * @returns whether the branch holds a suite.
 */
export function readSuite(input: { workdir: string; branch: string; dir: string; dest: string }): boolean {
  const tip = branchRef(input.workdir, input.branch)
  if (tip === undefined || git(['rev-parse', '--verify', '--quiet', `${tip}:${input.dir}`], { cwd: input.workdir }).status !== 0) return false
  const index = join(mkdtempSync(join(tmpdir(), 'dsh-migrate-suite-')), 'index')
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index }
    gitOut(['read-tree', `${tip}:${input.dir}`], { cwd: input.workdir, env })
    mkdirSync(input.dest, { recursive: true })
    gitOut(['checkout-index', '--all', '--force', `--prefix=${input.dest}/`], { cwd: input.workdir, env })
    return true
  } finally {
    rmSync(join(index, '..'), { recursive: true, force: true })
  }
}

/**
 * Commit the suite in `suiteDir` as `dir/` on its branch and push it, or move
 * the local branch when the checkout has no remote. The branch holds the suite
 * and nothing else.
 */
export function publishSuite(input: { workdir: string; branch: string; dir: string; suiteDir: string; message: string }): { outcome: 'pushed' | 'unchanged' | 'failed'; detail: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-migrate-suite-'))
  try {
    const env = { ...botEnv(), GIT_INDEX_FILE: join(scratch, 'files') }
    // Excluded by a file, not a pathspec: git refuses a pathspec naming a path the checkout already ignores.
    writeFileSync(join(scratch, 'exclude'), LOCAL.map(path => `${path}/\n`).join(''))
    gitOut(['-c', `core.excludesFile=${join(scratch, 'exclude')}`, '--work-tree', input.suiteDir, 'add', '--all', '--', '.'], { cwd: input.workdir, env })
    const files = gitOut(['write-tree'], { cwd: input.workdir, env })
    const rootEnv = { ...env, GIT_INDEX_FILE: join(scratch, 'root') }
    gitOut(['read-tree', `--prefix=${input.dir}/`, files], { cwd: input.workdir, env: rootEnv })
    const tree = gitOut(['write-tree'], { cwd: input.workdir, env: rootEnv })
    const parent = branchRef(input.workdir, input.branch)
    if (parent !== undefined && gitOut(['rev-parse', `${parent}^{tree}`], { cwd: input.workdir }) === tree) return { outcome: 'unchanged', detail: '' }
    const commit = gitOut(['commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', input.message], { cwd: input.workdir, env })
    const remote = git(['remote', 'get-url', 'origin'], { cwd: input.workdir }).status === 0
    const moved = remote
      ? git(['push', '--quiet', 'origin', `${commit}:refs/heads/${input.branch}`], { cwd: input.workdir })
      : git(['update-ref', `refs/heads/${input.branch}`, commit], { cwd: input.workdir })
    return moved.status === 0 ? { outcome: 'pushed', detail: commit } : { outcome: 'failed', detail: inline(moved.stderr, 300) }
  } catch (error) {
    return { outcome: 'failed', detail: inline((error as Error).message, 300) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The part of Playwright's JSON report this reads: every test, by its title path, and its outcome. */
interface ReportSuite {
  title?: string
  specs?: Array<{ title: string; tests: Array<{ status: string; results?: Array<{ error?: { message?: string } }> }> }>
  suites?: ReportSuite[]
}

export interface SuiteReport {
  /** Test ids, `file › describe › title`. */
  passed: string[]
  failed: string[]
  /** The first error of each failed test that reported one. */
  errors: Record<string, string>
}

/** The tests of a Playwright JSON report by outcome. */
export function readReport(json: string): SuiteReport | undefined {
  let report: { suites?: ReportSuite[] }
  try {
    report = JSON.parse(json) as { suites?: ReportSuite[] }
  } catch {
    return undefined
  }
  if (!Array.isArray(report.suites)) return undefined
  const passed: string[] = []
  const failed: string[] = []
  const errors: Record<string, string> = {}
  const walk = (suite: ReportSuite, path: string[]): void => {
    const here = suite.title === undefined || suite.title === '' ? path : [...path, suite.title]
    for (const spec of suite.specs ?? []) {
      const id = [...here, spec.title].join(' › ')
      // `expected` passed (or was expected to fail); `skipped` says nothing; anything else failed.
      const statuses = spec.tests.map(test => test.status).filter(status => status !== 'skipped')
      if (statuses.length === 0) continue
      if (statuses.every(status => status === 'expected')) passed.push(id)
      else {
        failed.push(id)
        const message = spec.tests.flatMap(test => test.results ?? []).find(result => result.error?.message !== undefined)?.error?.message
        if (message !== undefined) errors[id] = inline(stripVTControlCharacters(message), 400)
      }
    }
    for (const child of suite.suites ?? []) walk(child, here)
  }
  for (const suite of report.suites) walk(suite, [])
  return { passed, failed, errors }
}

export interface SuiteRun extends SuiteReport {
  /** Why the suite could not run at all. */
  error?: string
  /** The tail of the runner's output, for a report and a repair session. */
  output: string
}

const NO_TESTS: SuiteReport = { passed: [], failed: [], errors: {} }

/**
 * Install the suite's dependencies when they are missing and run it against a
 * served `dsh web`.
 */
export function runSuite(input: { suiteDir: string; webUrl: string; timeoutMs: number }): SuiteRun {
  if (!existsSync(join(input.suiteDir, 'package.json'))) return { error: 'the suite has no package.json', ...NO_TESTS, output: '' }
  const run = (command: string, args: string[]): SpawnSyncReturns<string> => spawnSync(command, args, {
    cwd: input.suiteDir,
    encoding: 'utf8',
    timeout: input.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', DSH_MIGRATE_WEB_URL: input.webUrl },
  })
  if (!existsSync(join(input.suiteDir, 'node_modules'))) {
    const install = run('npm', ['install', '--no-audit', '--no-fund'])
    if (install.status !== 0) return { error: `npm install failed: ${inline(`${install.stdout}${install.stderr}`.slice(-800), 800)}`, ...NO_TESTS, output: '' }
  }
  const result = run('npx', ['playwright', 'test', '--reporter=json'])
  const output = `${result.stderr ?? ''}`.slice(-4000)
  if (result.error !== undefined && result.signal !== null) return { error: `the suite exceeded its ${String(Math.round(input.timeoutMs / 1000))}s watchdog`, ...NO_TESTS, output }
  const report = readReport(result.stdout ?? '')
  if (report === undefined) return { error: `the suite did not report: ${inline(output || (result.stdout ?? ''), 600)}`, ...NO_TESTS, output }
  return { ...report, output }
}

/** Write the ledger beside a suite whose index is valid. */
export function writeLedger(suiteDir: string, release: string): void {
  const index = readIndex(suiteDir)
  if (index !== undefined) writeFileSync(join(suiteDir, INDEX_MARKDOWN), renderIndexMarkdown(index, release))
}

/**
 * The brief of the session that writes or extends the suite. The session runs
 * while `DSH_MIGRATE_WEB_URL` serves the plugins, so it can run the suite as it
 * writes it.
 */
export function renderAuthoringBrief(input: { suiteDir: string; plugins: string; release: string; existing: boolean }): string {
  return `${input.existing ? 'Extend' : 'Write'} the end-to-end suite of these DeepSeek Harness plugins: ${input.plugins}.

The plugins are being served right now by \`dsh web\` on dsh ${input.release}, with no model key. Its launch URL, which carries the token a browser exchanges for a session, is in the environment variable DSH_MIGRATE_WEB_URL. The suite must open that URL and never start dsh itself, because the same suite is run against other dsh releases.

Work only in "${input.suiteDir}", which is the whole suite: a self-contained Playwright project with its own package.json (devDependencies: "@playwright/test": "${PLAYWRIGHT_VERSION}"), a playwright.config.ts using Chromium, and the specs. Do not write anywhere else; the plugins' own tree is under migration and must not change.

Also keep "${input.suiteDir}/${INDEX_FILE}": { "features": [ { "id", "entry", "expect", "test" } ] }, one row per user-visible feature of the plugins (from their READMEs and source), with how a user reaches it, what must be true afterwards, and the spec that checks it.

Rules:
- Cover what a user sees and does: every panel, menu, setting and command the plugins add.
- Reach each feature by the shortest path the plugin itself offers. The host's own UI (its settings dialog, plugin list, navigation) changes between releases, and a test that walks through it fails for reasons the plugin cannot fix; go through it only where the feature has no other entry, and assert on the plugin's part, not the host's.
- Assert on ARIA roles, accessible names and text; never on the host's own data-* attributes or class names, which change between releases.
- Never wait for network idle; poll until two consecutive reads agree. Add a console and pageerror tripwire to each spec.
- A feature that needs a model answer cannot complete here; check that it is offered and reachable, not its answer.
- Run the suite with \`npx playwright test\` in "${input.suiteDir}" until it passes. A test that cannot pass against this release is removed, not skipped: the suite records what works now.`
}
