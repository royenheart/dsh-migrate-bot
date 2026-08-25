import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { join } from 'node:path'

const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
const SPARSE_PATHS = ['packages', 'docs', '.agents'] as const
const TAG_FILE = '.dsh-migrate-tag'

export interface HarnessCheckout {
  ok: boolean
  path: string
  detail?: string
}

export type GitRunner = (args: readonly string[], cwd?: string) => SpawnSyncReturns<string>

function defaultGit(args: readonly string[], cwd?: string): SpawnSyncReturns<string> {
  return spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    encoding: 'utf8',
  })
}

function fail(path: string, detail: string): HarnessCheckout {
  return { ok: false, path, detail }
}

/**
 * Shallow sparse checkout of one dsh-v* tag. History and unused trees stay out.
 */
export function checkoutHarness(options: {
  tag: string
  dest: string
  git?: GitRunner | undefined
}): HarnessCheckout {
  const git = options.git ?? defaultGit
  const dest = options.dest
  mkdirSync(dest, { recursive: true })

  const recorded = existsSync(join(dest, TAG_FILE))
    ? readFileSync(join(dest, TAG_FILE), 'utf8').trim()
    : ''
  const hasGit = existsSync(join(dest, '.git'))

  if (hasGit && recorded === options.tag) {
    return { ok: true, path: dest }
  }

  if (!hasGit) {
    const cloned = git([
      'clone',
      '--depth', '1',
      '--branch', options.tag,
      '--filter=blob:none',
      '--sparse',
      HARNESS_REPO,
      dest,
    ])
    if (cloned.status !== 0) {
      return fail(dest, cloned.stderr.trim() || cloned.stdout.trim() || `git clone failed (${cloned.status})`)
    }
  } else {
    const fetched = git(['fetch', '--depth', '1', 'origin', `refs/tags/${options.tag}:refs/tags/${options.tag}`], dest)
    if (fetched.status !== 0) {
      const alt = git(['fetch', '--depth', '1', 'origin', options.tag], dest)
      if (alt.status !== 0) {
        return fail(dest, alt.stderr.trim() || fetched.stderr.trim() || 'git fetch failed')
      }
    }
    const checked = git(['checkout', '--force', options.tag], dest)
    if (checked.status !== 0) {
      return fail(dest, checked.stderr.trim() || `git checkout ${options.tag} failed`)
    }
  }

  const sparse = git(['sparse-checkout', 'set', ...SPARSE_PATHS], dest)
  if (sparse.status !== 0) {
    return fail(dest, sparse.stderr.trim() || 'git sparse-checkout failed')
  }

  writeFileSync(join(dest, TAG_FILE), `${options.tag}\n`, 'utf8')
  return { ok: true, path: dest }
}
