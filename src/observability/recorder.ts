import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LangfuseExporter, langfuseSettings, traceIdFor } from './langfuse.ts'
import { buildRunManifest, manifestPath, serializeManifest, type RunManifest } from './manifest.ts'
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
  private readonly log: ((message: string) => void) | undefined

  constructor(options: RunRecorderOptions) {
    this.runId = options.runId
    this.runUrl = options.runUrl
    this.plugin = options.plugin
    this.agent = options.agent
    this.startedAt = options.startedAt
    this.langfuse = options.langfuse
    this.log = options.log
  }

  record(session: SessionRecord): void {
    this.sessions.push(session)
  }

  recordCheck(check: ManifestCheck): void {
    this.checks.push(check)
  }

  /** Prompt text and observations stay in the run directory; the manifest keeps hashes. */
  private writeEvidence(runDir: string): void {
    mkdirSync(join(runDir, 'prompts'), { recursive: true })
    mkdirSync(join(runDir, 'observations'), { recursive: true })
    for (const session of this.sessions) {
      writeFileSync(join(runDir, 'prompts', `${session.promptSha256}.md`), `${session.prompt}\n`)
      writeFileSync(
        join(runDir, 'observations', `${session.name}.jsonl`),
        session.observations.map(observation => `${JSON.stringify(observation)}\n`).join(''),
      )
    }
  }

  async flush(input: {
    store?: StateStore | undefined
    migrationId: string
    runDir: string
    view: MigrationView
  }): Promise<RunManifest> {
    const target = input.view.target
    const source = input.view.context.input.source?.release
    const traceId = this.langfuse?.traceId(this.runId)
    let manifest = buildRunManifest({
      runId: this.runId,
      ...(this.runUrl === undefined ? {} : { runUrl: this.runUrl }),
      migrationId: input.migrationId,
      plugin: this.plugin,
      ...(source === undefined ? {} : { source }),
      target,
      agent: this.agent,
      sessions: this.sessions,
      checks: this.checks,
      outcome: input.view.state,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      ...(traceId === undefined ? {} : { traceId }),
    })

    this.writeEvidence(input.runDir)
    if (this.langfuse !== undefined) {
      const result = await this.langfuse.export(manifest, this.sessions)
      manifest = buildRunManifest({
        runId: this.runId,
        ...(this.runUrl === undefined ? {} : { runUrl: this.runUrl }),
        migrationId: input.migrationId,
        plugin: this.plugin,
        ...(source === undefined ? {} : { source }),
        target,
        agent: this.agent,
        sessions: this.sessions,
        checks: this.checks,
        outcome: input.view.state,
        startedAt: this.startedAt,
        endedAt: new Date().toISOString(),
        traceId,
        traceExported: result.exported,
      })
      if (!result.exported) this.log?.(`langfuse: trace ${traceIdFor(this.runId)} was not exported: ${result.detail ?? 'unknown error'}`)
    }

    writeFileSync(join(input.runDir, 'manifest.json'), serializeManifest(manifest))
    if (input.store !== undefined) {
      try {
        const snapshot = input.store.read()
        const changes = new Map<string, string>([[manifestPath(input.migrationId, this.runId), serializeManifest(manifest)]])
        for (const session of this.sessions) changes.set(`prompts/${session.promptSha256}.md`, `${session.prompt}\n`)
        const written = input.store.write(snapshot.tip, changes, `dsh-migrate: ${input.migrationId} manifest ${this.runId}`)
        if (!written.ok) this.log?.(`manifest: state branch write failed (${written.reason}): ${written.detail}`)
      } catch (error) {
        this.log?.(`manifest: state branch write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
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
  if (settings !== undefined) input.log?.('langfuse: tracing this run')
  return new RunRecorder({
    runId: input.runId,
    ...(input.runUrl === undefined ? {} : { runUrl: input.runUrl }),
    plugin: input.plugin,
    agent: input.agent,
    startedAt: new Date().toISOString(),
    ...(langfuse === undefined ? {} : { langfuse }),
    ...(input.log === undefined ? {} : { log: input.log }),
  })
}
