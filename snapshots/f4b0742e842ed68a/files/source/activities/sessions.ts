import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleRepairPrompt, cardLedgerNote, EXTENSION_POINTS_PROMPT, OVERLAP_PROMPT, REPAIR_PROMPT, withHarnessContext } from '../prompts/migration.ts'
import { cardsInSpan, ledgerPathOf, renderCardList } from '../skills/cards.ts'
import { checkoutHarness } from '../harness/checkout.ts'
import { decideQuota } from '../quota/check.ts'
import { isQuotaError } from '../quota/errors.ts'
import { parseBlocker } from '../verify/blocker.ts'
import { describeBaseline } from '../domain/outcome.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { SessionProgress } from '../agents/session-status.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { QuotaQuery } from '../quota/types.ts'
import type { ActivityRequest, MigrationContext } from '../workflow/machine.ts'
import type { MigrationEvent, SessionUsage } from '../workflow/model.ts'

/**
 * The review and repair sessions.
 *
 * Before each session the spend cap is checked against what this migration has
 * spent so far; a breach is reported as the session's outcome and no session
 * runs. A session's report is kept in the run directory for the next session's
 * prompt and returned to be stored on the state branch for the merge report.
 */

export function usageOf(progress: SessionProgress | undefined): SessionUsage | undefined {
  if (progress === undefined) return undefined
  return {
    inputTokens: progress.inputTokens,
    outputTokens: progress.outputTokens,
    cacheHitTokens: progress.cacheHitTokens,
    ...(progress.costUsd === undefined ? {} : { usd: progress.costUsd }),
  }
}

export interface SessionDeps {
  workdir: string
  config: MigrateConfig
  apiKey: string
  agent: AgentRunner
  quota: QuotaQuery | undefined
  runDir: string
  harnessDir: string
  /** Load or unload the community upgrade skills for the next session. */
  syncSkills: (enabled: boolean) => void
  log: (message: string) => void
  /** The full output of the last failing check. */
  lastFailure: () => string
  /** The upgrade skill's release files (`references/`), for the change cards. */
  cardsDir?: string | undefined
}

export class SessionRunner {
  /** USD this migration has spent on sessions so far. */
  spent = 0
  private harness: { path: string; tag: string } | null | undefined
  private readonly reports = new Map<string, string>()

  constructor(private readonly deps: SessionDeps) {}

  /** The spend-cap check; the reason when the next session may not run. */
  async capReached(): Promise<string | undefined> {
    if (this.deps.quota === undefined) return undefined
    const snapshot = await this.deps.quota.query({ apiKey: this.deps.apiKey })
    const decision = decideQuota({
      snapshot,
      used: this.spent,
      ...(this.deps.config.quota.limit === undefined ? {} : { limit: this.deps.config.quota.limit }),
    })
    return decision.action === 'abort' ? decision.message : undefined
  }

  /** The sparse harness checkout of the target release, made once per run. */
  private harnessFor(context: MigrationContext): { path: string; tag: string } | undefined {
    if (this.harness === undefined) {
      const tag = context.input.target.tag
      const checkout = checkoutHarness({ tag, dest: this.deps.harnessDir, timeoutMs: this.deps.config.timeouts.checkoutMs })
      if (!checkout.ok) this.deps.log(`harness checkout of ${tag} failed; sessions run without it: ${checkout.detail ?? ''}`)
      this.harness = checkout.ok ? { path: checkout.path, tag } : null
    }
    return this.harness ?? undefined
  }

  /** The change cards this migration crosses and how to keep their ledger, or nothing when the cards check is off. */
  private cards(context: MigrationContext): string {
    const source = context.input.source?.release.version
    if (!context.input.settings.checks.cards || source === undefined || this.deps.cardsDir === undefined) return ''
    const cards = cardsInSpan(this.deps.cardsDir, source, context.input.target.version)
    if (cards.length === 0) return ''
    return `\n\n${cardLedgerNote({ cards: renderCardList(cards), source, target: context.input.target.version, path: ledgerPathOf(this.deps.runDir) })}`
  }

  private prompt(request: Extract<ActivityRequest, { activity: 'session' }>, context: MigrationContext): string {
    const harness = this.harnessFor(context)
    const prompts = this.deps.config.prompts
    switch (request.kind) {
      case 'overlap':
        return withHarnessContext(prompts.overlap ?? OVERLAP_PROMPT, harness)
      case 'extension-points':
        return withHarnessContext(prompts.extensionPoints ?? EXTENSION_POINTS_PROMPT, harness) + this.cards(context)
      case 'repair':
        return assembleRepairPrompt({
          template: prompts.repair ?? REPAIR_PROMPT,
          overlapReport: this.reports.get('overlap') ?? '',
          extensionPointsReport: this.reports.get('extension-points') ?? '',
          failingOutput: this.deps.lastFailure(),
          priorRepairs: [...this.reports.entries()].filter(([name]) => name.startsWith('repair-')).map(([, text]) => text),
          harness,
          baselineNote: describeBaseline(context),
        }) + this.cards(context)
    }
  }

  async run(
    request: Extract<ActivityRequest, { activity: 'session' }>,
    context: MigrationContext,
  ): Promise<{ event: MigrationEvent; files: Map<string, string> }> {
    const files = new Map<string, string>()
    const done = (outcome: 'completed' | 'spend-cap' | 'failed', detail: string, extra: Partial<Extract<MigrationEvent, { type: 'session.done' }>> = {}) => ({
      event: { type: 'session.done' as const, kind: request.kind, outcome, blocker: 'none' as const, detail, ...extra },
      files,
    })
    const cap = await this.capReached()
    if (cap !== undefined) return done('spend-cap', cap)

    this.deps.syncSkills(this.deps.config.agent.upgradeSkills)
    let result
    try {
      result = await this.deps.agent.run({
        kind: request.kind,
        prompt: this.prompt(request, context),
        workdir: this.deps.workdir,
        agent: this.deps.config.agent,
        apiKey: this.deps.apiKey,
        usageSoFar: this.spent,
        ...(this.deps.config.quota.limit === undefined ? {} : { usageLimit: this.deps.config.quota.limit }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return done(isQuotaError(error) ? 'spend-cap' : 'failed', detail)
    }
    const usage = usageOf(result.usage)
    this.spent += usage?.usd ?? 0

    const name = request.kind === 'repair' ? `repair-${String(request.attempt)}` : request.kind
    this.reports.set(name, result.report)
    mkdirSync(join(this.deps.runDir, 'reports'), { recursive: true })
    writeFileSync(join(this.deps.runDir, 'reports', `${name}.md`), result.report)
    files.set(`reports/${name}.md`, result.report)

    const blocker = request.kind === 'repair' ? parseBlocker(result.report) : undefined
    return done('completed', blocker?.declared === true ? `upstream blocker declared${blocker.valid ? '' : ` without ${blocker.missing.join(', ')}`}` : '', {
      blocker: blocker === undefined || !blocker.declared ? 'none' : blocker.valid ? 'valid' : 'incomplete',
      report: `reports/${name}.md`,
      ...(usage === undefined ? {} : { usage }),
    })
  }
}
