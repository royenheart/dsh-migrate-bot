import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { publishSuite, readSuite, renderAuthoringBrief, runSuite, writeLedger } from '../e2e/suite.ts'
import { restoreTree, snapshotTree } from '../git/worktree.ts'
import { pluginNames } from '../plugins.ts'
import { inline } from '../render/text.ts'
import { startWebHost, hasClientSurface } from '../verify/web.ts'
import { usageOf } from './sessions.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { MigrationContext } from '../workflow/machine.ts'
import type { MigrationEvent, Release } from '../workflow/model.ts'

/**
 * The end-to-end activities: recording the end-to-end baseline on the source
 * release before the migration changes anything, and publishing the suite on
 * its branch once the migration passed.
 */

export interface E2EDeps {
  workdir: string
  config: MigrateConfig
  agent: AgentRunner
  apiKey: string
  runDir: string
  /** The dsh binary of a release, or why it could not be installed. */
  install: (release: Release) => { bin: string } | { failure: string }
}

/** Where this run keeps the suite, from the branch or as a session wrote it. */
export const suiteDirOf = (runDir: string): string => join(runDir, 'e2e-suite')

/**
 * Have a session write or extend the suite while a `dsh web` of `release` serves
 * the tree. The session works in the suite; whatever it leaves in the served
 * tree is put back, so the tree is what the migration made of it.
 */
async function authorSuite(deps: E2EDeps, release: Release, existing: boolean, url: string): Promise<{ usage?: ReturnType<typeof usageOf> } | { failure: string }> {
  const tree = snapshotTree(deps.workdir)
  try {
    const session = await deps.agent.run({
      kind: 'e2e-authoring',
      prompt: renderAuthoringBrief({ suiteDir: suiteDirOf(deps.runDir), plugins: pluginNames(deps.workdir), release: release.tag, existing }),
      // The session works in the suite; the plugins it tests are served, not edited.
      workdir: suiteDirOf(deps.runDir),
      agent: deps.config.agent,
      apiKey: deps.apiKey,
      env: { DSH_MIGRATE_WEB_URL: url },
    })
    return { usage: usageOf(session.usage) }
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) }
  } finally {
    restoreTree(deps.workdir, tree)
  }
}

/**
 * Run the suite against the unmodified tree on the source release, writing it
 * first when the branch has none. The tests that pass are the end-to-end
 * baseline: what the plugins did before the migration.
 */
export async function characterize(deps: E2EDeps, context: MigrationContext): Promise<MigrationEvent> {
  const event = (outcome: 'characterized' | 'skipped' | 'failed', detail: string, baseline: string[] = [], usage?: ReturnType<typeof usageOf>): MigrationEvent =>
    ({ type: 'e2e.characterized', outcome, baseline, detail, ...(usage === undefined ? {} : { usage }) })
  const source = context.input.source?.release
  if (source === undefined) return event('skipped', 'no source release is known')
  if (!hasClientSurface(deps.workdir)) return event('skipped', 'no plugin has a browser half (dsh.client)')
  const installed = deps.install(source)
  if ('failure' in installed) return event('skipped', installed.failure)
  const suiteDir = suiteDirOf(deps.runDir)
  rmSync(suiteDir, { recursive: true, force: true })
  const existing = readSuite({ workdir: deps.workdir, branch: deps.config.checks.e2e.branch, dir: deps.config.checks.e2e.dir, dest: suiteDir })
  const served = await startWebHost({ workdir: deps.workdir, bin: installed.bin, timeoutMs: deps.config.checks.web.timeoutMs, dshTag: source.tag })
  if (!served.ok) return event('skipped', `the source release does not serve the plugins: ${served.failure.signature}`)
  let usage: ReturnType<typeof usageOf>
  try {
    if (!existing) {
      mkdirSync(suiteDir, { recursive: true })
      const authored = await authorSuite(deps, source, false, served.host.url)
      if ('failure' in authored) return event('failed', authored.failure)
      usage = authored.usage
    }
    const run = runSuite({ suiteDir, webUrl: served.host.url, timeoutMs: deps.config.timeouts.commandMs })
    if (run.error !== undefined) return event('failed', run.error, [], usage)
    if (run.passed.length === 0) return event('failed', 'no test of the suite passes on the source release', [], usage)
    writeLedger(suiteDir, source.tag)
    return event('characterized', `${String(run.passed.length)} test(s) pass on ${source.tag}${run.failed.length === 0 ? '' : `; ${String(run.failed.length)} do not and are not part of the baseline`}`, run.passed, usage)
  } finally {
    served.host.stop()
  }
}

/**
 * Publish the suite on its branch, after the migration concluded. A suite that
 * recorded a baseline is published as it is; without one, a session writes or
 * extends it against the migrated tree on the target release first.
 */
export async function publishE2E(deps: E2EDeps, context: MigrationContext): Promise<MigrationEvent> {
  // The proposal is already out, so a failure here is a warning, never an error of the migration.
  try {
    return await publishSuiteOf(deps, context)
  } catch (error) {
    return { type: 'e2e.published', outcome: 'failed', detail: inline(error instanceof Error ? error.message : String(error), 300) }
  }
}

async function publishSuiteOf(deps: E2EDeps, context: MigrationContext): Promise<MigrationEvent> {
  const event = (outcome: 'pushed' | 'unchanged' | 'failed', detail: string, usage?: ReturnType<typeof usageOf>): MigrationEvent =>
    ({ type: 'e2e.published', outcome, detail, ...(usage === undefined ? {} : { usage }) })
  const target = context.input.target
  const suiteDir = suiteDirOf(deps.runDir)
  let usage: ReturnType<typeof usageOf>
  if (context.e2eBaseline.length === 0) {
    const installed = deps.install(target)
    if ('failure' in installed) return event('failed', installed.failure)
    rmSync(suiteDir, { recursive: true, force: true })
    const existing = readSuite({ workdir: deps.workdir, branch: deps.config.checks.e2e.branch, dir: deps.config.checks.e2e.dir, dest: suiteDir })
    const served = await startWebHost({ workdir: deps.workdir, bin: installed.bin, timeoutMs: deps.config.checks.web.timeoutMs, dshTag: target.tag })
    if (!served.ok) return event('failed', `the target release does not serve the plugins: ${served.failure.signature}`)
    try {
      mkdirSync(suiteDir, { recursive: true })
      const authored = await authorSuite(deps, target, existing, served.host.url)
      if ('failure' in authored) return event('failed', authored.failure)
      usage = authored.usage
    } finally {
      served.host.stop()
    }
    writeLedger(suiteDir, target.tag)
  }
  if (!existsSync(join(suiteDir, 'package.json'))) return event('failed', 'no suite was written', usage)
  const published = publishSuite({
    workdir: deps.workdir,
    branch: deps.config.checks.e2e.branch,
    dir: deps.config.checks.e2e.dir,
    suiteDir,
    message: `test(e2e): the suite as checked against ${target.tag}`,
  })
  return event(published.outcome, published.detail, usage)
}
