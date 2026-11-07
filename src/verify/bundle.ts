import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { findPlugins } from '../plugins.ts'

/** One entry a plugin's bundle patch declares. */
export interface BundleRow {
  /** The entry id, when the row names one. */
  id?: string
  /** The module or package specifier the row mounts. */
  name: string
  /** The agent preset id when this row declares one. */
  presetId?: string
  /** The plugin that owns this row, when known. */
  plugin?: string
  /** False when the row or one of its parent groups is disabled at build time. */
  enabled: boolean
  /** Whether this row's own gate is enabled, before parent propagation. */
  ownEnabled?: boolean
  /** Patch directory that anchors a relative module specifier. */
  baseDir?: string
  /** The containing group or preset row, for cascade updates. */
  parentId?: string
  /** Whether this row mounts a group of child entries. */
  group?: boolean
  /** True when the load-time disabled gate cannot be evaluated statically. */
  unknownDisabled?: boolean
}

/** One plugin's declared rows, with the directory that owns them. */
export interface PluginBundle {
  dir: string
  name: string
  /** Directories of the patch files, anchors for their relative module paths. */
  patchDirs: string[]
  rows: BundleRow[]
  /** Why the patch could not be read or parsed, when it could not. */
  error?: string
}

/** Evaluate a known disabled gate; undefined means the host must decide at load time. */
function evaluateDisabledExact(value: unknown): boolean | undefined {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  const expression = typeof value === 'string'
    ? value
    : typeof value === 'object' && typeof (value as Record<string, unknown>).__jsExpr === 'string'
      ? (value as Record<string, unknown>).__jsExpr as string
      : undefined
  if (expression === undefined) return undefined
  if (expression.trim() === 'true') return true
  if (expression.trim() === 'false') return false
  const platform = /^process\.platform\s*(===|!==)\s*['"]([^'"]+)['"]$/.exec(expression.trim())
  if (platform === null) return undefined
  const equal = process.platform === platform[2]
  return platform[1] === '===' ? equal : !equal
}

/** Legacy/static fallback: an unevaluable expression stays enabled and advisory. */
function evaluateDisabled(value: unknown): boolean {
  return evaluateDisabledExact(value) ?? false
}

/** Whether any value in a parsed patch names the agent-preset module. */
function mentionsPreset(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mentionsPreset)
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.name === '@deepseek-ai/dsh-agent-preset') return true
  return Object.values(record).some(mentionsPreset)
}

/** Names of plugins whose raw patch structurally mentions an agent-preset row, without installing a target. */
export function presetPluginNames(workdir: string): string[] {
  const names: string[] = []
  for (const plugin of findPlugins(workdir)) {
    const dsh = plugin.manifest.dsh
    const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>).bundle : undefined
    const patch = typeof bundle === 'object' && bundle !== null ? (bundle as Record<string, unknown>).patch : undefined
    const files = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
    for (const file of files) {
      if (typeof file !== 'string') continue
      try {
        if (mentionsPreset(parse(readFileSync(join(workdir, plugin.dir, file), 'utf8'), { logLevel: 'silent' }))) {
          names.push(plugin.name)
          break
        }
      } catch {
        // An unreadable patch cannot prove a preset; the web check reports it separately.
      }
    }
  }
  return names
}

/** Collect entry rows from one entry-list array, descending through groups and preset plugins. */
function collectEntries(value: unknown, baseDir: string, rows: BundleRow[], byId: Map<string, BundleRow>, parentId?: string): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name === '') continue
    const ownEnabled = !evaluateDisabled(record.disabled)
    const config = record.config
    const presetId = typeof config === 'object' && config !== null && typeof (config as Record<string, unknown>).id === 'string'
      ? (config as Record<string, unknown>).id as string
      : undefined
    const row: BundleRow = {
      ...(typeof record.id === 'string' && record.id !== '' ? { id: record.id } : {}),
      name: record.name,
      enabled: ownEnabled,
      ownEnabled,
      baseDir,
      ...(parentId === undefined ? {} : { parentId }),
      ...(record.name === '@deepseek-ai/dsh-agent-preset' && presetId !== undefined ? { presetId } : {}),
      ...(record.group === true ? { group: true } : {}),
    }
    rows.push(row)
    if (row.id !== undefined) byId.set(row.id, row)
    if (record.group === true && Array.isArray(config)) collectEntries(config, baseDir, rows, byId, row.id)
    else if (record.name === '@deepseek-ai/dsh-agent-preset' && typeof config === 'object' && config !== null) {
      const plugins = (config as Record<string, unknown>).plugins
      if (Array.isArray(plugins)) collectEntries(plugins, baseDir, rows, byId, row.id)
    }
  }
}

/** Remove a row's descendants from the collected list and id map. */
function removeDescendants(id: string, rows: BundleRow[], byId: Map<string, BundleRow>): void {
  const removed = new Set<string>()
  const visit = (parent: string): void => {
    for (const row of rows) {
      if (row.parentId !== parent || row.id === undefined || removed.has(row.id)) continue
      removed.add(row.id)
      byId.delete(row.id)
      visit(row.id)
    }
  }
  visit(id)
  if (removed.size > 0) {
    const kept = rows.filter(row => row.id === undefined || !removed.has(row.id))
    rows.length = 0
    rows.push(...kept)
  }
}

/** Recompute effective enabled state from the final parent tree after all overrides. */
function recompute(rows: BundleRow[], byId: Map<string, BundleRow>): void {
  for (const row of rows) {
    const parent = row.parentId === undefined ? undefined : byId.get(row.parentId)
    row.enabled = (parent?.enabled ?? true) && (row.ownEnabled ?? true)
  }
}

/** Apply later id-targeted patches (disabled flags and config replacement) to collected rows. */
function applyOverrides(operations: unknown[], rows: BundleRow[], byId: Map<string, BundleRow>): void {
  for (const operation of operations) {
    if (typeof operation !== 'object' || operation === null) continue
    const record = operation as Record<string, unknown>
    if (typeof record.id !== 'string') continue
    const row = byId.get(record.id)
    if (row === undefined) continue
    if ('disabled' in record) row.ownEnabled = !evaluateDisabled(record.disabled)
    if (row.name === '@deepseek-ai/dsh-agent-preset' && typeof record.config === 'object' && record.config !== null) {
      const current = (record.config as Record<string, unknown>).id
      if (typeof current === 'string') row.presetId = current
    }
    if (row.group === true && Array.isArray(record.config)) {
      removeDescendants(row.id ?? '', rows, byId)
      collectEntries(record.config, row.baseDir ?? '.', rows, byId, row.id)
    }
  }
  recompute(rows, byId)
}

/** Read one patch file's operations into rows. */
function rowsOf(value: unknown, baseDir: string, rows: BundleRow[], byId: Map<string, BundleRow>): void {
  if (!Array.isArray(value)) return
  for (const operation of value) {
    if (typeof operation !== 'object' || operation === null) continue
    const record = operation as Record<string, unknown>
    const parent = typeof record.id === 'string' ? byId.get(record.id) : undefined
    collectEntries(record.insert, baseDir, rows, byId, parent?.id)
  }
  applyOverrides(value, rows, byId)
}

/** Read every plugin's bundle patch and return the module rows it declares. */
export function pluginBundles(workdir: string, bin?: string): PluginBundle[] {
  if (bin !== undefined) {
    const target = targetBundles(workdir, bin)
    if (target !== undefined) return target
  }
  const bundles: PluginBundle[] = []
  for (const plugin of findPlugins(workdir)) {
    const dsh = plugin.manifest.dsh
    const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>).bundle : undefined
    const patch = typeof bundle === 'object' && bundle !== null ? (bundle as Record<string, unknown>).patch : undefined
    const declared = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
    if (!declared.every(file => typeof file === 'string' && file !== '')) continue
    const patchDirs = declared.map(file => dirname(file))
    const rows: BundleRow[] = []
    const byId = new Map<string, BundleRow>()
    try {
      for (const file of declared) {
        const parsed: unknown = parse(readFileSync(join(workdir, plugin.dir, file), 'utf8'), { logLevel: 'silent' })
        if (!Array.isArray(parsed)) throw new Error('the patch must be a top-level YAML array')
        rowsOf(parsed, dirname(file), rows, byId)
      }
      bundles.push({ dir: plugin.dir, name: plugin.name, patchDirs, rows })
    } catch (error) {
      bundles.push({ dir: plugin.dir, name: plugin.name, patchDirs, rows: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return bundles
}

/** The agent presets plugins declare through the official preset row. */
export function declaredPresets(workdir: string, bin?: string): { id: string; plugin: string; unknown?: boolean }[] {
  return pluginBundles(workdir, bin).flatMap(bundle => bundle.rows.flatMap(row => row.presetId === undefined || !row.enabled ? [] : [{ id: row.presetId, plugin: row.plugin ?? bundle.name, ...(row.unknownDisabled === true ? { unknown: true } : {}) }]))
}

/** The installed dsh package root, walking up from its executable. */
function dshPackageRoot(bin: string): string | undefined {
  let dir = dirname(realpathSync(bin))
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === '@deepseek-ai/dsh') return dir
    } catch {
      // Keep walking to the package boundary.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Whether a row's specifier resolves from the plugin or the target dsh installation. */
function resolves(specifier: string, fromPlugin: NodeJS.Require, fromDsh: NodeJS.Require | undefined): boolean {
  const candidates = specifier.startsWith('@deepseek-ai/') ? [fromDsh, fromPlugin] : [fromPlugin, fromDsh]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      candidate.resolve(specifier)
      return true
    } catch {
      // Try the other side before reporting the row.
    }
  }
  return false
}

/** Whether a local plugin package has a loadable entry for a name; the probe profile links every plugin. */
function localModuleResolves(name: string, local: Map<string, string>): boolean {
  for (const [packageName, dir] of local) {
    if (name === packageName) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main?: unknown }
        if (typeof manifest.main === 'string' && existsSync(join(dir, manifest.main))) return true
      } catch {
        return false
      }
      return existsSync(join(dir, 'index.js'))
    }
    if (name.startsWith(`${packageName}/`)) return existsSync(join(dir, name.slice(packageName.length + 1)))
  }
  return false
}

/** Compose all plugin bundle patches through the target dsh's own patch loader. */
function targetBundles(workdir: string, bin: string): PluginBundle[] | undefined {
  if (!existsSync(bin)) return undefined
  const root = dshPackageRoot(bin)
  if (root === undefined) return undefined
  let app: {
    bundlePatchFiles?: (bundle: unknown) => string[]
    loadOverlayPatches?: (name: string, path: string) => unknown[]
    composeEntries?: (layers: unknown[][]) => unknown[]
  }
  try {
    app = createRequire(join(root, 'package.json'))('@deepseek-ai/dsh-app-boot') as typeof app
  } catch {
    return undefined
  }
  if (app.bundlePatchFiles === undefined || app.loadOverlayPatches === undefined || app.composeEntries === undefined) return undefined
  const layer: unknown[][] = []
  const patchDirs: string[] = []
  const errors: string[] = []
  const presetOwners = new Map<string, string>()
  const collectPresetOwners = (value: unknown, pluginName: string): void => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const config = entry.config
      if (entry.name === '@deepseek-ai/dsh-agent-preset' && typeof config === 'object' && config !== null && typeof (config as Record<string, unknown>).id === 'string') presetOwners.set((config as Record<string, unknown>).id as string, pluginName)
      collectPresetOwners(entry.insert, pluginName)
    }
  }
  for (const plugin of findPlugins(workdir)) {
    const dsh = plugin.manifest.dsh
    const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>).bundle : undefined
    if (typeof bundle !== 'object' || bundle === null) continue
    try {
      for (const file of app.bundlePatchFiles(bundle)) {
        patchDirs.push(dirname(file))
        const patches = app.loadOverlayPatches!(plugin.name, join(workdir, plugin.dir, file))
        layer.push(patches)
        collectPresetOwners(patches, plugin.name)
      }
    } catch (error) {
      errors.push(`${plugin.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const composed = (): PluginBundle => ({ dir: '', name: '(composed)', patchDirs, rows: [] })
  if (layer.length === 0) return [{ ...composed(), ...(errors.length === 0 ? {} : { error: errors.join('; ') }) }]
  const rows: BundleRow[] = []
  const byId = new Map<string, BundleRow>()
  const baseDir = patchDirs[0] ?? '.'
  const flatten = (value: unknown, parentId?: string): void => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.name !== 'string' || entry.name === '') continue
      const disabled = evaluateDisabledExact(entry.disabled)
      const ownEnabled = disabled === undefined ? true : !disabled
      const config = entry.config
      const presetId = typeof config === 'object' && config !== null && typeof (config as Record<string, unknown>).id === 'string'
        ? (config as Record<string, unknown>).id as string
        : undefined
      const row: BundleRow = {
        ...(typeof entry.id === 'string' && entry.id !== '' ? { id: entry.id } : {}),
        name: entry.name,
        enabled: ownEnabled,
        ownEnabled,
        baseDir,
        ...(parentId === undefined ? {} : { parentId }),
        ...(entry.name === '@deepseek-ai/dsh-agent-preset' && presetId !== undefined ? { presetId } : {}),
        ...(entry.group === true ? { group: true } : {}),
        ...(disabled === undefined && entry.disabled !== undefined ? { unknownDisabled: true } : {}),
      }
      rows.push(row)
      if (row.id !== undefined) byId.set(row.id, row)
      if (entry.group === true && Array.isArray(config)) flatten(config, row.id)
      else if (entry.name === '@deepseek-ai/dsh-agent-preset' && typeof config === 'object' && config !== null) {
        const plugins = (config as Record<string, unknown>).plugins
        if (Array.isArray(plugins)) flatten(plugins, row.id)
      }
    }
  }
  try {
    flatten(app.composeEntries!(layer))
    recompute(rows, byId)
    for (const row of rows) {
      if (row.presetId === undefined) continue
      const owner = presetOwners.get(row.presetId)
      if (owner !== undefined) row.plugin = owner
    }
    return [{ ...composed(), rows, ...(errors.length === 0 ? {} : { error: errors.join('; ') }) }]
  } catch (error) {
    return [{ ...composed(), error: `composition failed: ${error instanceof Error ? error.message : String(error)}` }]
  }
}

/** Declared rows whose package or subpath does not resolve in the target install. */
export function unresolvedBundleRows(workdir: string, bin: string): BundleRow[] {
  if (!existsSync(bin)) return []
  const root = dshPackageRoot(bin)
  const fromDsh = createRequire(root === undefined ? realpathSync(bin) : join(root, 'package.json'))
  const local = new Map(findPlugins(workdir).map(plugin => [plugin.name, join(workdir, plugin.dir)]))
  const pluginRequires = findPlugins(workdir).map(plugin => createRequire(join(workdir, plugin.dir, 'package.json')))
  const unresolved: BundleRow[] = []
  for (const bundle of pluginBundles(workdir, bin)) {
    for (const row of bundle.rows) {
      if (!row.enabled || row.name.startsWith('cordis:')) continue
      if (row.name.startsWith('file://')) {
        try { if (existsSync(fileURLToPath(row.name))) continue } catch { /* advisory: an invalid file URL cannot resolve */ }
        unresolved.push(row)
        continue
      }
      if (localModuleResolves(row.name, local)) continue
      const anchors = [...new Set([row.baseDir ?? '.', ...bundle.patchDirs, '.', ...findPlugins(workdir).map(plugin => plugin.dir)])]
      let resolved = false
      for (const requireFrom of pluginRequires) {
        if (resolved) break
        resolved = resolves(row.name, requireFrom, fromDsh)
      }
      for (const dir of anchors) {
        if (resolved) break
        resolved = resolves(row.name, createRequire(join(workdir, bundle.dir, dir, 'package.json')), fromDsh)
      }
      if (!resolved) unresolved.push(row)
    }
  }
  return unresolved
}
