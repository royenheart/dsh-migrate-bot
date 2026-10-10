import { z } from 'zod'
import { createDeployClient, parseFrozenRevision, parsePreviewState, resolveDeployService, type DeployService, type PreviewKey } from '../deploy/client.ts'
import { applyHandback, invalidBranch, invalidCommit, invalidRevision, type HandbackResult } from '../deploy/handback.ts'
import { excludeIgnoredPaths } from '../git/worktree.ts'
import { externalUrl, inline } from '../render/text.ts'
import { resolveChannels } from '../merge-reports/channels.ts'
import { renderTreeCheck, type TreeCheckReport } from '../activities/check-tree.ts'
import { slugOf, type GitHubClient, type Repository } from '../github/client.ts'
import { renderCommandHelp } from './table.ts'
import type { ParsedCommand } from './parse.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { ReportOutcome } from '../merge-reports/run.ts'
import type { MigrationView, Projection } from '../workflow/projection.ts'

/**
 * Carry out one comment command and produce the reply.
 *
 * The executor never throws: a command that cannot run is answered with why,
 * because the reply on the thread is the record a user sees.
 *
 * A comment delivered twice has one effect. `report` passes the comment id to
 * the machine, which ignores a comment it has handled. The deploy-service verbs
 * send an `Idempotency-Key` derived from the comment, which the service answers
 * with its first result. `publish` finds the revision already on the branch.
 */

export interface CommandRunInput {
  command: ParsedCommand
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  workdir: string
  repository: Repository | undefined
  github: GitHubClient | undefined
  /** The issue or pull request the comment is on. */
  issueNumber: number | undefined
  commentId: string
  log: (message: string) => void
  status: () => Projection
  /** Deliver a `report` command to a migration and advance it. */
  report: (migration: string, resend: boolean) => Promise<MigrationView>
  /** Run every enabled channel of a migration without delivering. */
  reportDryRun: (migration: MigrationView) => Promise<Array<{ channel: string; result: ReportOutcome }>>
  /** Check the tree a `publish` applied; absent when this invocation cannot. */
  checkTree: ((tree: string, migration: MigrationView | undefined) => Promise<TreeCheckReport>) | undefined
  treeDir: string
  fetchImpl?: typeof fetch | undefined
}

export interface CommandOutcome {
  ok: boolean
  reply: string
}

/** The idempotency key the deploy service receives: one per comment and verb. */
export function commandKey(repository: string, pullRequest: number, verb: string, commentId: string): string {
  return `${repository}#${String(pullRequest)}:${verb}:comment=${commentId}`
}

/** The migration whose proposal the comment's thread belongs to. */
function migrationOf(projection: Projection, issueNumber: number | undefined): MigrationView | undefined {
  if (issueNumber === undefined) return undefined
  return projection.migrations.find(view => view.context.proposal?.pullRequest.number === issueNumber
    || view.context.proposal?.issue.number === issueNumber)
}

export async function runCommand(input: CommandRunInput): Promise<CommandOutcome> {
  try {
    return await execute(input)
  } catch (error) {
    return { ok: false, reply: `**\`${input.command.spec.verb}\` failed:** ${inline(error instanceof Error ? error.message : String(error), 300)}` }
  }
}

async function execute(input: CommandRunInput): Promise<CommandOutcome> {
  const { spec, flags } = input.command
  if (spec.verb === 'status') return await statusCommand(input)
  if (spec.verb === 'report') return await reportCommand(input, flags.includes('--dry-run'), flags.includes('--resend'))

  const service = resolveDeployService(input.config, input.env)
  if ('reason' in service) return { ok: false, reply: `**\`${spec.verb}\` cannot run:** ${service.reason}` }
  if (!input.config.deploy.preview.enabled) {
    return { ok: false, reply: `**\`${spec.verb}\` cannot run:** preview deployments are off (\`deploy.preview.enabled\` is false).` }
  }
  if (input.repository === undefined || input.issueNumber === undefined) {
    return { ok: false, reply: `**\`${spec.verb}\` cannot run:** the comment names no pull request of a known repository.` }
  }
  const preview: PreviewKey = { repository: slugOf(input.repository), pullRequest: input.issueNumber }
  const client = createDeployClient(service, input.fetchImpl, commandKey(preview.repository, preview.pullRequest, spec.verb, input.commentId))
  if (spec.verb === 'publish') return await publishCommand(input, client, preview)
  const { extendDays, ttlDays } = input.config.deploy.preview
  const result = spec.verb === 'redeploy'
    ? await client.redeploy(preview)
    : spec.verb === 'destroy'
      ? await client.destroy(preview)
      : await client.extend(preview, { days: extendDays, maxTtlDays: ttlDays })
  if (!result.ok) return { ok: false, reply: `**\`${spec.verb}\` failed:** ${inline(result.reason, 300)}` }
  const asked = spec.verb === 'extend' ? ` It asked for ${String(extendDays)} day(s), with ${String(ttlDays)} as the ceiling; the deploy service decides what it grants.` : ''
  return {
    ok: true,
    reply: result.replayed === true
      ? `**\`${spec.verb}\` already done.** The deploy service recognised this command and answered with its first result.`
      : `**\`${spec.verb}\` accepted.**${asked}`,
  }
}

async function statusCommand(input: CommandRunInput): Promise<CommandOutcome> {
  const projection = input.status()
  const tag = (view: MigrationView | undefined): string => view === undefined ? '—' : `\`${inline(view.target.tag, 80)}\` (${view.state})`
  const lines = [
    '**Migration state**',
    '',
    `- Processed release: ${tag(projection.processed)}`,
    `- Verified release: ${projection.verified === undefined ? '—' : `\`${inline(projection.verified.tag, 80)}\``}`,
    `- Open proposal: ${projection.open?.context.proposal === undefined ? 'none' : `#${String(projection.open.context.proposal.pullRequest.number)} for ${tag(projection.open)}`}`,
    '',
    '**Report channels**',
    '',
    ...resolveChannels(input.config).map((channel) => {
      if (!channel.enabled) return `- \`${channel.id}\`: off`
      const token = (input.env[channel.tokenEnv] ?? '') !== ''
      return `- \`${channel.id}\`: on${token ? '' : `, but \`${channel.tokenEnv}\` is not set`}`
    }),
  ]
  const service = resolveDeployService(input.config, input.env)
  if (input.config.deploy.enabled) {
    lines.push('', '**Deploy service**', '', `- \`${input.config.deploy.endpoint ?? '(unset)'}\``)
    lines.push(...await previewLines(input, service))
  }
  lines.push('', '<details><summary>Commands</summary>', '', renderCommandHelp(), '', '</details>')
  return { ok: true, reply: lines.join('\n') }
}

async function previewLines(input: CommandRunInput, service: DeployService | { reason: string }): Promise<string[]> {
  if ('reason' in service) return [`- Preview deployment: not asked (${service.reason})`]
  if (input.repository === undefined || input.issueNumber === undefined) return ['- Preview deployment: not asked (no pull request is named)']
  const result = await createDeployClient(service, input.fetchImpl).status({ repository: slugOf(input.repository), pullRequest: input.issueNumber })
  if (!result.ok) return [`- Preview deployment: the deploy service could not be asked (${inline(result.reason, 300)})`]
  const state = parsePreviewState(result.body)
  if (state.state === undefined && state.url === undefined) return ['- Preview deployment: none for this pull request']
  const parts = [inline(state.state ?? 'recorded')]
  if (state.headSha !== undefined) parts.push(`built from \`${inline(state.headSha.slice(0, 8), 40)}\``)
  if (state.expiresAt !== undefined) parts.push(`until ${inline(state.expiresAt, 40)}`)
  const lines = [`- Preview deployment: ${parts.join(', ')}`]
  if (state.detail !== undefined) lines.push(`  - ${inline(state.detail, 300)}`)
  for (const [label, named] of [['page', state.url], ['safe entry', state.safeUrl]] as const) {
    if (named === undefined) continue
    const linked = externalUrl(named, 300)
    lines.push(linked === undefined ? `  - ${label}: the deploy service named one this Action will not link` : `  - ${label}: \`${linked}\``)
  }
  return lines
}

async function reportCommand(input: CommandRunInput, dryRun: boolean, resend: boolean): Promise<CommandOutcome> {
  const migration = migrationOf(input.status(), input.issueNumber)
  if (migration === undefined) {
    return { ok: false, reply: '**`report` cannot run:** this thread is not a proposal of this Action.' }
  }
  if (dryRun) {
    const results = await input.reportDryRun(migration)
    const lines = ['**Report dry run**', '']
    for (const { channel, result } of results) {
      lines.push(`- \`${channel}\`: ${result.outcome}${result.outcome === 'dry-run' ? '' : ` — ${inline(result.detail, 300)}`}`)
      if (result.outcome === 'dry-run') lines.push('', '<details><summary>Would send</summary>', '', '```markdown', result.detail, '```', '', '</details>')
    }
    if (results.length === 0) lines.push('No report channel is enabled.')
    return { ok: true, reply: lines.join('\n') }
  }
  const before = migration.context.delivered
  const after = await input.report(migration.id, resend)
  const lines = [`**Report** (the migration is ${after.state})`, '']
  for (const channel of after.context.input.settings.reportChannels) {
    const sent = after.context.delivered.includes(channel) && (resend || !before.includes(channel))
    lines.push(`- \`${channel}\`: ${sent ? 'sent' : before.includes(channel) && !resend ? 'already sent' : 'not sent'}`)
  }
  if (after.context.input.settings.reportChannels.length === 0) lines.push('No report channel is enabled.')
  return { ok: true, reply: lines.join('\n') }
}

const pullSchema = z.object({
  state: z.string(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
})

async function publishCommand(
  input: CommandRunInput,
  client: ReturnType<typeof createDeployClient>,
  preview: PreviewKey,
): Promise<CommandOutcome> {
  if (input.checkTree === undefined || input.github === undefined) {
    return { ok: false, reply: '**`publish` cannot run:** this invocation cannot check a tree or read the pull request, and a change reaches the branch only after the checks.' }
  }
  const pull = await input.github.rest('GET', `/repos/${preview.repository}/pulls/${String(preview.pullRequest)}`, pullSchema)
  const branchProblem = invalidBranch(pull.head.ref)
  if (branchProblem !== undefined) return { ok: false, reply: `**\`publish\` could not run:** ${branchProblem}` }
  if (pull.state !== 'open') return { ok: false, reply: `**\`publish\` could not run:** pull request #${String(preview.pullRequest)} is ${pull.state}.` }
  if (pull.head.repo?.full_name !== preview.repository) {
    return { ok: false, reply: `**\`publish\` could not run:** the pull request branch lives in another repository, and this Action does not write to a fork.` }
  }

  const frozen = await client.publish(preview)
  if (!frozen.ok) return { ok: false, reply: `**\`publish\` failed:** ${inline(frozen.reason, 300)}` }
  const revision = parseFrozenRevision(frozen.body)
  if (revision === undefined) {
    return { ok: false, reply: '**`publish` could not continue:** the deploy service acknowledged the request without freezing a revision.' }
  }
  const refuse = async (detail: string, stage: 'remote' | 'apply' = 'apply'): Promise<CommandOutcome> => {
    await report(client, preview, { ok: false, stage, detail: inline(detail, 300) }, revision.revision, pull.head.ref, input.log)
    return { ok: false, reply: `**\`publish\` could not continue:** ${inline(detail, 300)}` }
  }
  const frozenProblem = invalidRevision(revision.revision) ?? (revision.headSha === undefined ? undefined : invalidCommit(revision.headSha))
  if (frozenProblem !== undefined) return await refuse(frozenProblem)
  const fetched = await client.scratch(preview, revision.revision)
  if (!fetched.ok) return await refuse(`the deploy service could not serve the revision it froze: ${fetched.reason}`, 'remote')
  const diff = diffOf(fetched)
  if ('reason' in diff) return await refuse(diff.reason)

  excludeIgnoredPaths(input.workdir)
  const migration = migrationOf(input.status(), preview.pullRequest)
  let applied: HandbackResult
  try {
    applied = await applyHandback({
      workdir: input.workdir,
      branch: pull.head.ref,
      headSha: revision.headSha ?? pull.head.sha,
      revision: revision.revision,
      diff: diff.diff,
      repository: preview.repository,
      pullRequest: preview.pullRequest,
      treeDir: input.treeDir,
      checkTree: async tree => await (input.checkTree as NonNullable<CommandRunInput['checkTree']>)(tree, migration),
      log: input.log,
    })
  } catch (error) {
    applied = { ok: false, stage: 'error', detail: inline(error instanceof Error ? error.message : String(error), 300) }
  }
  await report(client, preview, applied, revision.revision, pull.head.ref, input.log)
  if (applied.ok) {
    const head = applied.alreadyPublished
      ? `**\`publish\` already landed.** Revision \`${revision.revision}\` is on \`${pull.head.ref}\` as \`${applied.commit.slice(0, 8)}\`.`
      : `**\`publish\` landed.** Revision \`${revision.revision}\` is on \`${pull.head.ref}\` as \`${applied.commit.slice(0, 8)}\`.`
    const checked = applied.checks === undefined ? '' : `\n\nChecked against \`${inline(applied.checks.release.tag, 80)}\`:\n\n${renderTreeCheck(applied.checks)}`
    return { ok: true, reply: `${head}${checked}` }
  }
  const checks = applied.checks === undefined ? '' : `\n\n${renderTreeCheck(applied.checks)}`
  return { ok: false, reply: `**\`publish\` was refused at the ${applied.stage} stage.** Nothing reached \`${pull.head.ref}\`.\n\n${inline(applied.detail, 600)}${checks}` }
}

/** Tell the deploy service how a publish ended; a service that cannot be told is a log line. */
async function report(
  client: ReturnType<typeof createDeployClient>,
  preview: PreviewKey,
  applied: HandbackResult,
  revision: string,
  branch: string,
  log: (message: string) => void,
): Promise<void> {
  const result = await client.publishResult(preview, {
    revision,
    outcome: applied.ok ? 'published' : 'refused',
    branch,
    ...(applied.ok
      ? { commit: applied.commit, ...(applied.alreadyPublished ? { alreadyPublished: true as const } : {}) }
      : { stage: applied.stage, detail: inline(applied.detail, 300) }),
    ...(applied.checks === undefined ? {} : {
      tag: inline(applied.checks.release.tag, 80),
      checks: applied.checks.results.map(result => ({ check: result.check, outcome: result.outcome })),
    }),
  })
  if (!result.ok) log(`publish: the deploy service was not told how it ended: ${result.reason}`)
}

/** The diff a scratch answer carries, whether served as JSON or as a patch. */
function diffOf(answer: { body?: unknown; text?: string }): { diff: string } | { reason: string } {
  const isJson = typeof answer.body === 'object' && answer.body !== null
  const parsed = z.object({ diff: z.string() }).safeParse(answer.body)
  if (isJson && !parsed.success) return { reason: 'the deploy service answered the frozen revision as JSON without a `diff` field' }
  const diff = parsed.success ? parsed.data.diff : answer.text ?? ''
  return diff.trim() === '' ? { reason: 'the deploy service served the frozen revision as an empty diff' } : { diff }
}
