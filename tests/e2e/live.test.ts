import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { loadSecrets } from '../../src/secrets.ts'
import { parseConfig } from '../../src/config/load.ts'
import { createReportStore } from '../../src/reports/store.ts'
import { createDshRunner } from '../../src/agents/dsh.ts'
import { runMechanical } from '../../src/mechanical/run.ts'
import { runPipeline } from '../../src/pipeline/orchestrator.ts'
import { appRootFrom } from '../../src/paths.ts'

const appRoot = appRootFrom(import.meta.url)
const plugin = resolve(appRoot, 'fixtures/plugins/official-overlap-markdown')

test('live dsh review against the overlap fixture', async (t) => {
  if (process.env.DSH_MIGRATE_LIVE !== '1') {
    t.skip('set DSH_MIGRATE_LIVE=1 and put DEEPSEEK_API_KEY in .secrets.local.json')
    return
  }
  const secrets = loadSecrets([appRoot])
  if (secrets.DEEPSEEK_API_KEY === undefined) {
    t.skip('missing DEEPSEEK_API_KEY')
    return
  }
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-mig-live-plugin-'))
  cpSync(plugin, workdir, { recursive: true })
  const runDir = join(tmpdir(), `dsh-mig-live-${Date.now()}`)
  mkdirSync(runDir, { recursive: true })
  const result = await runPipeline({
    config: parseConfig({ loop: { maxAttempts: 1 } }),
    workdir,
    target: { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2' },
    store: createReportStore(runDir),
    apiKey: secrets.DEEPSEEK_API_KEY,
    runMechanical: () => runMechanical(workdir, parseConfig({})),
    isDirty: () => false,
    diff: () => '',
    agent: createDshRunner({ reportDir: runDir }),
  })
  assert.ok(result.runDir)
  assert.ok(result.skippedReview === false)
})
