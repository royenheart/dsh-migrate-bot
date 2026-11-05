import { runManifestSchema, sha256, type RunManifest } from './manifest.ts'
import { compareReleases } from '../domain/release.ts'

/**
 * Read the live-run evidence a state branch holds. This is the shared reader
 * behind `dsh-migrate inspect`; a future workflow framework can produce the
 * same shape without changing the UI.
 */

export interface MigrationFiles {
  list(directory: string): string[]
  readFile(path: string): string | undefined
}

export interface RunEvidence {
  runId: string
  manifest: RunManifest
  /** Session name to the prompt text the state branch stores by hash. */
  prompts: Record<string, string>
}

export interface RunSummary {
  runId: string
  startedAt: string
}

export interface InspectData {
  migrationId: string
  runs: RunEvidence[]
  /** Every run of the migration, including runs not included in `runs`. */
  history: RunSummary[]
  /** Runs that exist but could not be read, and prompt mismatches. */
  warnings: string[]
}

export function migrationIds(files: MigrationFiles): string[] {
  const ids = files.list('migrations')
    .flatMap(path => {
      const parts = path.split('/')
      return parts.length >= 2 && parts[0] === 'migrations' && parts[1] !== undefined ? [parts[1]] : []
    })
  return [...new Set(ids)].sort((left, right) => {
    try {
      return compareReleases({ tag: left, version: left }, { tag: right, version: right })
    } catch {
      return left.localeCompare(right)
    }
  })
}

export function readRunEvidence(files: MigrationFiles, migrationId: string, warnings: string[] = [], promptRunId?: string | undefined): RunEvidence[] {
  const runs: RunEvidence[] = []
  for (const path of files.list(`migrations/${migrationId}/runs`).sort()) {
    if (!path.endsWith('/manifest.json')) continue
    const text = files.readFile(path)
    if (text === undefined) {
      warnings.push(`${path}: unreadable`)
      continue
    }
    let manifest: RunManifest
    try {
      manifest = runManifestSchema.parse(JSON.parse(text))
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const prompts: Record<string, string> = Object.create(null) as Record<string, string>
    if (promptRunId !== undefined && manifest.runId !== promptRunId) {
      runs.push({ runId: manifest.runId, manifest, prompts })
      continue
    }
    for (const session of manifest.sessions) {
      const expected = `prompts/${session.promptSha256}.md`
      const legacyPath = `prompts/${session.name}.md`
      if (session.promptPath !== expected && session.promptPath !== legacyPath) {
        warnings.push(`${path}: prompt path ${session.promptPath} is not ${expected}`)
        continue
      }
      const prompt = files.readFile(session.promptPath)
      if (prompt === undefined) {
        warnings.push(`${path}: missing prompt ${session.promptPath}`)
        continue
      }
      const legacy = prompt.endsWith('\n') ? sha256(prompt.slice(0, -1)) : undefined
      if (sha256(prompt) !== session.promptSha256 && legacy !== session.promptSha256) {
        warnings.push(`${path}: prompt ${session.promptPath} does not match its hash`)
        continue
      }
      if (session.name in prompts && prompts[session.name] !== prompt) {
        warnings.push(`${path}: session ${session.name} has more than one prompt`)
        continue
      }
      prompts[session.name] = prompt
    }
    runs.push({ runId: manifest.runId, manifest, prompts })
  }
  return runs.sort((left, right) => left.manifest.startedAt.localeCompare(right.manifest.startedAt))
}

/**
 * The newest run id in a migration, without reading any prompt text.
 * @param files - the state-branch files.
 * @param migrationId - the migration.
 */
export function latestRunId(files: MigrationFiles, migrationId: string): string | undefined {
  const warnings: string[] = []
  return readRunEvidence(files, migrationId, warnings, '__none__').at(-1)?.runId
}

export function readInspectData(files: MigrationFiles, migrationId?: string | undefined, currentRunId?: string | undefined): InspectData {
  const ids = migrationIds(files)
  if (ids.length === 0) throw new Error('the state branch holds no migration')
  const id = migrationId ?? ids.at(-1)
  if (id === undefined) throw new Error('the state branch holds no migration')
  if (!ids.includes(id)) throw new Error(`migration \`${id}\` is not on the state branch; known: ${ids.join(', ')}`)
  const warnings: string[] = []
  const runs = readRunEvidence(files, id, warnings, currentRunId)
  if (runs.length === 0) {
    const detail = warnings.length === 0 ? '' : `; ${String(warnings.length)} manifest(s) exist but do not parse: ${warnings.slice(0, 3).join('; ')}`
    throw new Error(`migration \`${id}\` has no usable run manifest${detail}`)
  }
  const selected = currentRunId === undefined ? runs : runs.filter(run => run.runId === currentRunId)
  if (selected.length === 0) throw new Error(`run \`${String(currentRunId)}\` has no usable manifest in migration \`${id}\``)
  const allHistory = runs.map(run => ({ runId: run.runId, startedAt: run.manifest.startedAt }))
  const history = allHistory.slice(-500)
  if (currentRunId !== undefined && !history.some(run => run.runId === currentRunId)) {
    const current = allHistory.find(run => run.runId === currentRunId)
    if (current !== undefined) history.splice(0, 1, current)
  }
  return { migrationId: id, runs: selected, history, warnings }
}
