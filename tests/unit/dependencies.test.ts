import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDependencyContract, checkSourceImports } from '../../src/mechanical/dependencies.ts'
import { runMechanical } from '../../src/mechanical/run.ts'
import { parseConfig } from '../../src/config/load.ts'

const REGISTRY: Record<string, string[]> = {
  '@deepseek-ai/dsh-agent': ['0.1.0-rc.8', '0.1.1-rc.2', '0.1.2-alpha.2'],
  '@deepseek-ai/dsh-client-runtime': ['0.1.0-rc.8', '0.1.1-rc.2'],
}
const published = (name: string): readonly string[] | undefined => REGISTRY[name]

test('a range must admit the target by npm prerelease rules, and every package must exist at the target', () => {
  const findings = checkDependencyContract({
    peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0-rc.8', '@deepseek-ai/cordis': '^4.0.0' },
    devDependencies: { '@deepseek-ai/dsh-agent': '^0.1.2-alpha.2' },
    dependencies: { '@deepseek-ai/dsh-client-runtime': '^0.1.1-rc.2', '@deepseek-ai/dsh-local': 'workspace:*' },
  }, '0.1.2-alpha.2', published)
  assert.deepEqual(findings.map(finding => finding.message), [
    'peerDependencies: @deepseek-ai/dsh-agent is "^0.1.0-rc.8", which does not admit 0.1.2-alpha.2',
    'dependencies: @deepseek-ai/dsh-client-runtime is not published at 0.1.2-alpha.2; the harness removed or renamed it (last published 0.1.1-rc.2)',
  ])
})

test('an optional peer the harness stopped publishing harms nothing, but its range still has to admit the target', () => {
  // dsh-skill-hub at 0.1.7-alpha.1 kept dsh-client-runtime as an optional peer after 0.1.1-rc.2 was its last release.
  const findings = checkDependencyContract({
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': '>=0.1.1-rc.2 <0.2.0-0', '@deepseek-ai/dsh-agent': '^0.1.0-rc.8' },
    peerDependenciesMeta: { '@deepseek-ai/dsh-client-runtime': { optional: true }, '@deepseek-ai/dsh-agent': { optional: true } },
  }, '0.1.2-alpha.2', published)
  assert.deepEqual(findings.map(finding => finding.message), ['peerDependencies: @deepseek-ai/dsh-agent is "^0.1.0-rc.8", which does not admit 0.1.2-alpha.2'])
  const refused = checkDependencyContract({
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': '^0.1.0-rc.8' },
    peerDependenciesMeta: { '@deepseek-ai/dsh-client-runtime': { optional: true } },
  }, '0.2.0-rc.2', published)
  assert.deepEqual(refused.map(finding => finding.message), ['peerDependencies: @deepseek-ai/dsh-client-runtime is "^0.1.0-rc.8", which dsh refuses on 0.2.0-rc.2'])
})

test('a range written for the target cohort passes, and an unreadable registry decides nothing', () => {
  assert.deepEqual(checkDependencyContract({ peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0-rc.8 || ^0.1.2-alpha.2' } }, '0.1.2-alpha.2', published), [])
  assert.deepEqual(checkDependencyContract({ peerDependencies: { '@deepseek-ai/dsh-agent': '^0.0.1' } }, '0.1.2-alpha.2', () => undefined), [])
})

test('the mechanical check fails on a broken contract before it installs anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-contract-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/p', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0-rc.8' } }))
    const result = runMechanical(dir, parseConfig({ tests: { commands: ['exit 1'] } }), { dshVersion: '0.1.2-alpha.2', published })
    assert.equal(result.ok, false)
    assert.equal(result.errors, 'error: peerDependencies: @deepseek-ai/dsh-agent is "^0.1.0-rc.8", which does not admit 0.1.2-alpha.2')
    assert.equal(result.log.includes('npm install'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a source that still refers to a package the release does not publish, in code or in a JSDoc type, is named with its line; build output is left to the build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mig-imports-'))
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'src', 'client.ts'), "import { x } from 'react'\n\nimport { createStore } from '@deepseek-ai/dsh-client-runtime/store'\nexport const load = () => import('@deepseek-ai/dsh-agent')\n")
    writeFileSync(join(dir, 'src', 'host.cjs'), "const runtime = require('@deepseek-ai/dsh-client-runtime')\n")
    // A JSDoc type that still names the removed package: M7's leftover.
    writeFileSync(join(dir, 'src', 'panel.js'), "/**\n * @param {import('@deepseek-ai/dsh-client-runtime/client').ClientContext} ctx\n */\nexport function apply(ctx) {}\n")
    writeFileSync(join(dir, 'lib', 'client.js'), "import '@deepseek-ai/dsh-client-runtime'\n")
    // A tracked source the migration deleted, which git still lists.
    writeFileSync(join(dir, 'src', 'gone.ts'), "import '@deepseek-ai/dsh-client-runtime'\n")
    spawnSync('git', ['add', 'src/gone.ts'], { cwd: dir })
    rmSync(join(dir, 'src', 'gone.ts'))
    assert.deepEqual(checkSourceImports(dir, '0.1.2-alpha.2', published).map(finding => finding.message), [
      'src/client.ts:3 refers to @deepseek-ai/dsh-client-runtime, which 0.1.2-alpha.2 does not publish (last published 0.1.1-rc.2)',
      'src/host.cjs:1 refers to @deepseek-ai/dsh-client-runtime, which 0.1.2-alpha.2 does not publish (last published 0.1.1-rc.2)',
      'src/panel.js:2 refers to @deepseek-ai/dsh-client-runtime, which 0.1.2-alpha.2 does not publish (last published 0.1.1-rc.2)',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
