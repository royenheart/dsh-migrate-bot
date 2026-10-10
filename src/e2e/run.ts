import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { parseIndex, type E2EIndex } from './branch.ts'
import { join } from 'node:path'

/**
 * Run the agent-authored suite against the migrated tree.
 *
 * The suite lives on its own branch, so it is materialized into a scratch
 * worktree and the plugin's current (dirty, migrated) files are overlaid on top
 * of it. That keeps the migration worktree untouched — the proposal never
 * carries test assets — while still exercising the code this run produced.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-migrate', 'dist', '.next', 'coverage'])

export interface E2ECommandResult {
  code: number | null
  output: string
  timedOut: boolean
}

export interface E2ECommandRunner {
  (command: string, options: { cwd: string; timeoutMs: number }): E2ECommandResult
}

export interface E2ERunInput {
  /** Plugin working tree holding the migrated code. */
  workdir: string
  /** Suite branch. */
  branch: string
  mode: 'subset' | 'full'
  /** Test paths or titles that failed last round; used by subset mode. */
  failing?: readonly string[]
  /** Scratch location for the suite worktree. */
  worktreeDir: string
  timeoutMs: number
  runCommand?: E2ECommandRunner | undefined
}

/** Read the suite index out of a materialized worktree. */
function readE2EIndex(path: string): E2EIndex | undefined {
  if (!existsSync(path)) return undefined
  try {
    return parseIndex(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

export interface E2ERunResult {
  ok: boolean
  signature: string
  detail: string
  /** Present when the suite could not run at all. */
  skipped?: string
  /** Best-effort list of failing test identifiers, for the next subset round. */
  failedTests: string[]
}

function git(args: readonly string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8' })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

function defaultRunner(command: string, options: { cwd: string; timeoutMs: number }): E2ECommandResult {
  const result = spawnSync(command, {
    cwd: options.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    env: { ...process.env, CI: '1', DSH_MIGRATE_E2E: '1' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  return { code: result.status, output, timedOut }
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else if (entry.isFile()) cpSync(source, target)
  }
}

/** Choose the command the repository's own framework expects. */
export function e2eCommand(worktree: string, mode: 'subset' | 'full', failing: readonly string[]): string | undefined {
  const pkgPath = join(worktree, 'package.json')
  let script: string | undefined
  if (existsSync(pkgPath)) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const scripts = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts
      if (typeof scripts === 'object' && scripts !== null) {
        for (const key of ['test:e2e', 'e2e', 'test:e2e:ci']) {
          const value = (scripts as Record<string, unknown>)[key]
          if (typeof value === 'string') {
            script = `npm run ${key}`
            break
          }
        }
      }
    } catch {
      script = undefined
    }
  }
  const playwright = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']
    .some(file => existsSync(join(worktree, file)))
  const base = script ?? (playwright ? 'npx playwright test' : undefined)
  if (base === undefined) return undefined
  if (mode === 'full' || failing.length === 0) return base
  // Subset: only what failed last round, so a repair round costs seconds.
  const selector = failing.slice(0, 20).map(item => `-g ${JSON.stringify(item)}`).join(' ')
  return `${base} ${selector}`
}

/** Best-effort failing-test identifiers from Playwright/typical runner output. */
export function parseFailedTests(output: string): string[] {
  const found = new Set<string>()
  for (const line of output.split('\n')) {
    const playwright = line.match(/^\s*(?:✘|×|✗)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?\s*$/)
    if (playwright?.[1] !== undefined) {
      // The list reporter prefixes the running index and the project name.
      found.add(playwright[1].replace(/^\d+\s+/, '').replace(/^\[[^\]]+\]\s*(?:›\s*)?/, '').trim())
      continue
    }
    const failing = line.match(/^\s*\d+\)\s+(.+?)\s*$/)
    if (failing?.[1] !== undefined) found.add(failing[1].trim())
  }
  return [...found].slice(0, 50)
}

/** Collapse runner noise so the same failure keeps the same signature. */
export function e2eSignature(output: string, failedTests: readonly string[], timedOut: boolean): string {
  if (timedOut) return 'e2e-timeout'
  if (failedTests.length > 0) return `e2e: ${[...failedTests].sort().join(' | ').slice(0, 300)}`
  const summary = output.split('\n').reverse().find(line => /\d+\s+(?:failed|passed)/i.test(line))
  return `e2e: ${(summary ?? output.trim().split('\n').slice(-1)[0] ?? 'unknown').trim().slice(0, 300)}`
}

/**
 * Materialize the suite branch, overlay the migrated tree, and run the suite.
 * @param input - workdir, branch, mode, scratch worktree, injectable runner
 */
export function runE2E(input: E2ERunInput): E2ERunResult {
  git(['fetch', 'origin', `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`], input.workdir)
  const remote = git(['rev-parse', '--verify', `refs/remotes/origin/${input.branch}`], input.workdir)
  if (!remote.ok) {
    return {
      ok: true,
      signature: 'e2e: no suite yet',
      detail: '',
      skipped: `no ${input.branch} branch yet (the suite is authored after the first successful migration)`,
      failedTests: [],
    }
  }

  rmSync(input.worktreeDir, { recursive: true, force: true })
  mkdirSync(input.worktreeDir, { recursive: true })
  const add = git(['worktree', 'add', '--force', '--detach', input.worktreeDir, `origin/${input.branch}`], input.workdir)
  if (!add.ok) {
    return {
      ok: true,
      signature: 'e2e: worktree unavailable',
      detail: add.out,
      skipped: 'could not materialize the suite branch',
      failedTests: [],
    }
  }

  try {
    copyTree(input.workdir, input.worktreeDir)
    // The overlay brings the migrated plugin onto the suite branch, but it also
    // overwrites suite-owned files such as package.json. Restore exactly those.
    const index = readE2EIndex(join(input.worktreeDir, 'index.json'))
    if (index?.files !== undefined && index.files.length > 0) {
      git(['checkout', 'HEAD', '--', ...index.files], input.worktreeDir)
    }
    const command = e2eCommand(input.worktreeDir, input.mode, input.failing ?? [])
    if (command === undefined) {
      return {
        ok: true,
        signature: 'e2e: no runnable command',
        detail: '',
        skipped: 'the suite branch has no e2e script and no playwright config',
        failedTests: [],
      }
    }

    const runner = input.runCommand ?? defaultRunner
    const result = runner(command, { cwd: input.worktreeDir, timeoutMs: input.timeoutMs })
    const failedTests = parseFailedTests(result.output)
    const detail = `$ ${command}\n${result.output.slice(-6000)}`
    if (!result.timedOut && result.code === 0 && failedTests.length === 0) {
      return { ok: true, signature: 'e2e: pass', detail, failedTests: [] }
    }
    return {
      ok: false,
      signature: e2eSignature(result.output, failedTests, result.timedOut),
      detail,
      failedTests,
    }
  } finally {
    git(['worktree', 'remove', '--force', input.worktreeDir], input.workdir)
    rmSync(input.worktreeDir, { recursive: true, force: true })
  }
}
