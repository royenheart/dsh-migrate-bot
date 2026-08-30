import { spawnSync } from 'node:child_process'
import { stagePluginChanges } from '../git/worktree.ts'
import { githubRequest } from './api.ts'
import type { GithubPublisher, PublishResult } from '../pipeline/types.ts'

const GIT_SAFE = ['-c', 'safe.directory=*'] as const

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', [...GIT_SAFE, ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

export function parseGithubRepo(
  originUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { owner: string; repo: string } {
  const fromEnv = env.GITHUB_REPOSITORY
  if (fromEnv !== undefined && fromEnv.includes('/')) {
    const [owner, repo] = fromEnv.split('/')
    if (owner !== undefined && repo !== undefined && owner !== '' && repo !== '') {
      return { owner, repo }
    }
  }
  const match = originUrl.trim().match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+)/)
  const owner = match?.groups?.owner
  const rawRepo = match?.groups?.repo
  if (owner === undefined || rawRepo === undefined) {
    throw new Error(`cannot parse GitHub repo from origin: ${originUrl}`)
  }
  return { owner, repo: rawRepo.replace(/\.git$/, '') }
}

function remoteRepo(cwd: string): { owner: string; repo: string } {
  const url = runGit(['remote', 'get-url', 'origin'], cwd).trim()
  return parseGithubRepo(url)
}

export function detectBaseBranch(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_BASE_REF !== undefined && env.GITHUB_BASE_REF !== '') {
    return env.GITHUB_BASE_REF
  }
  const originHead = spawnSync('git', [...GIT_SAFE, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
    encoding: 'utf8',
  })
  if (originHead.status === 0) {
    const detected = originHead.stdout.trim().replace(/^origin\//, '')
    if (detected !== '') return detected
  }
  if (env.GITHUB_EVENT_NAME !== 'pull_request' && env.GITHUB_REF_NAME !== undefined && env.GITHUB_REF_NAME !== '') {
    return env.GITHUB_REF_NAME
  }
  return 'master'
}

function ensureGitIdentity(cwd: string): void {
  const name = spawnSync('git', [...GIT_SAFE, 'config', '--get', 'user.name'], { cwd, encoding: 'utf8' })
  if (name.status === 0 && name.stdout.trim() !== '') return
  runGit(['config', 'user.name', 'dsh-migrate[bot]'], cwd)
  runGit(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], cwd)
}

/**
 * Commit the dirty tree (excluding reports/secrets), push a branch, open an Issue and a PR.
 * If nothing remains after exclusions, this is a no-op.
 */
export function createGithubPublisher(token: string): GithubPublisher {
  return {
    async commentIssue(issueNumber, body, workdir) {
      const { owner, repo } = remoteRepo(workdir)
      await githubRequest(token, 'POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body })
    },
    async publish(input) {
      const { owner, repo } = remoteRepo(input.workdir)
      ensureGitIdentity(input.workdir)
      runGit(['checkout', '-B', input.branch], input.workdir)
      stagePluginChanges(input.workdir)
      const commit = spawnSync('git', [...GIT_SAFE, 'commit', '-m', input.title], {
        cwd: input.workdir,
        encoding: 'utf8',
      })
      const combined = `${commit.stdout}${commit.stderr}`
      if (commit.status !== 0 && /nothing to commit/.test(combined)) {
        return {}
      }
      if (commit.status !== 0) {
        throw new Error(`git commit failed: ${commit.stderr}`)
      }
      const push = spawnSync('git', [...GIT_SAFE, 'push', '-u', 'origin', input.branch], {
        cwd: input.workdir,
        encoding: 'utf8',
      })
      if (push.status !== 0) {
        throw new Error(`git push failed: ${push.stderr}`)
      }

      const issue = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/issues`, {
        title: input.title,
        body: input.issueBody,
      }) as { html_url?: string; number?: number }
      const base = detectBaseBranch(input.workdir)
      const pr = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
        title: input.title,
        body: `${input.prBody}\n\nCloses #${issue.number ?? ''}`,
        head: input.branch,
        base,
      }) as { html_url?: string; number?: number }

      const published: PublishResult = {}
      if (issue.html_url !== undefined) published.issueUrl = issue.html_url
      if (typeof issue.number === 'number') published.issueNumber = issue.number
      if (pr.html_url !== undefined) published.pullRequestUrl = pr.html_url
      if (typeof pr.number === 'number') published.pullRequestNumber = pr.number
      return published
    },
  }
}
