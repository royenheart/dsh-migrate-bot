import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from './spawn.ts'

/**
 * The git side of a preview: the working copy and the frozen diff.
 *
 * A working copy is a plain directory holding the pull request head. Its git
 * directory lives beside it, never inside it: the working copy is mounted into
 * containers that run the plugin's code, and a git directory there would let
 * that code write configuration (a filter, a hook path) that git then runs as
 * the service. Every command names both with `--git-dir` and `--work-tree`, so
 * git never discovers a repository from the tree, and the ownership check that
 * discovery performs does not apply.
 */

export interface GitResult {
  ok: boolean
  /** What git wrote to stdout, as bytes: a diff is not necessarily UTF-8. */
  stdout: Buffer
  detail: string
}

/** Where a working copy's files and its git directory are. */
export interface Tree {
  gitDir: string
  workTree: string
}

/** The most output one git command may write; a frozen diff is bounded far below this. */
const MAX_OUTPUT = 64 * 1024 * 1024
const TIMEOUT_MS = 10 * 60_000

/**
 * Run git on a tree without a terminal, hooks, signing or detached
 * maintenance: from git 2.54 a fetch or a commit starts a repack that would
 * still be writing into a candidate the manager renames or removes.
 * @param tree - the git directory and the work tree.
 * @param args - the git arguments.
 * @param env - extra environment.
 */
export async function git(tree: Tree, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', `--git-dir=${tree.gitDir}`, `--work-tree=${tree.workTree}`, ...args], {
    cwd: tree.workTree,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_OUTPUT,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'dsh-migrate deploy service',
      GIT_AUTHOR_EMAIL: 'deploy-service@localhost',
      GIT_COMMITTER_NAME: 'dsh-migrate deploy service',
      GIT_COMMITTER_EMAIL: 'deploy-service@localhost',
      ...env,
    },
  })
  const detail = result.error ?? (result.killed === undefined ? result.stderr.trim() || result.stdout.trim() : `killed (${result.killed})`)
  return { ok: result.code === 0, stdout: result.stdoutBytes, detail: detail === '' ? `git ${args[0] ?? ''} exited ${String(result.code)}` : detail.slice(0, 1000) }
}

/** Directories a dependency install creates, which are never part of a preview's change. */
const EXCLUDED = ['node_modules/', '.npm/']

/**
 * Check out one commit into a new tree.
 *
 * The commit is fetched by its id rather than by branch name, so what is built
 * is exactly the commit the pull request event named, even if the branch has
 * moved on since.
 * @param tree - the git directory and work tree to create; neither may exist.
 * @param cloneUrl - where the repository is fetched from.
 * @param sha - the commit to check out.
 */
export async function checkout(tree: Tree, cloneUrl: string, sha: string): Promise<GitResult> {
  mkdirSync(tree.workTree, { recursive: true })
  for (const step of [
    ['init', '--quiet'],
    ['fetch', '--quiet', '--no-tags', cloneUrl, sha],
    ['checkout', '--quiet', '--detach', sha],
  ]) {
    const result = await git(tree, step)
    if (!result.ok) return { ...result, detail: `git ${step[0] ?? ''}: ${result.detail}` }
  }
  mkdirSync(join(tree.gitDir, 'info'), { recursive: true })
  appendFileSync(join(tree.gitDir, 'info', 'exclude'), `${EXCLUDED.join('\n')}\n`)
  return { ok: true, stdout: Buffer.alloc(0), detail: `checked out ${sha.slice(0, 12)}` }
}

/**
 * Keep what a candidate's install and build created out of every later change.
 *
 * Run after the provider built the candidate: each untracked path the
 * repository does not ignore, such as build output, is added to the git
 * directory's exclude file, so a freeze counts only what was changed after the
 * build. Paths are handled as bytes, and a path an exclude file cannot name,
 * one holding a newline or ending in a carriage return, is left out and counts
 * as changed.
 * @param tree - the candidate.
 */
export async function excludeBuildOutput(tree: Tree): Promise<GitResult> {
  const listed = await git(tree, ['ls-files', '-z', '--others', '--exclude-standard', '--directory'])
  if (!listed.ok) return { ...listed, detail: `git ls-files: ${listed.detail}` }
  const paths = listed.stdout.toString('latin1').split('\0').filter(path => path !== '' && !path.includes('\n') && !path.endsWith('\r'))
  if (paths.length > 0) appendFileSync(join(tree.gitDir, 'info', 'exclude'), `${paths.map(path => `/${path.replace(/[\\*?[\] ]/g, '\\$&')}`).join('\n')}\n`, 'latin1')
  return { ok: true, stdout: Buffer.alloc(0), detail: `excluded ${String(paths.length)} path(s)` }
}

/**
 * The working copy's change against `baseSha`, as one binary-safe unified diff
 * in bytes.
 *
 * The tree is staged into a temporary index, never the tree's own, so untracked
 * files count and the tree is left exactly as it was. Ignored files do not
 * count, which keeps installed dependencies and, through `excludeBuildOutput`,
 * build output out of the change.
 * @param tree - the working copy.
 * @param baseSha - the commit the copy was built from.
 */
export async function freeze(tree: Tree, baseSha: string): Promise<{ ok: true; diff: Buffer } | { ok: false; detail: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-deploy-index-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }
    const read = await git(tree, ['read-tree', baseSha], env)
    if (!read.ok) return { ok: false, detail: `git read-tree: ${read.detail}` }
    const staged = await git(tree, ['add', '-A', '--', '.'], env)
    if (!staged.ok) return { ok: false, detail: `git add: ${staged.detail}` }
    const diff = await git(tree, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', baseSha], env)
    if (!diff.ok) return { ok: false, detail: `git diff: ${diff.detail}` }
    return { ok: true, diff: diff.stdout }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Apply a diff to a freshly checked-out tree with a three-way merge.
 * @param tree - the tree to apply to.
 * @param diff - what `freeze` produced from another tree.
 */
export async function carry(tree: Tree, diff: Buffer): Promise<GitResult> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deploy-carry-'))
  try {
    const file = join(dir, 'change.diff')
    appendFileSync(file, diff)
    // A build changes the files' owner and ctime, so the index no longer matches
    // them until it is refreshed, and `--3way` refuses a file it does not match.
    await git(tree, ['update-index', '-q', '--refresh'])
    return await git(tree, ['apply', '--3way', '--whitespace=nowarn', file])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
