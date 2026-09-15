import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inline } from '../render/text.ts'

/**
 * The agent-authored end-to-end suite lives on its own branch, never in a
 * migration PR. The migration worktree stays untouched: the agent writes a
 * draft under the run directory (already migrate-noise, never committed) and
 * this module transplants it into a scratch worktree of the suite branch.
 */

export interface E2EFeature {
  id: string
  surface: string
  entry: string
  input: string
  expect: string
  checks: string[]
  test: string
  state: 'passing' | 'failing' | 'unknown'
  lastPassedFor?: string
}

export interface E2EIndex {
  schema: 1
  generatedFor: { dsh: string; plugin: string }
  /** Which framework the suite extends, or the one it created. */
  framework: string
  features: E2EFeature[]
  /**
   * Repository-relative paths that belong to the suite. Recorded at publish
   * time so a later run can restore them after overlaying the plugin tree —
   * otherwise the plugin's own `package.json` would clobber the suite's
   * script and devDependencies.
   */
  files?: string[]
}

export const INDEX_FILE = 'index.json'
export const INDEX_MARKDOWN = 'INDEX.md'

/** Frameworks the agent is told to recognize before creating anything. */
const FRAMEWORK_MARKERS: { name: string; markers: string[] }[] = [
  { name: 'playwright', markers: ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'] },
  { name: 'cypress', markers: ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs'] },
  { name: 'vitest-browser', markers: ['vitest.config.ts', 'vitest.config.js'] },
  { name: 'webdriverio', markers: ['wdio.conf.ts', 'wdio.conf.js'] },
]

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Report which E2E framework the repository already uses, so the agent extends
 * it instead of introducing a second stack.
 * @param workdir - plugin working tree
 */
export function detectE2EFramework(workdir: string): string | undefined {
  for (const entry of FRAMEWORK_MARKERS) {
    if (entry.markers.some(marker => existsSync(join(workdir, marker)))) return entry.name
  }
  const pkg = readJson(join(workdir, 'package.json'))
  const scripts = pkg?.scripts
  if (typeof scripts === 'object' && scripts !== null) {
    for (const key of Object.keys(scripts as Record<string, unknown>)) {
      if (/^(test:|e2e)/i.test(key)) return `npm-script:${key}`
    }
  }
  for (const dir of ['e2e', 'test/e2e', 'tests/e2e', '__e2e__']) {
    if (existsSync(join(workdir, dir))) return `directory:${dir}`
  }
  return undefined
}

/**
 * Compose the agent instruction that tells it whether to extend or create.
 * @param input - workdir, suite directory to create in, and the target versions
 */
export function renderAuthoringBrief(input: {
  workdir: string
  suiteDir: string
  framework: string | undefined
  dshTag: string
  pluginName: string
  stagingDir: string
}): string {
  const existing = input.framework === undefined
    ? `No end-to-end framework was detected. Create one under "${input.suiteDir}" using Playwright with Chromium — the same tooling the DeepSeek Harness repository uses for its own web end-to-end tests.`
    : `This repository already uses "${input.framework}". Extend that framework in place: same runner, same config, same directory conventions. Do not introduce a second end-to-end stack.`

  return `Author or extend this plugin's end-to-end suite.

Plugin: ${input.pluginName} (working tree: ${input.workdir})
Target harness: ${input.dshTag}
${existing}

Write EVERY file under "${input.stagingDir}" — a staging directory. Nothing may be written into the plugin tree itself: the migration is pending review, and test assets belong on their own branch. Mirror the repository-relative paths you want to end up with (for example, "${input.stagingDir}/e2e/specs/settings.spec.ts" becomes "e2e/specs/settings.spec.ts").

Also write "${input.stagingDir}/${INDEX_FILE}":
{
  "schema": 1,
  "generatedFor": { "dsh": "${input.dshTag}", "plugin": "${input.pluginName}" },
  "framework": "<the framework you extended, or 'playwright'>",
  "features": [
    {
      "id": "<stable kebab-case id>",
      "surface": "<web-client | headless | cli>",
      "entry": "<how a user reaches this feature>",
      "input": "<what the test does to exercise it>",
      "expect": "<what must be true afterwards>",
      "checks": ["aria", "geometry:overflow", "console", "visual"],
      "test": "<repository-relative path to the spec>",
      "state": "unknown",   // one of: passing | failing | unknown
      "lastPassedFor": "${input.dshTag}"
    }
  ]
}

Rules:
- Enumerate the plugin's user-visible features from its README and source; every feature gets a row. This table is the coverage ledger.
- Prefer assertions that do not need a baseline: ARIA roles and accessible names, text content, and geometry invariants (content clipped by its box, elements overlapping or occluded, collapsed layout). Assert on roles and labels, never on the host's internal data-* attributes — those drift between harness versions and produce false failures.
- Give each spec a way to reach its state deterministically. Never wait on network idle. Never assert on a single transient DOM sample; poll until two consecutive reads agree.
- Include at least one console/pageerror tripwire per spec.
- If a feature cannot be exercised end to end, still list it with "state": "unknown" and say why in the spec's comment.`
}

/** Render the human-readable ledger from the machine-readable index. */
export function renderIndexMarkdown(index: E2EIndex): string {
  const rows = index.features.map(feature =>
    `| \`${feature.id}\` | ${feature.surface} | ${feature.entry} | ${feature.expect} | ${feature.checks.join(', ')} | ${feature.state} | ${feature.lastPassedFor ?? '-'} |`,
  )
  return `# End-to-end coverage ledger

Generated from \`${INDEX_FILE}\` by dsh-migrate. Rows are written by the agent from the plugin's
documented features; \`lastPassedFor\` records the newest harness tag this feature was verified against.

Framework: ${index.framework}
Generated for: dsh ${index.generatedFor.dsh}, plugin ${index.generatedFor.plugin}

| Feature | Surface | Entry | Expected | Checks | State | Last passed |
|---|---|---|---|---|---|---|
${rows.join('\n')}
`
}

/** Validate and normalize an index written by the agent. */
export function parseIndex(raw: unknown): E2EIndex | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.features)) return undefined
  const generated = typeof record.generatedFor === 'object' && record.generatedFor !== null
    ? record.generatedFor as Record<string, unknown>
    : {}
  const features: E2EFeature[] = []
  for (const item of record.features) {
    if (typeof item !== 'object' || item === null) continue
    const feature = item as Record<string, unknown>
    if (typeof feature.id !== 'string' || feature.id === '') continue
    const state = feature.state === 'passing' || feature.state === 'failing' ? feature.state : 'unknown'
    features.push({
      id: feature.id,
      surface: typeof feature.surface === 'string' ? feature.surface : 'unknown',
      entry: typeof feature.entry === 'string' ? feature.entry : '',
      input: typeof feature.input === 'string' ? feature.input : '',
      expect: typeof feature.expect === 'string' ? feature.expect : '',
      checks: Array.isArray(feature.checks) ? feature.checks.filter((c): c is string => typeof c === 'string') : [],
      test: typeof feature.test === 'string' ? feature.test : '',
      state,
      ...(typeof feature.lastPassedFor === 'string' ? { lastPassedFor: feature.lastPassedFor } : {}),
    })
  }
  const files = Array.isArray(record.files)
    ? record.files.filter((item): item is string => typeof item === 'string')
    : undefined
  return {
    schema: 1,
    generatedFor: {
      dsh: typeof generated.dsh === 'string' ? generated.dsh : 'unknown',
      plugin: typeof generated.plugin === 'string' ? generated.plugin : 'unknown',
    },
    framework: typeof record.framework === 'string' ? record.framework : 'unknown',
    features,
    ...(files === undefined ? {} : { files }),
  }
}

/** Read the index the agent staged, if any. */
export function readIndex(file: string): E2EIndex | undefined {
  return parseIndex(readJson(file))
}

/** Repository-relative files under a staged path, for the suite file list. */
function listFiles(absolute: string, relative: string): string[] {
  if (!statSync(absolute).isDirectory()) return [relative]
  const out: string[] = []
  for (const entry of readdirSync(absolute)) {
    out.push(...listFiles(join(absolute, entry), `${relative}/${entry}`))
  }
  return out
}

function git(args: readonly string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8' })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

export interface SyncE2EBranchInput {
  workdir: string
  branch: string
  /** Branch the suite branch is rebased onto; falls back to the default branch. */
  baseRef: string | undefined
  defaultBranch: string
  forceRebase: boolean
  /** Directory holding the staged suite (inside the run directory). */
  stagingDir: string
  /** Scratch worktree location. */
  worktreeDir: string
  index: E2EIndex
  /** The harness tag the suite was authored for; the commit subject names it. */
  tag: string
}

export interface SyncE2EBranchResult {
  ok: boolean
  pushed: boolean
  reason?: string
  detail?: string
}

/**
 * Transplant the staged suite onto the suite branch and push it.
 *
 * The suite branch is rebased onto the migration branch head when it exists so
 * the tests describe the migrated state, and onto the default branch when that
 * head is gone (a closed or deleted migration branch must not strand the suite).
 * @param input - branch names, staging directory, index, and the tag the suite is for
 */
export function syncE2EBranch(input: SyncE2EBranchInput): SyncE2EBranchResult {
  if (!existsSync(input.stagingDir)) {
    return { ok: false, pushed: false, reason: 'no-draft', detail: 'the agent staged no suite files' }
  }

  git(['fetch', 'origin', `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`], input.workdir)
  const remoteExists = git(['rev-parse', '--verify', `refs/remotes/origin/${input.branch}`], input.workdir).ok

  // Pick a base that actually resolves; a migration branch may already be gone.
  // HEAD is the last resort: it is the commit this run is standing on, so the
  // suite branch can always be created even when no remote-tracking ref exists
  // (a local checkout, or a repository whose default branch was never fetched).
  const candidates = [
    input.baseRef,
    `origin/${input.defaultBranch}`,
    input.defaultBranch,
    'HEAD',
  ].filter((ref): ref is string => ref !== undefined && ref !== '')
  const base = candidates.find(ref => git(['rev-parse', '--verify', ref], input.workdir).ok)
  if (base === undefined) {
    return { ok: false, pushed: false, reason: 'no-base', detail: `none of ${candidates.join(', ')} resolve` }
  }

  rmSync(input.worktreeDir, { recursive: true, force: true })
  mkdirSync(input.worktreeDir, { recursive: true })

  const add = remoteExists
    ? git(['worktree', 'add', '--force', '-B', input.branch, input.worktreeDir, `origin/${input.branch}`], input.workdir)
    : git(['worktree', 'add', '--force', '-B', input.branch, input.worktreeDir, base], input.workdir)
  if (!add.ok) {
    return { ok: false, pushed: false, reason: 'worktree-failed', detail: add.out }
  }

  try {
    if (input.forceRebase && base !== input.branch) {
      const rebase = git(['rebase', base], input.worktreeDir)
      if (!rebase.ok) {
        // A conflicting rebase must not block the migration; surface the reason.
        git(['rebase', '--abort'], input.worktreeDir)
        return { ok: false, pushed: false, reason: 'rebase-conflict', detail: rebase.out }
      }
    }

    const transplanted: string[] = []
    for (const entry of readdirSync(input.stagingDir)) {
      if (entry === INDEX_FILE || entry === INDEX_MARKDOWN) continue
      cpSync(join(input.stagingDir, entry), join(input.worktreeDir, entry), { recursive: true })
      transplanted.push(...listFiles(join(input.stagingDir, entry), entry))
    }
    const index: E2EIndex = { ...input.index, files: transplanted.sort() }
    writeFileSync(join(input.worktreeDir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    writeFileSync(join(input.worktreeDir, INDEX_MARKDOWN), renderIndexMarkdown(index), 'utf8')

    git(['add', '-A'], input.worktreeDir)
    const staged = git(['diff', '--cached', '--name-only'], input.worktreeDir)
    if (staged.out === '') {
      return { ok: true, pushed: false, reason: 'no-change', detail: 'suite already up to date' }
    }
    // The subject names the harness the suite covers. The tag is a resolved
    // version, so it is collapsed: a commit subject is a line.
    const message = `test(e2e): cover ${inline(input.tag, 80)} (${String(input.index.features.length)} features)`
    git(['-c', 'user.name=dsh-migrate[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', message], input.worktreeDir)

    const push = remoteExists
      ? git(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${input.branch}`], input.worktreeDir)
      : git(['push', 'origin', `HEAD:refs/heads/${input.branch}`], input.worktreeDir)
    if (!push.ok) {
      return { ok: false, pushed: false, reason: 'push-failed', detail: push.out }
    }
    return { ok: true, pushed: true }
  } finally {
    git(['worktree', 'remove', '--force', input.worktreeDir], input.workdir)
    rmSync(input.worktreeDir, { recursive: true, force: true })
  }
}
