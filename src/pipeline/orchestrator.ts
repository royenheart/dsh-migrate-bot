import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleFixPrompt } from '../prompts/defaults.ts'
import { resolvePrompts } from '../prompts/resolve.ts'
import { renderDocuments } from '../github/templates.ts'
import { formatOfficialDiscussionInvite } from '../github/discussions.ts'
import { collectPatchReports, formatPatchReportComment } from '../github/patch-reports.ts'
import { usageUnits, type SessionProgress } from '../agents/session-status.ts'
import { decideQuota } from '../quota/check.ts'
import { QuotaError } from '../quota/errors.ts'
import type { AgentRequest } from '../agents/types.ts'
import type { PipelineLogger, PipelinePorts, PipelineResult, RunStatus } from './types.ts'

const silent: PipelineLogger = { info() {} }

function pluginName(workdir: string): string {
  const pkgPath = join(workdir, 'package.json')
  if (!existsSync(pkgPath)) return 'plugin'
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (typeof pkg === 'object' && pkg !== null && typeof (pkg as { name?: unknown }).name === 'string') {
    return (pkg as { name: string }).name
  }
  return 'plugin'
}

function maybePublish(
  ports: PipelinePorts,
  status: RunStatus,
  extra: {
    skippedReview: boolean
    fixAttempts: number
    mechanical: PipelineResult['mechanical']
  },
  logger: PipelineLogger,
): Promise<PipelineResult['published']> {
  if (!ports.isDirty()) return Promise.resolve({})
  const github = ports.github
  if (github === undefined) {
    logger.info('worktree dirty but GitHub publish skipped (no token or --skip-github)')
    return Promise.resolve({})
  }
  const docs = renderDocuments({
    language: ports.config.issuePr.language,
    status,
    target: ports.target,
    pluginName: pluginName(ports.workdir),
    skippedReview: extra.skippedReview,
    fixAttempts: extra.fixAttempts,
    mechanical: extra.mechanical,
    verdictA: ports.store.read('A'),
    verdictB: ports.store.read('B'),
    fixes: ports.store.listFixReports(),
    diff: ports.diff(),
  })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const branch = `dsh-migrate/${ports.target.version}-${stamp}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
  return github.publish({
    title: docs.title,
    issueBody: docs.issue,
    prBody: docs.pr,
    branch,
    workdir: ports.workdir,
  }).then(async (published) => {
    if (published.issueNumber === undefined || github.commentIssue === undefined) {
      return published
    }
    const reports = collectPatchReports(ports.workdir)
    const comments = formatPatchReportComment({
      reports,
      pullRequestUrl: published.pullRequestUrl,
      language: ports.config.issuePr.language,
    })
    for (const body of comments) {
      await github.commentIssue(published.issueNumber, body, ports.workdir)
    }
    for (const report of reports) {
      if (report.kind !== 'draft') continue
      await github.commentIssue(
        published.issueNumber,
        formatOfficialDiscussionInvite({
          report,
          language: ports.config.issuePr.language,
        }),
        ports.workdir,
      )
    }
    return published
  })
}

async function ensureQuota(
  ports: PipelinePorts,
  logger: PipelineLogger,
  stage: string,
  used: number,
): Promise<void> {
  if (ports.quota === undefined) return
  const snapshot = await ports.quota.query()
  const remaining = snapshot.remaining === undefined ? '-' : String(snapshot.remaining)
  const currency = snapshot.currency ?? ''
  logger.info(`stage: quota (${stage}) ${snapshot.kind} remaining ${remaining} ${currency} used ${used}`.trim())
  const decision = decideQuota({
    snapshot,
    used,
    ...(ports.config.quota.limit === undefined ? {} : { limit: ports.config.quota.limit }),
  })
  if (decision.action === 'abort') {
    throw new QuotaError(decision.reason, decision.message)
  }
}

function addUsage(used: number, usage: SessionProgress | undefined): number {
  return usage === undefined ? used : used + usageUnits(usage)
}

function agentInput(ports: PipelinePorts, used: number): Pick<AgentRequest, 'usageSoFar' | 'usageLimit'> {
  return {
    usageSoFar: used,
    ...(ports.config.quota.limit === undefined ? {} : { usageLimit: ports.config.quota.limit }),
  }
}

/**
 * Mechanical first, optional A+B review, mandatory retest, then C-loop.
 * A clean worktree never opens an Issue or PR.
 */
export async function runPipeline(
  ports: PipelinePorts,
  logger: PipelineLogger = silent,
): Promise<PipelineResult> {
  const prompts = resolvePrompts(ports.config, ports.harness)
  logger.info(`stage: target ${ports.target.tag}`)

  logger.info('stage: mechanical')
  let mechanical = ports.runMechanical()
  ports.store.write('mechanical', mechanical.errors || mechanical.log)
  logger.info(`mechanical: ${mechanical.ok ? 'pass' : 'fail'}`)

  const skipReview = mechanical.ok && ports.config.review.policy === 'skip-if-mechanical-pass'
  if (skipReview) {
    const published = await maybePublish(ports, mechanical.ok ? 'compatible' : 'failed', {
      skippedReview: true,
      fixAttempts: 0,
      mechanical,
    }, logger)
    return {
      status: ports.isDirty() ? 'migrated' : 'compatible',
      mechanical,
      published,
      runDir: ports.store.runDir,
      skippedReview: true,
      fixAttempts: 0,
    }
  }

  let used = 0

  logger.info('stage: review A (official overlap)')
  await ensureQuota(ports, logger, 'before A', used)
  const a = await ports.agent.run({
    kind: 'absorption',
    prompt: prompts.absorption,
    workdir: ports.workdir,
    dsh: ports.config.dsh,
    apiKey: ports.apiKey,
    ...agentInput(ports, used),
  })
  ports.store.write('A', a.report)
  used = addUsage(used, a.usage)

  logger.info('stage: review B (design alignment)')
  await ensureQuota(ports, logger, 'before B', used)
  const b = await ports.agent.run({
    kind: 'alignment',
    prompt: prompts.alignment,
    workdir: ports.workdir,
    dsh: ports.config.dsh,
    apiKey: ports.apiKey,
    ...agentInput(ports, used),
  })
  ports.store.write('B', b.report)
  used = addUsage(used, b.usage)

  logger.info('stage: mechanical (after A+B)')
  mechanical = ports.runMechanical()
  ports.store.write('mechanical', mechanical.errors || mechanical.log)
  logger.info(`mechanical after A+B: ${mechanical.ok ? 'pass' : 'fail'}`)

  let fixAttempts = 0
  while (!mechanical.ok && fixAttempts < ports.config.loop.maxAttempts) {
    fixAttempts += 1
    logger.info(`stage: repair C${fixAttempts}`)
    await ensureQuota(ports, logger, `before C${fixAttempts}`, used)
    const prior = ports.store.listFixReports()
    const prompt = assembleFixPrompt({
      template: prompts.fix,
      reportA: ports.store.read('A') ?? '',
      reportB: ports.store.read('B') ?? '',
      errors: mechanical.errors,
      priorFixes: prior,
      ...(ports.harness === undefined ? {} : { harness: ports.harness }),
    })
    const c = await ports.agent.run({
      kind: 'fix',
      prompt,
      workdir: ports.workdir,
      dsh: ports.config.dsh,
      apiKey: ports.apiKey,
      ...agentInput(ports, used),
    })
    ports.store.write(`C${fixAttempts}`, c.report)
    used = addUsage(used, c.usage)
    logger.info(`stage: mechanical (after C${fixAttempts})`)
    mechanical = ports.runMechanical()
    ports.store.write('mechanical', mechanical.errors || mechanical.log)
  }

  const status: RunStatus = !mechanical.ok
    ? 'failed'
    : ports.isDirty()
      ? 'migrated'
      : 'compatible'

  const published = await maybePublish(ports, status, { skippedReview: false, fixAttempts, mechanical }, logger)
  return {
    status,
    mechanical,
    published,
    runDir: ports.store.runDir,
    skippedReview: false,
    fixAttempts,
  }
}
