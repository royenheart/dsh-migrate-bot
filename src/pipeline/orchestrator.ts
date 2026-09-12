import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleFixPrompt } from '../prompts/migrate/index.ts'
import { resolvePrompts } from '../prompts/resolve.ts'
import { renderDocuments } from '../github/templates.ts'
import { formatOfficialDiscussionInvite } from '../github/discussions.ts'
import { collectPatchReports, formatPatchReportComment } from '../github/patch-reports.ts'
import { usageUnits, type SessionProgress } from '../agents/session-status.ts'
import { decideQuota } from '../quota/check.ts'
import { QuotaError } from '../quota/errors.ts'
import { describeBlocker, parseBlocker } from '../verify/blocker.ts'
import { signatureStalled } from '../verify/baseline.ts'
import type { AgentRequest } from '../agents/types.ts'
import type {
  PipelineLogger,
  PipelinePorts,
  PipelineResult,
  RunStatus,
  VerificationResult,
} from './types.ts'

const silent: PipelineLogger = { info() {} }

const PASS: VerificationResult = { ok: true, layer: 'boot', signature: 'pass', detail: '' }

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
    verification?: VerificationResult | undefined
    attribution?: PipelineResult['attribution']
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
    ...(extra.verification === undefined ? {} : { verification: extra.verification }),
    ...(extra.attribution === undefined ? {} : { attribution: extra.attribution }),
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
 * One verification round: the boot probe first, then the E2E subset.
 *
 * Cheap layers run first and short-circuit: a tree that cannot boot has no
 * business spending minutes in a browser. Which layers exist is decided by the
 * ports (the caller owns config and binary availability).
 */
async function verifyRound(ports: PipelinePorts, mode: 'subset' | 'full'): Promise<VerificationResult> {
  // Report the deepest layer that actually ran, so a run whose last gate was
  // the web smoke says so instead of crediting the boot probe.
  let last: VerificationResult | undefined
  if (ports.probeTarget !== undefined) {
    last = await ports.probeTarget()
    if (!last.ok) return last
  }
  if (ports.probeWeb !== undefined && mode === 'full') {
    // The browser-free web smoke runs once, at final verification: it is a
    // composition fact, not something a mid-loop repair changes independently.
    const web = await ports.probeWeb()
    if (!web.ok) return web
    last = web
  }
  if (ports.runE2E !== undefined) {
    last = await ports.runE2E(mode)
    if (!last.ok) return last
  }
  return last ?? { ...PASS, skipped: 'no verification layer is enabled' }
}

/**
 * V1 fast gate, optional A+B review, then a repair loop whose each round
 * re-verifies through V2/V3, and a full V4 pass before publishing.
 *
 * The loop always keeps its full budget: a plugin several corridors behind is
 * the common case, and stopping it early would refuse the job exactly when it
 * is needed. It stops early only on evidence — a stalled failure signature or
 * an evidence-backed upstream blocker — and never on a guess about the cause.
 */
export async function runPipeline(
  ports: PipelinePorts,
  logger: PipelineLogger = silent,
): Promise<PipelineResult> {
  const prompts = resolvePrompts(ports.config, ports.harness)
  logger.info(`stage: target ${ports.target.tag}`)
  if (ports.attribution !== undefined) logger.info(`baseline: ${ports.attribution.summary}`)

  logger.info('stage: fast gate (V1)')
  let mechanical = ports.runMechanical()
  ports.store.write('mechanical', mechanical.errors || mechanical.log)
  logger.info(`fast gate: ${mechanical.ok ? 'pass' : 'fail'}`)

  const skipReview = mechanical.ok && ports.config.review.policy === 'skip-if-mechanical-pass'
  if (skipReview) {
    const published = await maybePublish(ports, 'compatible', {
      skippedReview: true,
      fixAttempts: 0,
      mechanical,
      ...(ports.attribution === undefined ? {} : { attribution: ports.attribution }),
    }, logger)
    return {
      status: ports.isDirty() ? 'migrated' : 'compatible',
      mechanical,
      published,
      runDir: ports.store.runDir,
      skippedReview: true,
      fixAttempts: 0,
      ...(ports.attribution === undefined ? {} : { attribution: ports.attribution }),
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

  // V1 again: A+B edited the tree, so the cheap gate has to agree before the
  // expensive layers are worth running.
  mechanical = ports.runMechanical()
  ports.store.write('mechanical', mechanical.errors || mechanical.log)
  logger.info(`fast gate after A+B: ${mechanical.ok ? 'pass' : 'fail'}`)

  let verification = mechanical.ok ? await verifyRound(ports, 'subset') : {
    ok: false,
    layer: 'boot' as const,
    signature: 'fast-gate: typecheck or unit tests failed',
    detail: mechanical.errors,
  }
  ports.store.write('verification', verification.detail || verification.signature)
  logger.info(`verify after A+B: ${verification.layer} ${verification.ok ? 'pass' : 'fail'}`)

  let fixAttempts = 0
  let stoppedBy: PipelineResult['stoppedBy'] = 'budget'
  let previousSignature: string | undefined

  while (!verification.ok && fixAttempts < ports.config.loop.maxAttempts) {
    if (signatureStalled(previousSignature, verification.signature)) {
      logger.info(`repair loop stopped: failure signature unchanged (${verification.signature})`)
      stoppedBy = 'stalled'
      break
    }
    previousSignature = verification.signature

    fixAttempts += 1
    logger.info(`stage: repair C${fixAttempts}`)
    await ensureQuota(ports, logger, `before C${fixAttempts}`, used)
    const prior = ports.store.listFixReports()
    const prompt = assembleFixPrompt({
      template: prompts.fix,
      reportA: ports.store.read('A') ?? '',
      reportB: ports.store.read('B') ?? '',
      errors: verification.detail,
      priorFixes: prior,
      ...(ports.harness === undefined ? {} : { harness: ports.harness }),
      ...(ports.attribution === undefined ? {} : { baselineNote: ports.attribution.summary }),
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

    const blocker = parseBlocker(c.report)
    if (blocker.declared) logger.info(describeBlocker(blocker))
    if (blocker.valid) {
      stoppedBy = 'blocker'
      break
    }

    mechanical = ports.runMechanical()
    ports.store.write('mechanical', mechanical.errors || mechanical.log)
    logger.info(`fast gate after C${fixAttempts}: ${mechanical.ok ? 'pass' : 'fail'}`)
    verification = mechanical.ok
      ? await verifyRound(ports, 'subset')
      : {
        ok: false,
        layer: 'boot' as const,
        signature: 'fast-gate: typecheck or unit tests failed',
        detail: mechanical.errors,
      }
    ports.store.write('verification', verification.detail || verification.signature)
    logger.info(`verify after C${fixAttempts}: ${verification.layer} ${verification.ok ? 'pass' : 'fail'}`)
  }

  // V4: a full pass once the loop converges, so a fix that repaired the last
  // failure but broke an earlier one cannot slip through.
  if (verification.ok) {
    logger.info('stage: full verification (V4)')
    verification = await verifyRound(ports, 'full')
    ports.store.write('verification', verification.detail || verification.signature)
    logger.info(`full verification: ${verification.ok ? 'pass' : 'fail'}`)
  }

  let e2eSync: PipelineResult['e2eSync']
  if (ports.syncE2E !== undefined) {
    logger.info('stage: E2E suite branch')
    try {
      e2eSync = await ports.syncE2E()
      logger.info(`E2E branch: ${e2eSync.pushed ? 'pushed' : `not pushed (${e2eSync.reason ?? 'unknown'})`}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      e2eSync = { ok: false, pushed: false, reason: 'failed', detail }
      logger.info(`E2E branch: failed (${detail})`)
    }
  }

  // `advisory` keeps an E2E failure visible in the report without failing the
  // run; `blocking` makes it a gate. V2 boot failures always fail the run.
  const e2eBlocking = ports.config.e2e.gate === 'blocking'
  const verificationBlocks = verification.ok || (verification.layer === 'e2e' && !e2eBlocking)
  const status: RunStatus = !(mechanical.ok && verificationBlocks)
    ? 'failed'
    : ports.isDirty()
      ? 'migrated'
      : 'compatible'

  const published = await maybePublish(ports, status, {
    skippedReview: false,
    fixAttempts,
    mechanical,
    verification,
    ...(ports.attribution === undefined ? {} : { attribution: ports.attribution }),
  }, logger)
  return {
    status,
    mechanical,
    published,
    runDir: ports.store.runDir,
    skippedReview: false,
    fixAttempts,
    verification,
    stoppedBy,
    ...(ports.attribution === undefined ? {} : { attribution: ports.attribution }),
    ...(e2eSync === undefined ? {} : { e2eSync }),
  }
}
