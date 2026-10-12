/**
 * A snapshot of what the Action brings to a migration, so the report can show
 * what changed between two benchmark records: the statechart, the
 * configuration defaults, every prompt a session receives, the agent runtime,
 * the upgrade skills, and the source of `src/`, which holds the checks and
 * everything else a prompt does not show.
 *
 * A record's commit can disappear when development history is rewritten, so
 * the snapshot is stored with the records, once per distinct content, under
 * `snapshots/<hash>/`. It is built from a built checkout (`dist/`), which is
 * how an earlier commit's snapshot is built from that commit.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { REPO_ROOT } from './repo.ts'

/** What a prompt's runtime inputs are replaced with, so a template diff shows only template changes. */
const HARNESS = { path: '<harness checkout>', tag: '<target tag>' }

const manifestSchema = z.strictObject({
  files: z.record(z.string(), z.strictObject({ sha256: z.string(), bytes: z.number().int().min(0) })),
})

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

async function load<T>(root: string, module: string): Promise<T> {
  return await import(pathToFileURL(join(root, 'dist', module)).href) as T
}

/**
 * The snapshot of a built checkout, by path within the snapshot.
 * @param root - the checkout; this repository by default.
 */
export async function botSnapshot(root: string = REPO_ROOT): Promise<Map<string, string>> {
  const references = await load<{ generateReferences: () => Map<string, string> }>(root, 'scripts/references.js')
  const migration = await load<{
    OVERLAP_PROMPT: string
    EXTENSION_POINTS_PROMPT: string
    REPAIR_PROMPT: string
    withHarnessContext: (prompt: string, harness: typeof HARNESS) => string
    assembleRepairPrompt: (input: Record<string, unknown>) => string
  }>(root, 'src/prompts/migration.js')
  const e2e = await load<{ renderAuthoringBrief: (input: Record<string, unknown>) => string }>(root, 'src/e2e/suite.js')
  const reports = await load<{ channelPrompt: (channel: { id: string }, evidence: string) => string }>(root, 'src/prompts/reports.js')
  const channels = await load<{ BUILTIN_CHANNELS: Record<string, unknown> }>(root, 'src/merge-reports/channels.js')
  const upgrade = await load<{ UPGRADE_SKILLS: readonly string[] }>(root, 'src/skills/upgrade.js')

  const generated = references.generateReferences()
  const files = new Map<string, string>([
    ['workflow.md', generated.get('docs/reference/workflow.md') ?? ''],
    ['configuration.md', generated.get('docs/reference/configuration.md') ?? ''],
    ['prompts/overlap.md', migration.withHarnessContext(migration.OVERLAP_PROMPT, HARNESS)],
    ['prompts/extension-points.md', migration.withHarnessContext(migration.EXTENSION_POINTS_PROMPT, HARNESS)],
    ['prompts/repair.md', migration.assembleRepairPrompt({
      template: migration.REPAIR_PROMPT,
      overlapReport: '<overlap review report>',
      extensionPointsReport: '<extension-point review report>',
      failingOutput: '<output of the failing check>',
      priorRepairs: ['<report of the previous repair attempt>'],
      harness: HARNESS,
      baselineNote: '<how the unmodified plugin booted on the source and target releases>',
    })],
    ['prompts/e2e-authoring.md', e2e.renderAuthoringBrief({ suiteDir: '<suite directory>', plugins: '<plugin names>', release: '<release tag>', existing: false })],
    ...Object.keys(channels.BUILTIN_CHANNELS).sort().map((id): [string, string] => [`prompts/report-${id}.md`, reports.channelPrompt({ id }, '<evidence of the merged proposal>')]),
    ['runtime/agent-runtime.json', readFileSync(join(root, 'container', 'agent-runtime', 'package.json'), 'utf8')],
    ...readdirSync(join(root, 'container', 'profile')).sort().map((name): [string, string] => [`runtime/profile/${name}`, readFileSync(join(root, 'container', 'profile', name), 'utf8')]),
    ...sourceFiles(join(root, 'src')).map((path): [string, string] => [`source/${path}`, readFileSync(join(root, 'src', path), 'utf8')]),
    ['skills.json', `${JSON.stringify({
      commit: execFileSync('git', ['rev-parse', 'HEAD:vendor/dsh-plugin-upgrade-skill'], { cwd: root, encoding: 'utf8' }).trim(),
      names: upgrade.UPGRADE_SKILLS,
    }, null, 2)}\n`],
  ])
  return files
}

/** Every file below a directory, by relative path, in order. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(path => statSync(join(dir, path)).isFile()).sort()
}

/** The content hash of a snapshot: its files' paths and hashes, in path order. */
export function snapshotHash(files: ReadonlyMap<string, string>): string {
  return sha256([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => `${path}\0${sha256(text)}\n`).join('')).slice(0, 16)
}

/** Write a snapshot under `<records>/snapshots/<hash>/` unless it is there; returns its hash. */
export function storeSnapshot(records: string, files: ReadonlyMap<string, string>): string {
  const hash = snapshotHash(files)
  const dir = join(records, 'snapshots', hash)
  if (existsSync(join(dir, 'manifest.json'))) return hash
  const manifest: z.infer<typeof manifestSchema> = { files: {} }
  for (const [path, text] of files) {
    mkdirSync(join(dir, 'files', path, '..'), { recursive: true })
    writeFileSync(join(dir, 'files', path), text)
    manifest.files[path] = { sha256: sha256(text), bytes: Buffer.byteLength(text) }
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return hash
}

/** Problems with a stored snapshot: a missing manifest, a changed file, or a hash that no longer matches. */
export function checkSnapshot(records: string, hash: string): string[] {
  const dir = join(records, 'snapshots', hash)
  if (!existsSync(join(dir, 'manifest.json'))) return [`snapshot ${hash} is missing`]
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  const files = new Map<string, string>()
  const problems: string[] = []
  for (const [path, entry] of Object.entries(manifest.files)) {
    const file = join(dir, 'files', path)
    const text = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    if (text === undefined || sha256(text) !== entry.sha256) problems.push(`snapshot ${hash}: ${path} is missing or changed`)
    else files.set(path, text)
  }
  if (problems.length === 0 && snapshotHash(files) !== hash) problems.push(`snapshot ${hash} does not hash to its name`)
  return problems
}
