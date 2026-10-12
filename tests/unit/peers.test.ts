import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dshPeerSpecs, pinDshPeersCommand } from '../../src/mechanical/peers.ts'

test('collects @deepseek-ai/dsh-* names from peer, dev, and runtime deps', () => {
  const specs = dshPeerSpecs({
    peerDependencies: {
      '@deepseek-ai/cordis': '^4.0.1',
      '@deepseek-ai/dsh-agent': '^0.1.0-rc.6',
      react: '^18.3.1',
    },
    devDependencies: {
      '@deepseek-ai/dsh-tools': '^0.1.0-rc.6',
      typescript: '^5.7.0',
    },
    dependencies: {
      '@deepseek-ai/dsh-mcp-client': '^0.1.0-rc.5',
    },
  }, '0.1.1-rc.2')
  assert.deepEqual(specs, [
    '@deepseek-ai/dsh-agent@0.1.1-rc.2',
    '@deepseek-ai/dsh-mcp-client@0.1.1-rc.2',
    '@deepseek-ai/dsh-tools@0.1.1-rc.2',
  ])
})

test('a package the release did not publish is not installed', () => {
  const registry: Record<string, string[]> = { '@deepseek-ai/dsh-client-runtime': ['0.1.1-rc.2'], '@deepseek-ai/dsh-agent': ['0.1.7-alpha.1'] }
  const specs = dshPeerSpecs({ peerDependencies: { '@deepseek-ai/dsh-client-runtime': '>=0.1.1-rc.2 <0.2.0-0', '@deepseek-ai/dsh-agent': '^0.1.7-alpha.1' } }, '0.1.7-alpha.1', name => registry[name])
  assert.deepEqual(specs, ['@deepseek-ai/dsh-agent@0.1.7-alpha.1'])
})

test('returns no specs when the package names no dsh packages', () => {
  assert.deepEqual(dshPeerSpecs({ peerDependencies: { react: '^18' } }, '0.1.1-rc.2'), [])
  assert.equal(pinDshPeersCommand([]), undefined)
})

test('pin command uses --no-save', () => {
  assert.equal(
    pinDshPeersCommand(['@deepseek-ai/dsh-agent@0.1.1-rc.2']),
    'npm install --no-save @deepseek-ai/dsh-agent@0.1.1-rc.2',
  )
})
