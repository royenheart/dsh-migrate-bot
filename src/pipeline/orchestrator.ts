import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleFixPrompt } from '../prompts/defaults.ts'
import { resolvePrompts } from '../prompts/resolve.ts'
import { renderDocuments } from '../github/templates.ts'
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
  if (ports.github === undefined) {
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
    diff: ports.diff(),
  })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const branch = `dsh-migrate/${ports.target.version}-${stamp}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
  return ports.github.publish({
    title: docs.title,
    issueBody: docs.issue,
    prBody: docs.pr,
    branch,
    workdir: ports.workdir,
  })
}

/**
 * Mechanical first, optional A+B review, mandatory retest, then C-loop.
 * A clean worktree never opens an Issue or PR.
 */
export async function runPipeline(
  ports: PipelinePorts,
  logger: PipelineLogger = silent,
): Promise<PipelineResult> {
  const prompts = resolvePrompts(ports.config)
  logger.info(`target ${ports.target.tag}`)

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

  logger.info('review A: official overlap')
  const a = await ports.agent.run({
    kind: 'absorption',
    prompt: prompts.absorption,
    workdir: ports.workdir,
    dsh: ports.config.dsh,
    apiKey: ports.apiKey,
  })
  ports.store.write('A', a.report)

  logger.info('review B: design alignment')
  const b = await ports.agent.run({
    kind: 'alignment',
    prompt: prompts.alignment,
    workdir: ports.workdir,
    dsh: ports.config.dsh,
    apiKey: ports.apiKey,
  })
  ports.store.write('B', b.report)

  mechanical = ports.runMechanical()
  ports.store.write('mechanical', mechanical.errors || mechanical.log)
  logger.info(`mechanical after A+B: ${mechanical.ok ? 'pass' : 'fail'}`)

  let fixAttempts = 0
  while (!mechanical.ok && fixAttempts < ports.config.loop.maxAttempts) {
    fixAttempts += 1
    logger.info(`repair C${fixAttempts}`)
    const prior = ports.store.listFixReports()
    const prompt = assembleFixPrompt({
      template: prompts.fix,
      reportA: ports.store.read('A') ?? '',
      reportB: ports.store.read('B') ?? '',
      errors: mechanical.errors,
      priorFixes: prior,
    })
    const c = await ports.agent.run({
      kind: 'fix',
      prompt,
      workdir: ports.workdir,
      dsh: ports.config.dsh,
      apiKey: ports.apiKey,
    })
    ports.store.write(`C${fixAttempts}`, c.report)
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
