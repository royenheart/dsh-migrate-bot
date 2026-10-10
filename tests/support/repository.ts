import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** A plugin checkout with a bare `origin`, as `actions/checkout` leaves one. */
export interface Checkout {
  work: string
  remote: string
  git: (args: string[], cwd?: string) => string
  /** A second clone of the same remote, for a concurrent writer. */
  clone: () => string
  cleanup: () => void
}

export function checkout(files: Record<string, string> = { 'package.json': '{"name":"@acme/plugin","version":"1.0.0"}\n' }): Checkout {
  const root = mkdtempSync(join(tmpdir(), 'dsh-checkout-'))
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  const git = (args: string[], cwd = work): string => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=test', '-c', 'user.email=test@example.test', ...args], { cwd, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], root)
  git(['clone', '--quiet', remote, work], root)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(work, name), content)
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'init'])
  git(['push', '--quiet', 'origin', 'HEAD:main'])
  let clones = 0
  return {
    work,
    remote,
    git,
    clone: () => {
      clones += 1
      const path = join(root, `clone-${String(clones)}`)
      git(['clone', '--quiet', remote, path], root)
      return path
    },
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}
