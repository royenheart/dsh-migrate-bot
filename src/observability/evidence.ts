import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runManifestSchema, type RunManifest } from './manifest.ts'
import { workflowDiagram } from '../workflow/graph.ts'

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

export interface InspectData {
  migrationId: string
  runs: RunEvidence[]
  /** The statechart Mermaid block, when the checkout carries the generated reference. */
  graph?: string | undefined
}

export function migrationIds(files: MigrationFiles): string[] {
  const ids = files.list('migrations')
    .flatMap(path => {
      const parts = path.split('/')
      return parts.length >= 2 && parts[0] === 'migrations' && parts[1] !== undefined ? [parts[1]] : []
    })
  return [...new Set(ids)].sort()
}

export function readRunEvidence(files: MigrationFiles, migrationId: string): RunEvidence[] {
  const runs: RunEvidence[] = []
  for (const path of files.list(`migrations/${migrationId}/runs`).sort()) {
    if (!path.endsWith('/manifest.json')) continue
    const text = files.readFile(path)
    if (text === undefined) continue
    let manifest: RunManifest
    try {
      manifest = runManifestSchema.parse(JSON.parse(text))
    } catch {
      continue
    }
    const prompts: Record<string, string> = {}
    for (const session of manifest.sessions) {
      const prompt = files.readFile(session.promptPath)
      if (prompt !== undefined) prompts[session.name] = prompt
    }
    runs.push({ runId: manifest.runId, manifest, prompts })
  }
  return runs.sort((left, right) => left.manifest.startedAt.localeCompare(right.manifest.startedAt))
}

/** The statechart graph in the generated workflow reference, when this checkout has one. */
export function workflowGraph(root = process.cwd()): string | undefined {
  const path = join(root, 'docs', 'reference', 'workflow.md')
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  return /```mermaid\n([\s\S]*?)```/.exec(text)?.[1]?.trim()
}

export function readInspectData(files: MigrationFiles, migrationId?: string | undefined, root = process.cwd()): InspectData {
  const ids = migrationIds(files)
  if (ids.length === 0) throw new Error('the state branch holds no migration')
  const id = migrationId ?? ids.at(-1)
  if (id === undefined) throw new Error('the state branch holds no migration')
  if (!ids.includes(id)) throw new Error(`migration \`${id}\` is not on the state branch; known: ${ids.join(', ')}`)
  const runs = readRunEvidence(files, id)
  if (runs.length === 0) throw new Error(`migration \`${id}\` has no run manifest; only runs after this feature was deployed record one`)
  const graph = workflowGraph(root) ?? workflowDiagram()
  return { migrationId: id, runs, graph }
}
