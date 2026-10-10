#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type ServiceConfig } from './config.ts'
import { IdempotencyStore } from './idempotency.ts'
import { PreviewManager } from './previews.ts'
import { DockerProvider } from './providers/docker.ts'
import { ProcessProvider } from './providers/process.ts'
import { InstanceProxy } from './proxy.ts'
import { RunStore } from './runs.ts'
import { createService } from './server.ts'
import type { InstanceProvider } from './providers/types.ts'

/**
 * Start the deploy service: validate the environment, load the data directory,
 * listen, and sweep for idle and expired previews once a minute.
 */

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`)
}

function providerFor(config: ServiceConfig): InstanceProvider {
  if (config.PROVIDER === 'docker') {
    return new DockerProvider({ image: config.DSH_IMAGE ?? '', prefix: config.INSTANCE_PREFIX, log })
  }
  return new ProcessProvider({ dshBin: config.DSH_BIN, dshVersion: config.DSH_VERSION, dataDir: config.DATA_DIR, log })
}

async function main(): Promise<void> {
  const loaded = loadConfig(process.env, process.argv.slice(2))
  if (!loaded.ok) {
    process.stderr.write(`dsh-migrate deploy service: invalid configuration\n${loaded.problems.map(problem => `  - ${problem}`).join('\n')}\n`)
    process.exit(2)
  }
  const { config } = loaded
  mkdirSync(config.DATA_DIR, { recursive: true })
  const provider = providerFor(config)
  const previews = new PreviewManager({
    dataDir: config.DATA_DIR,
    publicUrl: config.PUBLIC_URL,
    ttlDays: config.TTL_DAYS,
    idleMinutes: config.IDLE_MINUTES,
    provider,
    log,
  })
  await previews.load()
  const idempotency = new IdempotencyStore(join(config.DATA_DIR, 'idempotency'))
  const server = createService({
    config,
    runs: new RunStore(join(config.DATA_DIR, 'runs'), config.PUBLIC_URL),
    previews,
    idempotency,
    proxy: new InstanceProxy(new URL(config.PUBLIC_URL).origin),
    log,
  })
  server.listen(config.PORT, config.HOST, () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : config.PORT
    log(`deploy service listening on http://${config.HOST}:${String(port)} (provider ${config.PROVIDER}${config.conformance ? ', conformance mode' : ''})`)
  })
  const sweep = setInterval(() => {
    void previews.sweep().catch((error: unknown) => { log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`) })
    idempotency.prune()
  }, 60_000)
  const shutdown = (): void => {
    clearInterval(sweep)
    server.close()
    void Promise.all(previews.all().map(async record => await provider.stop(record.id))).finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main()
