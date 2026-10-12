import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectE2EFramework, INDEX_FILE, readIndex, renderAuthoringBrief, syncE2EBranch } from '../e2e/branch.ts'
import { pluginNames } from '../plugins.ts'
import { defaultBranch } from '../git/worktree.ts'
import { usageOf } from './sessions.ts'
import type { AgentRunner } from '../agents/types.ts'
import type { MigrateConfig } from '../config/schema.ts'
import type { MigrationContext } from '../workflow/machine.ts'
import type { MigrationEvent } from '../workflow/model.ts'

/**
 * The end-to-end authoring activity: an agent session writes or extends the
 * suite into a staging directory, and the suite is pushed to its own branch.
 * Whatever happens, the migration goes on; a failure becomes a warning.
 */
export async function authorE2ESuite(deps: {
  workdir: string
  config: MigrateConfig
  agent: AgentRunner
  apiKey: string
  runDir: string
}, context: MigrationContext): Promise<MigrationEvent> {
  const staging = join(deps.runDir, 'e2e-draft')
  mkdirSync(staging, { recursive: true })
  const target = context.input.target.tag
  let usage
  try {
    const session = await deps.agent.run({
      kind: 'e2e-authoring',
      prompt: renderAuthoringBrief({
        workdir: deps.workdir,
        suiteDir: deps.config.checks.e2e.dir,
        framework: detectE2EFramework(deps.workdir),
        dshTag: target,
        pluginName: pluginNames(deps.workdir),
        stagingDir: staging,
      }),
      workdir: deps.workdir,
      agent: deps.config.agent,
      apiKey: deps.apiKey,
    })
    usage = usageOf(session.usage)
  } catch (error) {
    return { type: 'e2e.authored', outcome: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  const index = readIndex(join(staging, INDEX_FILE))
  if (index === undefined) {
    return { type: 'e2e.authored', outcome: 'failed', detail: 'the session staged no index.json', ...(usage === undefined ? {} : { usage }) }
  }
  const base = defaultBranch(deps.workdir)
  const synced = syncE2EBranch({
    workdir: deps.workdir,
    branch: deps.config.checks.e2e.branch,
    baseRef: deps.config.checks.e2e.baseRef === 'migration' ? `origin/${base}` : deps.config.checks.e2e.baseRef,
    defaultBranch: base,
    forceRebase: deps.config.checks.e2e.forceRebase,
    stagingDir: staging,
    worktreeDir: join(deps.runDir, 'e2e-branch'),
    index,
    tag: target,
  })
  return {
    type: 'e2e.authored',
    outcome: !synced.ok ? 'failed' : synced.pushed ? 'pushed' : 'unchanged',
    detail: synced.ok ? (synced.detail ?? '') : `${synced.reason ?? 'failed'}: ${synced.detail ?? ''}`,
    ...(usage === undefined ? {} : { usage }),
  }
}
