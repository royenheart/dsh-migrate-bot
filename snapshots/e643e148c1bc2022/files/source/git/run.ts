import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

/**
 * The one way this Action runs git.
 *
 * `safe.directory=*` because the checkout belongs to another user inside the
 * container, and `commit.gpgsign=false` because a commit made here is never
 * signed with a consumer's key.
 */

const SAFE = ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false'] as const

/** The identity of every commit this Action makes. */
export const BOT_NAME = 'dsh-migrate[bot]'
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

export interface GitOptions {
  cwd: string
  input?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}

/** Run git and return its result, whatever the exit status. */
export function git(args: readonly string[], options: GitOptions): SpawnSyncReturns<string> {
  return spawnSync('git', [...SAFE, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
}

/** Run git and return its trimmed stdout, or throw with its stderr. */
export function gitOut(args: readonly string[], options: GitOptions): string {
  const result = git(args, options)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${String(result.status)}): ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/** The environment with the bot as author and committer. */
export function botEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
  }
}
