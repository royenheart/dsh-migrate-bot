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
import { ModelGateway, PREVIEW_MODEL_PORT } from './model-gateway.ts'
import type { InstanceProvider } from './providers/types.ts'

/**
 * Start the deploy service: validate the environment, load the data directory,
 * listen, and sweep for idle and expired previews once a minute.
 */

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`)
}

async function providerFor(config: ServiceConfig, model?: { dir: string; socketPath: string }, onExit?: (id: string) => void): Promise<InstanceProvider> {
  if (config.PROVIDER === 'docker') {
    const docker = new DockerProvider({
      image: config.DSH_IMAGE ?? '',
      prefix: config.INSTANCE_PREFIX,
      ...(model === undefined ? {} : { model: { ...model, port: PREVIEW_MODEL_PORT } }),
      ...(onExit === undefined ? {} : { onExit }),
      log,
    })
    // Nothing runs after a start: remove what an earlier run of the service left.
    await docker.removeLeftovers()
    return docker
  }
  return new ProcessProvider({ dshBin: config.DSH_BIN, dshVersion: config.DSH_VERSION, dataDir: config.DATA_DIR, ...(onExit === undefined ? {} : { onExit }), log })
}

async function main(): Promise<void> {
  const loaded = loadConfig(process.env, process.argv.slice(2))
  if (!loaded.ok) {
    process.stderr.write(`dsh-migrate deploy service: invalid configuration\n${loaded.problems.map(problem => `  - ${problem}`).join('\n')}\n`)
    process.exit(2)
  }
  const { config } = loaded
  mkdirSync(config.DATA_DIR, { recursive: true })
  let gateway: ModelGateway | undefined
  if (config.MODEL_API_KEY !== undefined) {
    gateway = new ModelGateway({
      upstream: config.MODEL_UPSTREAM,
      apiKey: config.MODEL_API_KEY,
      models: config.MODEL_MODELS === undefined ? undefined : (() => {
        const models = config.MODEL_MODELS.split(',').map(model => model.trim()).filter(model => model !== '')
        return models.length === 0 ? undefined : models
      })(),
      maxRequests: config.MODEL_MAX_REQUESTS,
      maxBodyBytes: config.MODEL_MAX_BODY_BYTES,
      maxConcurrency: config.MODEL_MAX_CONCURRENCY,
      globalConcurrency: config.MODEL_GLOBAL_CONCURRENCY,
      timeoutMs: config.MODEL_TIMEOUT_MS,
      log,
    })
    await gateway.start(join(config.DATA_DIR, 'model'))
  }
  const provider = await providerFor(config, gateway === undefined ? undefined : { dir: join(config.DATA_DIR, 'model'), socketPath: gateway.unixSocket }, gateway === undefined ? undefined : (id) => gateway?.revoke(id))
  const previews = new PreviewManager({
    dataDir: config.DATA_DIR,
    publicUrl: config.PUBLIC_URL,
    ttlDays: config.TTL_DAYS,
    idleMinutes: config.IDLE_MINUTES,
    provider,
    providerKind: config.PROVIDER,
    ...(gateway === undefined ? {} : { modelGateway: gateway }),
    ...(config.PREVIEW_DOMAIN === undefined ? {} : { previewDomain: config.PREVIEW_DOMAIN }),
    log,
  })
  await previews.load()
  const idempotency = new IdempotencyStore(join(config.DATA_DIR, 'idempotency'))
  const runs = new RunStore(join(config.DATA_DIR, 'runs'), config.PUBLIC_URL, config.EVIDENCE_URL)
  const server = createService({
    config,
    runs,
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
    const deleted = runs.prune(config.RETENTION_DAYS)
    if (deleted > 0) log(`retention: deleted ${String(deleted)} run record(s)`)
  }, 60_000)
  const shutdown = (): void => {
    clearInterval(sweep)
    server.close()
    void Promise.all(previews.all().map(async record => await provider.stop(record.id))).then(async () => await gateway?.close()).finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main()
