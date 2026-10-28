import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInspectData } from '../../src/observability/evidence.ts'
import { renderInspectHtml, writeInspectHtml } from '../../src/inspect/html.ts'
import { buildRunManifest, serializeManifest, sha256 } from '../../src/observability/manifest.ts'
import type { SessionRecord } from '../../src/observability/session.ts'
import type { AgentConfig } from '../../src/config/schema.ts'
import type { MigrationFiles } from '../../src/observability/evidence.ts'

const agent: AgentConfig = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  thinking: 'enabled',
  reasoningEffort: 'max',
  upgradeSkills: true,
}

const prompt = 'review this plugin\n'
const promptSha = sha256(prompt)
const session: SessionRecord = {
  kind: 'overlap',
  name: 'overlap',
  prompt,
  promptSha256: promptSha,
  startedAt: '2026-10-27T13:00:00.000Z',
  endedAt: '2026-10-27T13:05:00.000Z',
  outcome: 'completed',
  usage: { inputTokens: 100, outputTokens: 20, cacheHitTokens: 30, usd: 0.01 },
  progress: { turns: 3, steps: 7, elapsedSeconds: 300 },
  toolCalls: 4,
  observations: [],
}

function manifest(runId: string, startedAt: string) {
  return buildRunManifest({
    runId,
    migrationId: '0.2.0',
    plugin: ['plugin'],
    target: { tag: 'dsh-v0.2.0', version: '0.2.0' },
    agent,
    sessions: [{ ...session, startedAt, endedAt: startedAt }],
    checks: [],
    outcome: 'accepted',
    startedAt,
    endedAt: startedAt,
  })
}

function filesFor(): MigrationFiles {
  const first = manifest('123-1', '2026-10-27T13:00:00.000Z')
  const second = manifest('124-1', '2026-10-28T13:00:00.000Z')
  const files = new Map<string, string>([
    ['migrations/0.2.0/runs/123-1/manifest.json', serializeManifest(first)],
    ['migrations/0.2.0/runs/124-1/manifest.json', serializeManifest(second)],
    [`prompts/${promptSha}.md`, prompt],
  ])
  return {
    list: directory => [...files.keys()].filter(path => path === directory || path.startsWith(`${directory}/`)),
    readFile: path => files.get(path),
  }
}

test('inspect data reads the runs and prompts the state branch stores', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
  try {
    mkdirSync(join(root, 'docs', 'reference'), { recursive: true })
    writeFileSync(join(root, 'docs', 'reference', 'workflow.md'), '# Workflow\n\n```mermaid\nstateDiagram-v2\n  [*] --> checking\n```\n')
    const data = readInspectData(filesFor(), '0.2.0')
    assert.equal(data.migrationId, '0.2.0')
    assert.equal(data.runs.length, 2)
    assert.equal(data.runs[0]?.prompts.overlap, prompt)
    assert.match(data.runs[0]?.manifest.workflow.graph ?? '', /stateDiagram-v2/)
    const html = renderInspectHtml(data)
    assert.match(html, /Migration/)
    assert.match(html, /123-1/)
    assert.match(html, /prompt diff/)
    assert.match(html, /stateDiagram-v2/)
    assert.match(html, /graph-diff/)
    assert.match(html, /run state/)
    const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1]
    assert.ok(module !== undefined)
    assert.doesNotThrow(() => new Function(module))
    const path = writeInspectHtml(data, join(root, 'inspect'))
    assert.equal(path, join(root, 'inspect', 'index.html'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspect refuses a migration with no manifest and names the known ones', () => {
  assert.throws(() => readInspectData(filesFor(), '9.9.9'), /not on the state branch; known: 0\.2\.0/)
})
