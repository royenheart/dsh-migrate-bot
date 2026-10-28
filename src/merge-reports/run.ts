import { PACKAGE_VERSION } from '../paths.ts'
import { sha256 } from '../observability/manifest.ts'
import { isQuotaError } from '../quota/errors.ts'
import { channelPrompt } from '../prompts/reports.ts'
import { inline } from '../render/text.ts'
import { GitHubClient, type Repository } from '../github/client.ts'
import { MIGRATE_BOT_CHANNEL, resolveChannels, UPGRADE_SKILL_CHANNEL } from './channels.ts'
import { collectEvidence, type MigrationFiles, type ReportedMigration } from './evidence.ts'
import { renderMigrateBotReport } from './render.ts'
import { renderEvidence } from './render.ts'
import { deliver } from './deliver.ts'
import { duplicatePayloadSchema, migrateBotPayloadSchema, parsePayload, reportPayloadSchema } from './parse.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { SessionUsage } from '../workflow/model.ts'
import type { SessionObservation, SessionObserver } from '../observability/session.ts'

/**
 * Send one migration's merge report to one channel.
 *
 * A channel that cannot run — no token, no API key, nothing to classify — is
 * skipped with the reason; a session whose output does not parse, or a GitHub
 * call that fails, is a failure with the reason. Neither stops the other
 * channels.
 */

export interface ReportDeps {
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  repository: Repository
  /** A client with the workflow token, which can read the consumer repository. */
  github: GitHubClient
  files: MigrationFiles
  agent: AgentRunner
  apiKey: string | undefined
  workdir: string
  /** Load or unload the community upgrade skills for the next session. */
  syncSkills: (enabled: boolean) => void
  /** Collects the report session for the run manifest and Langfuse. */
  observer?: SessionObserver | undefined
  fetchImpl?: typeof fetch | undefined
}

export interface ReportOutcome {
  outcome: 'delivered' | 'held' | 'skipped' | 'failed' | 'dry-run'
  detail: string
  url?: string | undefined
  usage?: SessionUsage | undefined
}

export async function runReportChannel(
  channelId: string,
  migration: ReportedMigration,
  deps: ReportDeps,
  mode: 'deliver' | 'dry-run',
): Promise<ReportOutcome> {
  const progress: { usage?: SessionUsage | undefined; posted: string[] } = { posted: [] }
  try {
    return await reportToChannel(channelId, migration, deps, mode, progress)
  } catch (error) {
    // A token without access, a missing discussion category, a rate limit: this channel failed, the others still run.
    const detail = inline(error instanceof Error ? error.message : String(error), 300)
    return { outcome: 'failed', detail: progress.posted.length === 0 ? detail : `${detail}; already posted: ${progress.posted.join(' ')}`, usage: progress.usage }
  }
}

async function reportToChannel(
  channelId: string,
  migration: ReportedMigration,
  deps: ReportDeps,
  mode: 'deliver' | 'dry-run',
  progress: { usage?: SessionUsage | undefined; posted: string[] },
): Promise<ReportOutcome> {
  const channel = resolveChannels(deps.config).find(entry => entry.id === channelId)
  if (channel === undefined) return { outcome: 'skipped', detail: `no channel \`${channelId}\` is configured` }
  const token = deps.env[channel.tokenEnv]
  if (token === undefined || token === '') return { outcome: 'skipped', detail: `\`${channel.tokenEnv}\` is not set` }
  if (deps.apiKey === undefined) return { outcome: 'skipped', detail: 'no DeepSeek API key, so no session can run' }

  const duplicateCheck = channel.kind === 'duplicate-check'
  const evidence = await collectEvidence({
    github: deps.github,
    repository: deps.repository,
    migration,
    files: deps.files,
    ...(PACKAGE_VERSION === undefined ? {} : { actionVersion: PACKAGE_VERSION }),
    model: {
      provider: deps.config.agent.provider,
      model: deps.config.agent.model,
      thinking: deps.config.agent.thinking,
      reasoningEffort: deps.config.agent.reasoningEffort,
    },
    searchCandidates: duplicateCheck,
  })
  const drafts = evidence.patchReports.filter(report => report.kind === 'draft')
  if (duplicateCheck && drafts.length === 0) return { outcome: 'skipped', detail: 'the migration wrote no discussion draft' }

  deps.syncSkills(channel.id === UPGRADE_SKILL_CHANNEL)
  const prompt = channelPrompt(channel, renderEvidence(evidence, { includeCandidates: duplicateCheck }))
  const startedAt = new Date().toISOString()
  const observations: SessionObservation[] = []
  let session
  try {
    session = await deps.agent.run({
      kind: 'report',
      prompt,
      workdir: deps.workdir,
      agent: deps.config.agent,
      apiKey: deps.apiKey,
      onObservation: observation => { observations.push(observation) },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    deps.observer?.record({
      kind: 'report',
      name: `report-${channel.id}`,
      prompt,
      promptSha256: sha256(prompt),
      startedAt,
      endedAt: new Date().toISOString(),
      outcome: isQuotaError(error) ? 'spend-cap' : 'failed',
      toolCalls: observations.filter(observation => observation.type === 'tool-call').length,
      observations,
    })
    return { outcome: 'failed', detail: isQuotaError(error) ? `spend cap: ${detail}` : detail }
  }
  const usage = session.usage === undefined
    ? undefined
    : {
      inputTokens: session.usage.inputTokens,
      outputTokens: session.usage.outputTokens,
      cacheHitTokens: session.usage.cacheHitTokens,
      ...(session.usage.costUsd === undefined ? {} : { usd: session.usage.costUsd }),
    }
  progress.usage = usage
  deps.observer?.record({
    kind: 'report',
    name: `report-${channel.id}`,
    prompt,
    promptSha256: sha256(prompt),
    startedAt,
    endedAt: new Date().toISOString(),
    outcome: 'completed',
    output: session.report,
    ...(usage === undefined ? {} : { usage }),
    ...(session.usage === undefined
      ? {}
      : { progress: { turns: session.usage.turns, steps: session.usage.steps, elapsedSeconds: session.usage.elapsedSeconds } }),
    toolCalls: observations.filter(observation => observation.type === 'tool-call').length,
    observations,
  })
  const client = new GitHubClient(token, deps.env, deps.fetchImpl)

  // The payload is the last fenced JSON block of everything the session printed; the report the runner extracts is its first plain or markdown block.
  if (!duplicateCheck) {
    if (channel.id === MIGRATE_BOT_CHANNEL) {
      const parsed = parsePayload(session.raw, migrateBotPayloadSchema)
      if (!parsed.ok) return { outcome: 'failed', detail: parsed.reason, usage }
      const rendered = renderMigrateBotReport(evidence, parsed.value)
      if (mode === 'dry-run') return { outcome: 'dry-run', detail: `${rendered.title}\n\n${rendered.body.slice(0, 1_200)}`, usage }
      const url = await deliver(client, channel, rendered)
      return { outcome: 'delivered', detail: `${channel.method} created in ${channel.repo}`, url, usage }
    }
    const parsed = parsePayload(session.raw, reportPayloadSchema)
    if (!parsed.ok) return { outcome: 'failed', detail: parsed.reason, usage }
    if (mode === 'dry-run') return { outcome: 'dry-run', detail: `${parsed.value.title}\n\n${parsed.value.body.slice(0, 1_200)}`, usage }
    const url = await deliver(client, channel, parsed.value)
    return { outcome: 'delivered', detail: `${channel.method} created in ${channel.repo}`, url, usage }
  }

  const parsed = parsePayload(session.raw, duplicatePayloadSchema)
  if (!parsed.ok) return { outcome: 'failed', detail: parsed.reason, usage }
  const posted = progress.posted
  const held: string[] = []
  for (const draft of drafts) {
    const decision = parsed.value.decisions.find(entry => entry.slug === draft.slug)
    if (decision === undefined || !decision.post) {
      const why = decision === undefined ? 'no decision was returned' : decision.reason
      const existing = decision?.existing.map(entry => entry.url).join(', ') ?? ''
      held.push(`${draft.slug}: ${inline(why, 200)}${existing === '' ? '' : ` (${inline(existing, 300)})`}`)
      continue
    }
    if (mode === 'deliver') posted.push(await deliver(client, channel, { title: draft.title, body: draft.body }))
    else posted.push(`would post ${draft.slug}`)
  }
  const detail = held.length === 0 ? '' : `held: ${held.join('; ')}`
  if (mode === 'dry-run') return { outcome: 'dry-run', detail: [...posted, detail].filter(Boolean).join('\n'), usage }
  if (posted.length === 0) return { outcome: 'held', detail, usage }
  return { outcome: 'delivered', detail: detail === '' ? `${String(posted.length)} discussion(s) posted` : detail, url: posted.join(' '), usage }
}
