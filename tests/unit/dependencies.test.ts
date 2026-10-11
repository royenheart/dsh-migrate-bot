import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDependencyContract } from '../../src/mechanical/dependencies.ts'
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
