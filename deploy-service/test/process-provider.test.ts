import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessProvider } from '../src/providers/process.ts'

test('the process provider gives the plugin\'s code none of the service\'s environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-env-'))
  const saved = { DEPLOY_TOKEN: process.env.DEPLOY_TOKEN, GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET }
  process.env.DEPLOY_TOKEN = 'service-token-0123456789'
  process.env.GITHUB_WEBHOOK_SECRET = 'service-secret-0123456789'
  try {
    // A dsh that records its environment and answers like a boot that reached the model call.
    const dsh = join(root, 'dsh')
    const seen = join(root, 'env.json')
    writeFileSync(dsh, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env))\nprocess.stderr.write('dsh: TRANSPORT: DeepSeek API request to http://127.0.0.1:9/v1 failed\\n')\nprocess.exit(1)\n`, { mode: 0o755 })
    const plugin = join(root, 'plugin')
    mkdirSync(plugin)
    writeFileSync(join(plugin, 'package.json'), '{"name":"@acme/plugin","version":"1.0.0","scripts":{"postinstall":"node -e \\"require(\'node:fs\').writeFileSync(\'install-env.json\', JSON.stringify(process.env))\\""}}\n')
    const provider = new ProcessProvider({ dshBin: dsh, dataDir: root, log: () => {} })
    const built = await provider.build({ id: 'p', workDir: plugin, homeDir: join(root, 'home'), stateDir: join(root, 'state'), socketDir: join(root, 'sockets') }, plugin)
    assert.deepEqual(built, { ok: true, detail: 'The boot check passed (pass: reached the model call).' })
    for (const file of [seen, join(plugin, 'install-env.json')]) {
      const env = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
      assert.equal(env.DEPLOY_TOKEN, undefined, file)
      assert.equal(env.GITHUB_WEBHOOK_SECRET, undefined, file)
      assert.equal(env.HOME, process.env.HOME, file)
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
