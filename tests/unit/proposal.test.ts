import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { maintainerCommits, publishProposal, PROPOSAL_BRANCH } from '../../src/activities/proposal.ts'
import { excludeIgnoredPaths } from '../../src/git/worktree.ts'
import { GitHubClient } from '../../src/github/client.ts'
import { PROPOSAL_MARKER } from '../../src/github/templates.ts'
import { checkout } from '../support/repository.ts'
import { FakeGitHub } from '../support/github.ts'
import { contextOf, input, proposal } from '../support/migration.ts'

const ENV = { GITHUB_API_URL: 'https://api.test' }
const DOCUMENTS = { title: 'Migrate @acme/plugin to DeepSeek Harness 0.2.0', issue: `${PROPOSAL_MARKER}\nissue body`, pullRequest: `${PROPOSAL_MARKER}\npull request body` }

function migrated(work: string): void {
  writeFileSync(join(work, 'index.js'), 'export const apply = () => {}\n')
  mkdirSync(join(work, '.dsh-migrate', 'patch-reports', 'pre-step'), { recursive: true })
  writeFileSync(join(work, '.dsh-migrate', 'patch-reports', 'pre-step', 'report.md'), '# [Feature request] pre-step hook\n\n## Proposal\nadd it\n')
  excludeIgnoredPaths(work)
}

test('a proposal is one branch, one issue and one pull request, and a retry creates none again', async () => {
  const repo = checkout()
  const github = new FakeGitHub()
  try {
    migrated(repo.work)
    const deps = { workdir: repo.work, github: new GitHubClient('token', ENV, github.fetch), repository: { owner: 'acme', name: 'plugin' }, defaultBranch: 'main' }
    const context = contextOf(input('0.2.0'), [])
    const first = await publishProposal(deps, context, DOCUMENTS)
    assert.equal(first.event.type, 'proposal.published')
    const published = first.event.type === 'proposal.published' ? first.event.proposal : undefined
    assert.equal(published?.branch, PROPOSAL_BRANCH)
    assert.equal(repo.git(['rev-parse', `refs/heads/${PROPOSAL_BRANCH}`], repo.remote), published?.headSha)
    const files = repo.git(['show', '--name-only', '--format=', PROPOSAL_BRANCH], repo.remote).split('\n')
    assert.deepEqual(files, ['index.js'])
    assert.equal(repo.git(['log', '-1', '--format=%an', PROPOSAL_BRANCH], repo.remote), 'dsh-migrate[bot]')

    const pull = github.pulls.get(published?.pullRequest.number ?? 0)
    assert.equal(pull?.head.ref, PROPOSAL_BRANCH)
    assert.equal(pull?.base, 'main')
    assert.match(pull?.body ?? '', new RegExp(`Closes #${String(published?.issue.number)}`))
    assert.doesNotMatch(pull?.body ?? '', /Workflow changes left out/)
    const issue = github.issues.get(published?.issue.number ?? 0)
    assert.equal(issue?.comments.filter(comment => comment.body.includes('dsh-migrate:patch-reports:0.2.0')).length, 2)
    assert.deepEqual([...first.files.keys()], ['patch-reports/pre-step.md'])

    // The job died after the effects and before the log was pushed: the retry
    // starts from a fresh checkout and must find what the first attempt made.
    repo.git(['checkout', '--quiet', 'main'])
    migrated(repo.work)
    const retry = await publishProposal(deps, context, DOCUMENTS)
    const again = retry.event.type === 'proposal.published' ? retry.event.proposal : undefined
    assert.deepEqual([again?.issue.number, again?.pullRequest.number], [published?.issue.number, published?.pullRequest.number])
    assert.equal(github.issues.size, 1)
    assert.equal(github.pulls.size, 1)
    assert.equal(github.issues.get(again?.issue.number ?? 0)?.comments.length, 2)
  } finally {
    repo.cleanup()
  }
})

test('the proposal carries the default branch\'s workflows, and names the workflow changes it leaves out', async () => {
  const repo = checkout()
  const github = new FakeGitHub()
  try {
    mkdirSync(join(repo.work, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(repo.work, '.github', 'workflows', 'dsh-migrate.yml'), 'name: migrate v1\n')
    writeFileSync(join(repo.work, '.github', 'workflows', 'old.yml'), 'name: old\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '--quiet', '-m', 'workflows'])
    repo.git(['push', '--quiet', 'origin', 'HEAD:main'])
    // While the migration runs, a maintainer changes the workflows on main.
    const maintainer = repo.clone()
    writeFileSync(join(maintainer, '.github', 'workflows', 'dsh-migrate.yml'), 'name: migrate v2\n')
    repo.git(['rm', '-q', '.github/workflows/old.yml'], maintainer)
    writeFileSync(join(maintainer, '.github', 'workflows', 'new.yml'), 'name: new\n')
    repo.git(['add', '-A'], maintainer)
    repo.git(['commit', '--quiet', '-m', 'update workflows'], maintainer)
    repo.git(['push', '--quiet', 'origin', 'HEAD:main'], maintainer)

    migrated(repo.work)
    // The migration changed a workflow too.
    writeFileSync(join(repo.work, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
    const deps = { workdir: repo.work, github: new GitHubClient('token', ENV, github.fetch), repository: { owner: 'acme', name: 'plugin' }, defaultBranch: 'main' }
    const result = await publishProposal(deps, contextOf(input('0.2.0'), []), DOCUMENTS)
    const published = result.event.type === 'proposal.published' ? result.event.proposal : undefined

    assert.equal(repo.git(['diff', '--name-only', 'main', PROPOSAL_BRANCH, '--', '.github/workflows'], repo.remote), '')
    assert.deepEqual(repo.git(['diff', '--name-only', 'main', PROPOSAL_BRANCH], repo.remote).split('\n'), ['index.js'])
    for (const body of [github.pulls.get(published?.pullRequest.number ?? 0)?.body, github.issues.get(published?.issue.number ?? 0)?.body]) {
      assert.match(body ?? '', /## Workflow changes left out/)
      assert.match(body ?? '', /- `\.github\/workflows\/ci\.yml`/)
      assert.match(body ?? '', /\+name: ci/)
      assert.doesNotMatch(body ?? '', /dsh-migrate\.yml|new\.yml/)
    }
  } finally {
    repo.cleanup()
  }
})

test('an inherited proposal is updated in place, not opened again', async () => {
  const repo = checkout()
  const github = new FakeGitHub()
  try {
    const old = proposal(12)
    github.addIssue({ number: old.issue.number, title: 'old', body: 'old' })
    github.addPull({ number: old.pullRequest.number, title: 'old', head: { ref: PROPOSAL_BRANCH, sha: 'c'.repeat(40) } })
    migrated(repo.work)
    const deps = { workdir: repo.work, github: new GitHubClient('token', ENV, github.fetch), repository: { owner: 'acme', name: 'plugin' }, defaultBranch: 'main' }
    const result = await publishProposal(deps, contextOf(input('0.2.1', { proposal: old }), []), { ...DOCUMENTS, title: 'Migrate to 0.2.1' })
    const updated = result.event.type === 'proposal.published' ? result.event.proposal : undefined
    assert.deepEqual([updated?.issue.number, updated?.pullRequest.number], [old.issue.number, old.pullRequest.number])
    assert.equal(github.pulls.get(old.pullRequest.number)?.title, 'Migrate to 0.2.1')
    assert.equal(github.issues.get(old.issue.number)?.title, 'Migrate to 0.2.1')
    assert.equal(github.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls')).length, 0)
  } finally {
    repo.cleanup()
  }
})

test('only commits this Action did not author count as maintainer commits', async () => {
  const github = new FakeGitHub()
  const open = proposal(9)
  github.addPull({
    number: 9,
    head: { ref: PROPOSAL_BRANCH, sha: 'd'.repeat(40) },
    commits: [
      { login: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' },
      { login: 'maintainer', email: 'maintainer@example.test' },
    ],
  })
  const count = await maintainerCommits(new GitHubClient('token', ENV, github.fetch), { owner: 'acme', name: 'plugin' }, open.pullRequest.number)
  assert.equal(count, 1)
})
