import { join } from 'node:path'
import { readPluginName } from '../mechanical/run.ts'
import { isTreeChanged, changedPaths, treeDiff } from '../git/worktree.ts'
import { renderProposal } from '../github/templates.ts'
import { runReportChannel, type ReportDeps } from '../merge-reports/run.ts'
import { CheckRunner } from './checks.ts'
import { SessionRunner } from './sessions.ts'
import { authorE2ESuite } from './e2e-suite.ts'
import { publishProposal } from './proposal.ts'
import type { ActivityRunner } from '../engine.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { GitHubClient, Repository } from '../github/client.ts'
import type { QuotaQuery } from '../quota/types.ts'
import type { MigrationFiles } from '../merge-reports/evidence.ts'
import type { CheckName, CheckResult } from '../workflow/model.ts'

/**
 * The activities: the only code the engine calls that has effects. Each one
 * answers one {@link ActivityRequest} with the event the machine expects.
 */

export interface ActivityDeps {
  workdir: string
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  apiKey: string | undefined
  agent: AgentRunner
  quota: QuotaQuery | undefined
  /** Absent when the run may not touch GitHub. */
  github: { client: GitHubClient; repository: Repository; defaultBranch: string } | undefined
  /** The state branch, for the reports a merge report quotes. */
  files: MigrationFiles
  /** `DSH_MIGRATE_HOME`: dsh installations, the harness checkout, run directories. */
  home: string
  runId: string
  runUrl?: string | undefined
  syncSkills: (enabled: boolean) => void
  log: (message: string) => void
}

export function createActivities(deps: ActivityDeps): ActivityRunner {
  const runDir = join(deps.home, 'runs', deps.runId)
  const checks = new CheckRunner({ workdir: deps.workdir, config: deps.config, cacheDir: join(deps.home, 'dsh'), runDir })
  const latest = new Map<CheckName, CheckResult>()
  let sessions: SessionRunner | undefined
  const sessionRunner = (): SessionRunner => {
    if (deps.apiKey === undefined) throw new Error(`${deps.config.secrets.apiKeyEnv} is not set, so no agent session can run`)
    sessions ??= new SessionRunner({
      workdir: deps.workdir,
      config: deps.config,
      apiKey: deps.apiKey,
      agent: deps.agent,
      quota: deps.quota,
      runDir,
      harnessDir: join(deps.home, 'harness'),
      syncSkills: deps.syncSkills,
      log: deps.log,
      lastFailure: () => checks.lastFailure?.output ?? '',
    })
    return sessions
  }
  const reports: Map<string, string> = new Map()

  return async (request, context) => {
    switch (request.activity) {
      case 'check': {
        const release = request.release === 'source' ? context.input.source?.release : context.input.target
        if (release === undefined) throw new Error('a source boot check was requested without a source release')
        const result = await checks.run(request, release)
        if (request.release === 'target') latest.set(request.check, result)
        return { event: { type: 'check.done', result } }
      }
      case 'session': {
        const result = await sessionRunner().run(request, context)
        for (const [path, text] of result.files) reports.set(path, text)
        return result
      }
      case 'authorE2E':
        return {
          event: await authorE2ESuite({ workdir: deps.workdir, config: deps.config, agent: deps.agent, apiKey: deps.apiKey ?? '', runDir }, context),
        }
      case 'inspectTree':
        return { event: { type: 'tree.inspected', changed: isTreeChanged(deps.workdir), files: changedPaths(deps.workdir).length } }
      case 'publishProposal': {
        if (deps.github === undefined) throw new Error('publishing needs a GitHub token')
        const repairs = [...reports.entries()].filter(([path]) => path.startsWith('reports/repair-')).map(([, text]) => text)
        const documents = renderProposal({
          context,
          pluginName: readPluginName(deps.workdir),
          checks: [...latest.values()],
          reports: { overlap: reports.get('reports/overlap.md'), extensionPoints: reports.get('reports/extension-points.md'), repairs },
          diff: treeDiff(deps.workdir),
          runUrl: deps.runUrl,
        })
        return await publishProposal({ workdir: deps.workdir, github: deps.github.client, repository: deps.github.repository, defaultBranch: deps.github.defaultBranch }, context, documents)
      }
      case 'deliverReport': {
        if (deps.github === undefined) throw new Error('a merge report needs a GitHub token')
        const reportDeps: ReportDeps = {
          config: deps.config,
          env: deps.env,
          repository: deps.github.repository,
          github: deps.github.client,
          files: deps.files,
          agent: deps.agent,
          apiKey: deps.apiKey,
          workdir: deps.workdir,
          syncSkills: deps.syncSkills,
        }
        const outcome = await runReportChannel(request.channel, { id: context.input.target.version, context }, reportDeps, 'deliver')
        return {
          event: {
            type: 'report.done',
            channel: request.channel,
            outcome: outcome.outcome === 'dry-run' ? 'skipped' : outcome.outcome,
            detail: outcome.detail,
            ...(outcome.url === undefined ? {} : { url: outcome.url }),
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          },
        }
      }
    }
  }
}
