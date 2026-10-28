import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets, traceSecrets } from '../agents/session-trace.ts'
import { LangfuseExporter, langfuseSettings, traceIdFor } from './langfuse.ts'
import { buildRunManifest, manifestPath, serializeManifest, sha256, type RunManifest } from './manifest.ts'
import type { ManifestCheck, SessionObserver, SessionRecord } from './session.ts'
import type { StateStore } from '../state/store.ts'
import type { MigrationView } from '../workflow/projection.ts'
import type { AgentConfig } from '../config/schema.ts'

/**
 * Collect one run's sessions and checks, then write its manifest and export
 * its trace. A manifest write or Langfuse export is evidence, never a reason a
 * migration fails.
 */
export interface RunRecorderOptions {
  runId: string
  runUrl?: string | undefined
  plugin: string[]
  agent: AgentConfig
  startedAt: string
  langfuse?: LangfuseExporter | undefined
  evaluation?: { harborJob?: string | undefined; trialId?: string | undefined; record?: string | undefined } | undefined
  log?: ((message: string) => void) | undefined
}

export class RunRecorder implements SessionObserver {
  private readonly sessions: SessionRecord[] = []
  private readonly checks: ManifestCheck[] = []
  private readonly runId: string
  private readonly runUrl: string | undefined
  private readonly plugin: string[]
  private readonly agent: AgentConfig
  private readonly startedAt: string
  private readonly langfuse: LangfuseExporter | undefined
  private readonly evaluation: RunRecorderOptions['evaluation']
  private readonly log: ((message: string) => void) | undefined

  constructor(options: RunRecorderOptions) {
    this.runId = options.runId
    this.runUrl = options.runUrl
    this.plugin = options.plugin
    this.agent = options.agent
    this.startedAt = options.startedAt
    this.langfuse = options.langfuse
    this.evaluation = options.evaluation
    this.log = options.log
  }

  record(session: SessionRecord): void {
    // The state branch is a durable copy: known credentials are removed before
    // the prompt text and its hash leave the job. Langfuse applies its own
    // redaction independently at the egress.
    const prompt = redactSecrets(session.prompt, traceSecrets(process.env))
    this.sessions.push({ ...session, prompt, promptSha256: sha256(prompt) })
  }

  recordCheck(check: ManifestCheck): void {
    this.checks.push(check)
  }

  /** Prompt text and observations stay in the run directory; the manifest keeps hashes. */
  private writeEvidence(runDir: string): void {
    mkdirSync(join(runDir, 'prompts'), { recursive: true })
    mkdirSync(join(runDir, 'observations'), { recursive: true })
    for (const session of this.sessions) {
      writeFileSync(join(runDir, 'prompts', `${session.promptSha256}.md`), session.prompt)
      writeFileSync(
        join(runDir, 'observations', `${session.name}.jsonl`),
        session.observations.map(observation => `${JSON.stringify(observation)}\n`).join(''),
      )
    }
  }

  private manifest(input: {
    migrationId: string
    view: MigrationView
    traceId?: string | undefined
    traceExported?: boolean | undefined
  }): RunManifest {
    const source = input.view.context.input.source?.release
    return buildRunManifest({
      runId: this.runId,
      ...(this.runUrl === undefined ? {} : { runUrl: this.runUrl }),
      migrationId: input.migrationId,
      plugin: this.plugin,
      ...(source === undefined ? {} : { source }),
      target: input.view.target,
      agent: this.agent,
      sessions: this.sessions,
      checks: this.checks,
      outcome: input.view.state,
      state: input.view.state,
      ...(this.evaluation === undefined ? {} : { evaluation: this.evaluation }),
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.traceExported === undefined ? {} : { traceExported: input.traceExported }),
    })
  }

  private changes(manifest: RunManifest, migrationId: string): Map<string, string> {
    const changes = new Map<string, string>([[manifestPath(migrationId, this.runId), serializeManifest(manifest)]])
    for (const session of this.sessions) changes.set(`prompts/${session.promptSha256}.md`, session.prompt)
    return changes
  }

  /** Write to the state branch, retrying once on a conflict with a fresh tip. */
  private writeState(store: StateStore, migrationId: string, manifest: RunManifest): void {
    try {
      let written = store.write(store.refresh(), this.changes(manifest, migrationId), `dsh-migrate: ${migrationId} manifest ${this.runId}`)
      if (!written.ok) {
        written = store.write(store.refresh(), this.changes(manifest, migrationId), `dsh-migrate: ${migrationId} manifest ${this.runId}`)
      }
      if (!written.ok) this.log?.(`manifest: state branch write failed (${written.reason}): ${written.detail}`)
    } catch (error) {
      this.log?.(`manifest: state branch write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async flush(input: {
    store?: StateStore | undefined
    migrationId: string
    runDir: string
    view: MigrationView
  }): Promise<RunManifest> {
    const traceId = this.langfuse?.traceId(this.runId, this.plugin.join(','))
    let manifest = this.manifest({ migrationId: input.migrationId, view: input.view, ...(traceId === undefined ? {} : { traceId }) })

    this.writeEvidence(input.runDir)
    // Write the manifest before the network call: a hung or failed export must
    // not cost the run its evidence.
    writeFileSync(join(input.runDir, 'manifest.json'), serializeManifest(manifest))
    if (input.store !== undefined) this.writeState(input.store, input.migrationId, manifest)

    if (this.langfuse !== undefined) {
      const result = await this.langfuse.export(manifest, this.sessions)
      manifest = this.manifest({
        migrationId: input.migrationId,
        view: input.view,
        ...(traceId === undefined ? {} : { traceId }),
        traceExported: result.exported,
      })
      writeFileSync(join(input.runDir, 'manifest.json'), serializeManifest(manifest))
      if (input.store !== undefined) this.writeState(input.store, input.migrationId, manifest)
      if (!result.exported) this.log?.(`langfuse: trace ${traceIdFor(this.runId)} was not exported: ${result.detail ?? 'unknown error'}`)
    }
    return manifest
  }
}

/** The exporter for the environment, or nothing when its three variables are unset. */
export function recorderFor(input: {
  runId: string
  runUrl?: string | undefined
  plugin: string[]
  agent: AgentConfig
  env: NodeJS.ProcessEnv
  log?: ((message: string) => void) | undefined
}): RunRecorder {
  const settings = langfuseSettings(input.env)
  const langfuse = settings === undefined ? undefined : new LangfuseExporter(settings)
  const evaluation = evaluationFromEnv(input.env)
  if (settings !== undefined) input.log?.('langfuse: tracing this run')
  return new RunRecorder({
    runId: input.runId,
    ...(input.runUrl === undefined ? {} : { runUrl: input.runUrl }),
    plugin: input.plugin,
    agent: input.agent,
    startedAt: new Date().toISOString(),
    ...(langfuse === undefined ? {} : { langfuse }),
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(input.log === undefined ? {} : { log: input.log }),
  })
}

function evaluationFromEnv(env: NodeJS.ProcessEnv): RunRecorderOptions['evaluation'] {
  const value = (name: string): string | undefined => {
    const found = env[name]
    return found === undefined || found === '' ? undefined : found
  }
  const harborJob = value('DSH_MIGRATE_HARBOR_JOB')?.trim()
  const trialId = value('DSH_MIGRATE_HARBOR_TRIAL')?.trim()
  const rawRecord = value('DSH_MIGRATE_HARBOR_RECORD')?.trim()
  const record = rawRecord === undefined || /^https?:\/\//i.test(rawRecord) || /^[A-Za-z0-9._/-]+$/.test(rawRecord) ? rawRecord : undefined
  if (harborJob === undefined && trialId === undefined && record === undefined) return undefined
  return {
    ...(harborJob === undefined ? {} : { harborJob }),
    ...(trialId === undefined ? {} : { trialId }),
    ...(record === undefined ? {} : { record }),
  }
}
