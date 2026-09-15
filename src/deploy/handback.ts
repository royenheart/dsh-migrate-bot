/**
 * The Action's half of the publish hand-back.
 *
 * A deploy target has no write access to the pull request branch and never will:
 * it holds the user's code, the runner holds the credentials. So `publish` is a
 * request, and this is what fulfils it — fetch the frozen revision as a diff,
 * apply it to the pull request's head, run the same gate stack every other
 * change goes through, and push only if that passes. The contract is
 * [the publish hand-back]; this module is the runner's side of it.
 *
 * It owns git and nothing else. The gates arrive as a port, because that is what
 * makes this testable against a real repository without a harness install, and
 * because a publishing path deciding its own gates is how two paths start
 * disagreeing about what "verified" means.
 *
 * [the publish hand-back]: ../../docs/design/preview-and-live-view.md#81-the-publish-hand-back
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GateReport } from '../verify/gates.ts'
import { inline } from '../render/text.ts'

const GIT_SAFE = ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false'] as const
const BOT_NAME = 'dsh-migrate[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

export interface HandbackInput {
  /** The consumer's checkout, which is where the worktree is added from. */
  workdir: string
  /** Pull request head branch, the only ref this may write. */
  branch: string
  /** The commit the diff is applied to: the pull request head when frozen. */
  headSha: string
  /** The frozen revision, as the target named it. */
  revision: string
  /**
   * The commit the scratch tree was built from, as the target named it.
   *
   * Not used to decide anything: the diff is applied at `headSha`, and the case
   * where the two disagree is exactly the conflict the apply reports. Kept in
   * the input so the caller passes what it received rather than dropping it.
   */
  baseSha?: string | undefined
  /** The diff the target served for that revision. */
  diff: string
  repository: string
  pullRequest: number
  /** Where the temporary worktree goes. */
  treeDir: string
  /** The gate stack, injected: this module knows git, not how a plugin is verified. */
  runGates: (tree: string) => Promise<GateReport>
  log: (message: string) => void
  /** Injectable for tests; defaults to the process. */
  run?: GitRunner | undefined
}

export interface GitOutcome {
  ok: boolean
  stdout: string
  detail: string
}

export type GitRunner = (args: readonly string[], cwd: string, input?: string) => GitOutcome

export type HandbackResult =
  | {
    ok: true
    /** The commit that carries the change, whether this run pushed it or an earlier one did. */
    commit: string
    /** True when the branch already carried this revision, so nothing was pushed again. */
    alreadyPublished: boolean
    gates: GateReport
    detail: string
  }
  | {
    ok: false
    /**
     * Where it stopped, which is what a reader needs to know who fixes it.
     *
     * `error` is the one this function never returns: it is what the caller
     * reports when the hand-back itself threw, and it is in the same vocabulary
     * so a target can read one shape.
     */
    stage: 'remote' | 'base' | 'apply' | 'gates' | 'push' | 'error'
    detail: string
    gates?: GateReport
  }

/**
 * Whether the values a target sent can be used in git commands.
 *
 * Everything a target sends is somebody else's input, and a branch name or a
 * revision that starts with `-` is a git option rather than a value. The rules
 * are here so both the caller that reports and the function that runs agree on
 * what is acceptable.
 * @param input - the branch, the head commit, and the revision id.
 */
export function invalidPublishTarget(input: {
  branch: string
  headSha: string
  revision: string
}): string | undefined {
  return invalidBranch(input.branch) ?? invalidCommit(input.headSha) ?? invalidRevision(input.revision)
}

/** Why a branch name cannot be pushed to, if it cannot. */
export function invalidBranch(branch: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
    return `\`${branch}\` is not a branch name this Action will push to`
  }
  return undefined
}

/** Why a commit cannot be checked out, if it cannot. */
export function invalidCommit(headSha: string): string | undefined {
  if (!/^[0-9a-f]{7,40}$/i.test(headSha)) {
    return `\`${headSha}\` is not a commit this Action will check out`
  }
  return undefined
}

/**
 * Why a revision cannot be used, if it cannot.
 *
 * It is written into a commit message, into argv, into a log line, and into the
 * reply a human reads. A NUL cannot be passed to a process at all, a newline
 * forges a comment or a log line, and a backtick would let the target author the
 * account of what this Action did.
 */
export function invalidRevision(revision: string): string | undefined {
  if (!/^[\x20-\x7e]{1,200}$/.test(revision) || revision.includes('`')) {
    return 'the target named a revision that cannot be used in a commit message or a report'
  }
  return undefined
}

/**
 * The commit that carries this exact subject on the branch, if there is one.
 *
 * The log is read as records rather than grepped so the comparison is equality:
 * `--grep` matches anywhere in a commit message, and the revision inside the
 * subject is a string the target chose.
 * @param run - the git runner.
 * @param workdir - the checkout the branch ref is read from.
 * @param branch - the pull request branch.
 * @param subject - the exact subject a published revision carries.
 */
function alreadyPublishedCommit(
  run: GitRunner,
  workdir: string,
  branch: string,
  tip: string,
  subject: string,
): string | undefined {
  // A hundred commits of history is more than any branch this Action writes to
  // will accumulate between a publish and its retry.
  const log = run(['log', '--format=%H%x09%s', '-n', '100', tip], workdir)
  if (!log.ok) return undefined
  // Git prints the paths a commit touched relative to the repository root while
  // it reads a pathspec relative to the working directory, so the comparison
  // below runs from the root: a run whose `workdir` is a directory below it would
  // otherwise match nothing, exit 0, and call a reverted change still published.
  // It is resolved once, not once per candidate.
  const top = run(['rev-parse', '--show-toplevel'], workdir)
  const root = top.ok && top.stdout.trim() !== '' ? top.stdout.trim() : workdir
  for (const line of log.stdout.split('\n')) {
    const [commit, ...rest] = line.split('\t')
    if (commit === undefined || commit === '' || rest.join('\t') !== subject) continue
    if (stillOnBranch(run, root, commit, tip)) return commit
  }
  return undefined
}

/**
 * Whether the change a commit made is still the state of the branch.
 *
 * A commit whose subject says "publish rev-1" survives a `git revert`, and
 * answering "already published" then would leave a reverted change published
 * forever. The commit is an ancestor of the tip and the paths it touched are
 * identical between it and the tip — a later change anywhere else does not make
 * this false, and a revert of this change does.
 * @param run - the git runner.
 * @param root - the repository root the caller resolved.
 * @param commit - the commit that claims to carry the revision.
 * @param tip - the branch tip.
 */
function stillOnBranch(run: GitRunner, root: string, commit: string, tip: string): boolean {
  const ancestor = run(['merge-base', '--is-ancestor', commit, tip], root)
  if (!ancestor.ok) return false
  // `-z` is what makes the names usable: without it git quotes a path that is
  // not plain ASCII (`"caf\303\251.js"`), the quoted string matches no pathspec,
  // and `git diff --quiet` exits 0 for a change that is gone.
  const paths = run(['show', '--name-only', '-z', '--format=', commit], root)
  const touched = paths.stdout.split('\0').filter(line => line !== '')
  if (!paths.ok || touched.length === 0) return false
  const same = run(['diff', '--quiet', commit, tip, '--', ...touched], root)
  return same.ok
}

/**
 * Whether the checkout's `origin` is the repository the command is about.
 *
 * A workflow whose checkout is not that repository would push the change into
 * somebody else's branch. The comparison is skipped when the remote is not a
 * GitHub URL, because then there is no `owner/name` to compare; `pushDestination`
 * is what refuses a push URL that does not reach the remote that was fetched.
 *
 * The URL read is the one the push uses, not the one a fetch uses: `git push
 * origin` honours `remote.origin.pushurl` and `url.<base>.pushInsteadOf`, so a
 * gate that wrote either would otherwise send the verified commit somewhere the
 * fetch URL never mentions — and `--push` falls back to the fetch URL when
 * neither is set, so an ordinary checkout reads exactly as it did.
 *
 * The caller passes the directory the push will run in: with
 * `extensions.worktreeConfig` on, a worktree has configuration of its own, and
 * reading the checkout while pushing from the worktree compares a URL nobody is
 * about to use.
 * @param run - the git runner.
 * @param workdir - the directory the push will run in.
 * @param repository - `owner/name` the command is about.
 */
function originMismatch(run: GitRunner, workdir: string, repository: string): string | undefined {
  const url = run(['remote', 'get-url', '--push', 'origin'], workdir)
  if (!url.ok) return `the checkout has no \`origin\` remote: ${url.detail}`
  const remote = remoteRepository(url.stdout)
  // Not a GitHub remote: there is no `owner/name` to compare here.
  if (remote === undefined) return undefined
  // Exact, and deliberately: a clone writes the canonical `owner/name`, so a
  // difference in case means the remote was edited by hand, and the refusal
  // shows both strings rather than guessing which one GitHub would resolve.
  if (remote === repository) return undefined
  return `the checkout's \`origin\` is \`${remote}\`, not \`${repository}\`, so this Action will not push`
}

/**
 * Whether the push would go somewhere other than the remote that was fetched.
 *
 * A push URL that is not the remote this checkout fetches from means the commit
 * a publish reports as landed may reach no branch of the pull request at all —
 * a mirror, another host, another port, a path on the machine. Nothing else
 * catches that: the repository comparison above only reads GitHub URLs, and a
 * before/after string comparison sees a push URL that was set before the run as
 * unchanged. Host, explicit port and path are what is compared, so fetching over
 * `https` and pushing over `ssh` to the same repository passes; a different port,
 * a `git:` push — the protocol is unauthenticated and read-only unless a server
 * opts in — and more than one push URL are each refused, the last because git
 * pushes to every push URL of a remote and there is no single destination to
 * compare.
 *
 * `--all` is what makes that refusal real: without it `get-url` prints one URL
 * however many are configured.
 * @param run - the git runner.
 * @param workdir - the directory the push will run in.
 */
function pushDestination(run: GitRunner, workdir: string): string | undefined {
  const fetch = run(['remote', 'get-url', 'origin'], workdir)
  const push = run(['remote', 'get-url', '--all', '--push', 'origin'], workdir)
  if (!fetch.ok || !push.ok) return `the checkout has no \`origin\` remote: ${push.detail}`
  const destinations = push.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (destinations.length > 1) {
    return 'the checkout has more than one push URL for `origin`, so this Action cannot tell where the branch would land'
  }
  const from = remoteLocation(fetch.stdout)
  const to = remoteLocation(destinations[0] ?? fetch.stdout)
  if (from === undefined || to === undefined) {
    // Redacted: the one URL this cannot read is also the one that may carry a
    // credential, and this message reaches a thread.
    return `the checkout's \`origin\` is not a remote URL this Action can read (\`${inline(redactCredentials(destinations[0] ?? fetch.stdout), 200)}\`)`
  }
  if (to.family === 'git') {
    return 'this checkout would push over the unauthenticated `git:` protocol, which is read-only unless the server opts in, so a branch cannot be published through it'
  }
  if (from.host === to.host && from.path === to.path && from.port === to.port) return undefined
  return `this checkout fetches \`${inline(from.host + '/' + from.path, 200)}\` but pushes to \`${inline(describe(to), 200)}\`, so a publish here would not reach the pull request's branch`
}

/** A location as a message names it: what to reach, without how it authenticates. */
function describe(target: RemoteTarget): string {
  return `${target.host}${target.port === undefined ? '' : `:${String(target.port)}`}/${target.path}`
}

/** A remote URL with the part that authenticates removed, for a message a human reads. */
function redactCredentials(url: string): string {
  return url.replace(/\/\/[^/@\s]*@/g, '//…@')
}

/** One place a remote can be reached: what it is, which host and port, which path. */
export interface RemoteTarget {
  /** How git reaches it: over http(s), over ssh, over the unauthenticated git protocol, or as a path. */
  family: 'http' | 'ssh' | 'git' | 'local'
  host: string
  /** The port the URL names, when it names one; `ssh://host:22` and `git@host:path` differ here. */
  port?: number | undefined
  path: string
}

/**
 * Where a git remote URL points, whatever form it is written in.
 *
 * A URL form is parsed, so a port is not read as a path and an explicit port is
 * kept; the `host:path` and `user@host:path` forms git also accepts are split by
 * hand; a string with a scheme this Action does not push over is not a remote it
 * can read, and anything else is a path on this machine, which git pushes to
 * directly. The `.git` suffix, a leading slash, and trailing slashes are not part
 * of the location.
 * @param remote - what `git remote get-url` printed.
 */
export function remoteLocation(remote: string): RemoteTarget | undefined {
  const trimmed = remote.trim()
  if (trimmed === '') return undefined
  // `git@host:path` and `host:path` both reach an ssh server; the `(?!\/)` keeps
  // a real scheme (`https://`, `ssh://`) out of this branch.
  const scp = /^(?:[^@/:\s]+@)?(?<host>[^@/:\s]+):(?!\/)(?<path>[^\s]+)$/.exec(trimmed)
  if (scp?.groups?.host !== undefined && scp.groups.path !== undefined) {
    return { family: 'ssh', host: scp.groups.host.toLowerCase(), path: trimPath(scp.groups.path) }
  }
  try {
    const parsed = new URL(trimmed)
    const families: Record<string, RemoteTarget['family']> = {
      'https:': 'http',
      'http:': 'http',
      'ssh:': 'ssh',
      'git:': 'git',
      'file:': 'local',
    }
    const family = families[parsed.protocol]
    // A scheme this Action does not push over parses as a URL and is not a remote
    // it can reason about.
    if (family === undefined) return undefined
    const port = parsed.port === '' ? undefined : Number(parsed.port)
    return { family, host: parsed.hostname.toLowerCase(), ...(port === undefined ? {} : { port }), path: trimPath(parsed.pathname) }
  } catch {
    // Not a URL at all: a path on this machine, which git pushes to directly.
    return { family: 'local', host: '', path: trimPath(trimmed) }
  }
}

/** A repository path without a leading slash, a trailing slash, or a `.git` suffix. */
function trimPath(path: string): string {
  return path.replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
}

/**
 * `owner/name` of a GitHub remote, or nothing when the remote is not one.
 *
 * The host is compared, not searched for: a URL is parsed when it has a scheme,
 * so a port is not read as an owner and `github.com.evil.example` is not
 * mistaken for GitHub; the `user@host:owner/name` form git also accepts is
 * handled separately.
 * @param remote - the URL `git remote get-url origin` printed.
 */
export function remoteRepository(remote: string): string | undefined {
  const trimmed = remote.trim()
  if (trimmed === '') return undefined
  const scp = /^[^@/]+@(?<host>[^:/]+):(?<path>[^\s]+)$/.exec(trimmed)
  if (scp?.groups?.host !== undefined && scp.groups.path !== undefined) {
    return scp.groups.host === 'github.com' ? ownerName(scp.groups.path) : undefined
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname !== 'github.com') return undefined
    return ownerName(parsed.pathname)
  } catch {
    return undefined
  }
}

/** `owner/name` from a repository path, without the `.git` suffix or a leading slash. */
function ownerName(path: string): string | undefined {
  const parts = path.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
  const [owner, repo] = parts
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return undefined
  return `${owner}/${repo}`
}

/** The commit subject a published revision is known by, which is also how a retry finds it. */
export function publishSubject(revision: string, pullRequest: number): string {
  return `dsh-migrate: publish ${revision} (PR #${String(pullRequest)})`
}

function defaultRun(args: readonly string[], cwd: string, input?: string): GitOutcome {
  const result = spawnSync('git', [...GIT_SAFE, ...args], {
    cwd,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      // Every path this module passes to git came from a diff a target supplied,
      // and git reads a path starting with `:` as pathspec magic: a file named
      // `:(exclude)*` would match nothing, and `git diff --quiet` would then say
      // a reverted change is still on the branch. Literal pathspecs make a path
      // a path.
      GIT_LITERAL_PATHSPECS: '1',
      GIT_AUTHOR_NAME: BOT_NAME,
      GIT_AUTHOR_EMAIL: BOT_EMAIL,
      GIT_COMMITTER_NAME: BOT_NAME,
      GIT_COMMITTER_EMAIL: BOT_EMAIL,
    },
  })
  const detail = `${(result.stderr ?? '').trim() || (result.stdout ?? '').trim()}`
  if (result.error !== undefined && result.error !== null) {
    // A directory that is gone, a `git` that is not installed, a watchdog that
    // fired: without this the refusal would carry an empty reason.
    return { ok: false, stdout: (result.stdout ?? '').trim(), detail: `git could not run: ${result.error.message}` }
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    detail: (detail === '' ? 'git exited non-zero without a message' : detail).slice(0, 1000),
  }
}

/**
 * Apply a frozen revision, verify it, and push it.
 *
 * The order is the contract: the gates run on the applied tree and before the
 * push, so a refusal leaves the branch exactly as it was. A revision that is
 * already on the branch is not applied twice — that is what makes a retry after
 * a reply that never arrived a no-op rather than a conflict.
 * @param input - the frozen revision, the diff, and where it should land.
 */
export async function applyHandback(input: HandbackInput): Promise<HandbackResult> {
  const invalid = invalidPublishTarget(input)
  if (invalid !== undefined) return { ok: false, stage: 'apply', detail: invalid }
  const run = input.run ?? defaultRun
  const subject = publishSubject(input.revision, input.pullRequest)
  // Each invocation gets its own directory: two publishes in one checkout would
  // otherwise delete each other's worktree while the other's gates were running,
  // and the loser would go on to push a tree that no longer existed.
  mkdirSync(dirname(input.treeDir), { recursive: true })
  const treeDir = mkdtempSync(`${input.treeDir}-`)
  let added = false
  const cleanup = (): void => {
    // Cleaning up must never be the thing that decides the outcome: a worktree
    // that cannot be removed after a successful push would otherwise be reported
    // as a failed publish, and the next publish prunes what a killed run left.
    try {
      if (added) run(['worktree', 'remove', '--force', treeDir], input.workdir)
      rmSync(treeDir, { recursive: true, force: true })
    } catch (error) {
      input.log(`publish: the worktree was left behind: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    // The earliest refusal: the checkout's own configuration, before a fetch is
    // spent on a remote that is not the repository this command is about. The
    // same two questions are asked again in the worktree the push runs from,
    // which is where a worktree-local configuration makes them differ.
    const mismatched = originMismatch(run, input.workdir, input.repository)
      ?? pushDestination(run, input.workdir)
    if (mismatched !== undefined) return { ok: false, stage: 'remote', detail: mismatched }

    input.log(`publish: fetching ${input.branch}`)
    const fetched = run(['fetch', 'origin', `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`], input.workdir)
    if (!fetched.ok) {
      return {
        ok: false,
        stage: 'remote',
        detail: `the remote ref \`${input.branch}\` could not be read: ${fetched.detail}`,
      }
    }
    const tip = run(['rev-parse', '--verify', `refs/remotes/origin/${input.branch}`], input.workdir).stdout
    if (tip === '') {
      return { ok: false, stage: 'remote', detail: `the remote has no branch \`${input.branch}\` to publish onto` }
    }

    // Already published: the same revision reached the branch in an earlier
    // attempt whose reply never arrived. The subject is compared in full — a
    // revision is a string the target chose and a substring match would let
    // `rev-1` be found by a commit about `rev-12` — and the change has to still
    // be there, because a reverted publish is not a published one.
    const published = alreadyPublishedCommit(run, input.workdir, input.branch, tip, subject)
    if (published !== undefined) {
      input.log(`publish: ${input.revision} is already on ${input.branch} (${published.slice(0, 8)})`)
      return {
        ok: true,
        commit: published,
        alreadyPublished: true,
        gates: { ok: true, steps: [], detail: 'not re-run: the revision is already on the branch' },
        detail: `revision ${input.revision} is already on ${input.branch}`,
      }
    }

    // The diff was taken against the tree the target froze. If the branch has
    // moved since, applying it here and pushing would be a non-fast-forward, so
    // it is refused before the gate stack is spent — and the remedy is the one
    // the contract names: the target rebuilds scratch onto the new head.
    if (tip !== input.headSha) {
      return {
        ok: false,
        stage: 'base',
        detail: `the target froze ${input.headSha.slice(0, 8)} but \`${input.branch}\` is at ${tip.slice(0, 8)}; rebuild scratch onto the new head and publish again`,
      }
    }

    // A publish a cancelled job killed leaves a registration whose directory is
    // gone; pruning removes exactly those and never a live worktree.
    run(['worktree', 'prune'], input.workdir)
    const tree = run(['worktree', 'add', '--force', '--detach', treeDir, input.headSha], input.workdir)
    if (!tree.ok) {
      return { ok: false, stage: 'apply', detail: `could not check out ${input.headSha.slice(0, 8)}: ${tree.detail}` }
    }
    added = true
    // Where the push will go, as it stands before the gates run, read where the
    // push will run: a worktree with `extensions.worktreeConfig` has a
    // configuration of its own, and reading the checkout would compare a URL
    // nothing is about to use.
    const treeCheck = originMismatch(run, treeDir, input.repository)
      ?? pushDestination(run, treeDir)
    if (treeCheck !== undefined) return { ok: false, stage: 'remote', detail: treeCheck }
    const remoteBefore = run(['remote', 'get-url', '--all', '--push', 'origin'], treeDir).stdout

    input.log('publish: applying the frozen diff')
    // `--3way` first: the diff was taken against the commit scratch was built
    // from, so a pull request that moved in the meantime still merges when git
    // can see the blobs the patch names. A plain apply is the fallback for a
    // diff with no index lines at all.
    const applied = run(['apply', '--3way', '--whitespace=nowarn', '-'], treeDir, input.diff)
    // A three-way apply that conflicts is not a patch that does not fit: the
    // scratch tree was built from an older base than the frozen head, and the
    // remedy is the one the contract names — the target rebuilds it. Git says so
    // by leaving unmerged entries, which is a fact about the index rather than a
    // sentence in whatever language the runner is set to.
    if (!applied.ok) {
      const unmerged = run(['ls-files', '--unmerged'], treeDir)
      if (unmerged.ok && unmerged.stdout !== '') {
        return {
          ok: false,
          stage: 'base',
          detail: `the frozen revision conflicts with ${input.headSha.slice(0, 8)}; rebuild scratch onto the current head and publish again`,
        }
      }
    }
    const plain = applied.ok ? applied : run(['apply', '--whitespace=nowarn', '-'], treeDir, input.diff)
    if (!plain.ok) {
      return {
        ok: false,
        stage: 'apply',
        detail: inline(`the frozen diff does not apply to ${input.headSha.slice(0, 8)}: ${plain.detail}`, 300),
      }
    }

    const staged = run(['add', '-A'], treeDir)
    if (!staged.ok) return { ok: false, stage: 'apply', detail: `could not stage the diff: ${staged.detail}` }
    // A diff can apply cleanly and change nothing — a target can freeze a
    // revision whose content is already at the head. Asking git what is staged
    // answers that in the exit code, which does not change with the locale the
    // way `nothing to commit` does.
    const stagedNothing = run(['diff', '--cached', '--quiet'], treeDir)
    if (stagedNothing.ok) {
      return {
        ok: false,
        stage: 'apply',
        detail: 'the frozen revision makes no change to the pull request head, so there is nothing to publish',
      }
    }
    const committed = run(['commit', '-m', subject], treeDir)
    if (!committed.ok) {
      return { ok: false, stage: 'apply', detail: inline(`could not commit the diff: ${committed.detail}`, 300) }
    }
    const commit = run(['rev-parse', 'HEAD'], treeDir).stdout
    input.log(`publish: committed ${commit.slice(0, 8)}; running the gates`)

    const gates = await input.runGates(treeDir)
    // A verdict that names no layer is not a verdict, and this is the last point
    // at which nothing has been pushed.
    if (gates.ok && gates.steps.length === 0) {
      return {
        ok: false,
        stage: 'gates',
        detail: 'the gate stack returned no layer verdict, so the tree cannot be called verified',
        gates,
      }
    }
    if (!gates.ok) {
      // Nothing is pushed, so the branch is untouched and the reason goes back
      // to whoever asked for the publish.
      return { ok: false, stage: 'gates', detail: gates.detail, gates }
    }
    // The gates run the plugin's own code, and `npm install` in a fresh worktree
    // creates `node_modules` and can rewrite a lockfile: what they leave behind
    // is theirs, not the change under review. Nothing has to refuse it, because
    // the commit was taken before they ran and the push names that commit.
    const leftovers = run(['status', '--porcelain'], treeDir)
    if (leftovers.ok && leftovers.stdout !== '') {
      input.log('publish: the gates left files in the worktree; the verified commit is what is pushed')
    }

    // The gates run the plugin's own code in a worktree that shares the
    // checkout's git config, so the remote the push will use is compared with
    // what it was before them: a gate that points the push somewhere else would
    // land the verified commit in a repository nobody asked about while the reply
    // says it landed. It is read where the push runs, which is the worktree.
    const retargeted = originMismatch(run, input.workdir, input.repository)
      ?? originMismatch(run, treeDir, input.repository)
      ?? pushDestination(run, treeDir)
      ?? (run(['remote', 'get-url', '--all', '--push', 'origin'], treeDir).stdout === remoteBefore
        ? undefined
        : 'the gates changed where this checkout pushes to')
    if (retargeted !== undefined) {
      return { ok: false, stage: 'remote', detail: retargeted, gates }
    }

    input.log(`publish: pushing ${commit.slice(0, 8)} to ${input.branch}`)
    // The explicit sha, not `HEAD`: the commit the reply names is the commit
    // that goes to the branch.
    const pushed = run(['push', 'origin', `${commit}:refs/heads/${input.branch}`], treeDir)
    if (!pushed.ok) {
      return { ok: false, stage: 'push', detail: `could not push to ${input.branch}: ${pushed.detail}`, gates }
    }
    return { ok: true, commit, alreadyPublished: false, gates, detail: `pushed ${commit.slice(0, 8)}` }
  } finally {
    cleanup()
  }
}
