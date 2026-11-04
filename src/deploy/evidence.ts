/**
 * Send the run evidence bundle to the deploy service after a migration.
 *
 * The state branch remains the source of record. The bundle is a bounded,
 * read-only current-run snapshot with a migration history index that lets the benchmark site open the same prompts and
 * workflows through one authenticated URL. Uploading is best effort: an absent
 * or failing service is one log line and never fails a migration.
 */

import type { MigrateConfig } from '../config/schema.ts'
import { readInspectData, type MigrationFiles } from '../observability/evidence.ts'
import { EVIDENCE_URL_LIMIT, externalUrl, inline } from '../render/text.ts'
import { deployRequest, resolveDeployService } from './client.ts'

export interface EvidenceUpload {
  config: MigrateConfig
  env: NodeJS.ProcessEnv
  runId: string
  repository: string
  migrationId: string
  store: MigrationFiles
  log: (message: string) => void
  /** Injected for tests; the deploy request otherwise uses the platform fetch. */
  fetchImpl?: typeof fetch | undefined
  /** Finish the evidence-only run before uploading; the log stream owns sealing otherwise. */
  seal?: boolean
  /** Whether the evidence-only finish is complete; false when repairing a run with no log. */
  sealComplete?: boolean
  /** Preserve the original run open time when repairing an old skipped run. */
  openedAt?: string
}

/**
 * Upload one migration's evidence and return the URL the service named.
 * @param input - the run, its store, and the deploy configuration.
 */
export async function publishRunEvidence(input: EvidenceUpload): Promise<string | undefined> {
  const service = resolveDeployService(input.config, input.env)
  if ('reason' in service) {
    if (input.config.deploy.enabled) input.log(`run evidence: ${service.reason}`)
    return undefined
  }
  let data
  try {
    data = readInspectData(input.store, input.migrationId, input.runId)
  } catch (error) {
    input.log(`run evidence: ${inline(error instanceof Error ? error.message : String(error), 300)}`)
    return undefined
  }
  if (!data.runs.some(run => run.runId === input.runId)) {
    input.log('run evidence: the current run manifest is absent')
    return undefined
  }
  const opened = await deployRequest({
    service,
    method: 'POST',
    path: '/runs',
    body: { runId: input.runId, repository: input.repository, kind: 'migration', ...(input.openedAt === undefined ? {} : { openedAt: input.openedAt }) },
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  if (!opened.ok) {
    input.log(`run evidence: ${opened.reason}`)
    return undefined
  }
  if (input.seal === true) {
    const finish = () => deployRequest({
      service,
      method: 'POST',
      path: `/runs/${encodeURIComponent(input.runId)}/finish`,
      body: { events: 0, attempted: 0, complete: input.sealComplete ?? true },
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    })
    let sealed = await finish()
    if (!sealed.ok) sealed = await finish()
    if (!sealed.ok) {
      input.log(`run evidence: the evidence-only run could not be sealed: ${sealed.reason}`)
      return undefined
    }
  }
  const sent = await deployRequest({
    service,
    method: 'POST',
    path: `/runs/${encodeURIComponent(input.runId)}/evidence`,
    body: data,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  if (!sent.ok) {
    input.log(`run evidence: ${sent.reason}`)
    return undefined
  }
  const named = (sent.body as { url?: unknown } | undefined)?.url
  if (typeof named !== 'string') {
    input.log('run evidence: stored, but the service named no URL')
    return undefined
  }
  const safe = externalUrl(named, EVIDENCE_URL_LIMIT)
  if (safe === undefined) {
    input.log('run evidence: the service named an unsafe URL')
    return undefined
  }
  input.log(`run evidence: ${safe}`)
  return safe
}
