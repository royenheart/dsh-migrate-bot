import { watch as fsWatch } from 'node:fs'
import { readFile as fsReadFile } from 'node:fs/promises'
import { join } from 'node:path'

import { McpServerSchema, validateMcpSettings } from './settings.js'
import { errorMessage } from './errors.js'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspaceConfigPath(workspaceRoot) {
  return join(workspaceRoot, '.dsh', 'mcp.json')
}

async function defaultReadFile(file) {
  return fsReadFile(file, 'utf8')
}

/**
 * Read one workspace Config layer from `${workspaceRoot}/.dsh/mcp.json`.
 *
 * A missing file is an empty layer, not an error. An unreadable file, invalid
 * JSON, an unknown top-level key, or a Server entry that fails the shared
 * Config schema rejects the whole layer as `{ error }` — never a throw — so the
 * Adapter fails closed to the global-only Config. Every entry resolves through
 * the same schema machinery as the global namespace and then runs
 * `validateMcpSettings`, so both layers enforce identical rules. Values are
 * never environment-variable-interpolated.
 */
export async function readWorkspaceConfig(workspaceRoot, deps = {}) {
  const readFile = deps.readFile ?? defaultReadFile
  const validate = deps.validate ?? validateMcpSettings
  const file = workspaceConfigPath(workspaceRoot)

  let text
  try {
    text = await readFile(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { servers: {} }
    return { error: `could not read ${file}: ${errorMessage(error)}` }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `${file} is not valid JSON: ${errorMessage(error)}` }
  }

  if (!isRecord(parsed)) {
    return { error: `${file} must contain a JSON object` }
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'mcpServers') {
      return {
        error: `${file}: unknown top-level key ${JSON.stringify(key)}; only "mcpServers" is allowed`,
      }
    }
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    return { error: `${file}: "mcpServers" must be an object of Server entries` }
  }

  const servers = {}
  try {
    for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
      servers[name] = McpServerSchema(entry)
    }
    validate({ mcpServers: servers })
  } catch (error) {
    return { error: `${file}: ${errorMessage(error)}` }
  }
  return { servers }
}

/**
 * Resolve the layered Config. A workspace Server entry with the same name
 * REPLACES the global entry wholesale — no field-level merge, because
 * half-applied secrets or lifecycle flags are dangerous. Workspace-only names
 * are added and global-only names pass through. Inputs are deep-cloned and
 * never mutated.
 */
export function mergeMcpConfigs(globalServers, workspaceServers) {
  const servers = {}
  const sources = {}
  for (const [name, config] of Object.entries(globalServers ?? {})) {
    servers[name] = structuredClone(config)
    sources[name] = 'global'
  }
  for (const [name, config] of Object.entries(workspaceServers ?? {})) {
    servers[name] = structuredClone(config)
    sources[name] = 'workspace'
  }
  return { servers, sources }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function defaultWatchDirectory(directory, onChange) {
  const watcher = fsWatch(directory, () => onChange())
  watcher.on('error', () => {
    // Watching is best-effort; platform differences must not crash the Host.
  })
  return () => watcher.close()
}

/**
 * Config facts the wire may carry about one workspace Server: the resolved
 * entry minus every `secret`-role field (`env`, `headers`).
 */
function publicServerSummary(config) {
  const { env, headers, ...summary } = config
  return summary
}

/**
 * Wrap the registered global Config scope with the workspace layer.
 *
 * `get()` returns the merged namespace value and `layerSnapshot()` reports
 * which source each Server came from. Watch listeners see global Config edits
 * and workspace file changes, but only when the merged result actually
 * changed. `update()` and `mutate()` forward to the global scope only: the
 * Settings page writes global Config and never the workspace file. The
 * workspace file is re-read when the global scope notifies, when the `.dsh`
 * directory changes (until `.dsh` exists, the workspace root is watched and
 * the `.dsh` watch is armed on its first event), and on `refreshLayers()`.
 */
export function createLayeredScope(globalScope, options = {}) {
  const {
    workspaceRoot = process.cwd(),
    readFile,
    validate,
    watchDirectory = defaultWatchDirectory,
    warn,
  } = options

  const loadLayer = () => readWorkspaceConfig(workspaceRoot, { readFile, validate })

  let layer = { servers: {}, error: undefined }
  let disposed = false
  let unwatchDsh
  let unwatchRoot
  let refreshTail = Promise.resolve()
  const listeners = new Set()

  const mergedValue = () => ({
    mcpServers: mergeMcpConfigs(globalScope.get().mcpServers, layer.servers).servers,
  })
  let lastNotifiedValue = mergedValue()
  let lastNotifiedJson = stableJson(lastNotifiedValue)
  let lastWarnedError

  const notify = async (next, previous) => {
    for (const listener of [...listeners]) {
      try {
        await listener(next, previous)
      } catch {
        // A stale or failing listener must not break the Config layer.
      }
    }
  }

  const publishIfChanged = async () => {
    if (disposed) return
    const next = mergedValue()
    const json = stableJson(next)
    if (json === lastNotifiedJson) return
    const previous = lastNotifiedValue
    lastNotifiedJson = json
    lastNotifiedValue = next
    await notify(next, previous)
  }

  const loadAndPublish = async () => {
    if (disposed) return
    const result = await loadLayer()
    if (disposed) return
    if (result.error === undefined) {
      layer = { servers: result.servers, error: undefined }
      lastWarnedError = undefined
    } else {
      layer = { servers: {}, error: result.error }
      if (result.error !== lastWarnedError) {
        lastWarnedError = result.error
        warn?.(`dsh-mcp-adapter: workspace Config layer rejected: ${result.error}`)
      }
    }
    await publishIfChanged()
  }

  const refresh = () => {
    if (disposed) return Promise.resolve()
    const run = refreshTail.then(loadAndPublish)
    refreshTail = run.then(() => undefined, () => undefined)
    return run
  }

  const unwatchGlobal = globalScope.watch(() => refresh())

  // The `.dsh` directory may not exist when the Adapter starts. In that case
  // watch the workspace root instead and upgrade to the `.dsh` watch as soon
  // as an event suggests the directory appeared, so a workspace file created
  // after startup is still seen.
  const onLayerEvent = () => refresh()
  const closeHandle = (close) => {
    try {
      close?.()
    } catch {
      // Closing a watcher must never break disposal.
    }
  }
  const tryWatchDsh = () => {
    if (typeof watchDirectory !== 'function' || unwatchDsh !== undefined) return false
    try {
      const stop = watchDirectory(join(workspaceRoot, '.dsh'), onLayerEvent)
      if (typeof stop !== 'function') return false
      unwatchDsh = stop
      return true
    } catch {
      return false
    }
  }
  if (!tryWatchDsh()) {
    try {
      const stop = watchDirectory(workspaceRoot, () => {
        refresh()
        if (unwatchDsh === undefined && tryWatchDsh()) {
          closeHandle(unwatchRoot)
          unwatchRoot = undefined
        }
      })
      if (typeof stop === 'function') unwatchRoot = stop
    } catch {
      // Watching is unavailable on this platform; global changes and
      // refreshLayers() still refresh the layer.
    }
  }

  void refresh()

  const dispose = () => {
    if (disposed) return
    disposed = true
    unwatchGlobal?.()
    closeHandle(unwatchDsh)
    closeHandle(unwatchRoot)
    unwatchDsh = undefined
    unwatchRoot = undefined
    listeners.clear()
  }

  return {
    get: () => mergedValue(),
    watch(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update: (patch) => globalScope.update(patch),
    mutate: (ops) => {
      if (typeof globalScope.mutate !== 'function') {
        throw new TypeError('The global MCP Config scope does not support mutate')
      }
      return globalScope.mutate(ops)
    },
    layerSnapshot() {
      const { sources } = mergeMcpConfigs(globalScope.get().mcpServers, layer.servers)
      // `servers` carries the sanitized workspace-side Config so the Settings
      // page can render workspace-only Servers (and their OAuth actions)
      // without any secret-role field ever crossing the wire.
      const servers = {}
      for (const [name, config] of Object.entries(layer.servers)) {
        servers[name] = publicServerSummary(config)
      }
      return { source: sources, error: layer.error, servers }
    },
    refreshLayers: () => refresh(),
    dispose,
  }
}

/**
 * Register the workspace Config layer on the settings fiber. Disposing the
 * fiber stops the global watch and the best-effort `.dsh` directory watch.
 */
export function installWorkspaceLayer(ctx, scope, options = {}) {
  const layer = createLayeredScope(scope, {
    ...options,
    warn: options.warn ?? ((message) => ctx.logger?.warn?.(message)),
  })
  ctx.effect(() => () => layer.dispose(), 'dsh-mcp-adapter: workspace Config layer')
  return layer
}
