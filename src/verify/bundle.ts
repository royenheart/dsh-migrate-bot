import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
  /** False when the row or one of its parent groups is disabled at build time. */
  enabled: boolean
}

/** One plugin's declared rows, with the directory that owns them. */
export interface PluginBundle {
  dir: string
  name: string
  /** Directory of the patch file, the anchor for its relative module paths. */
  patchDir: string
  rows: BundleRow[]
}

/** Whether a row declares a literal disabled gate; expressions stay enabled here. */
function disabled(record: Record<string, unknown>): boolean {
  return record.disabled === true
}

/** Collect entry rows from one entry-list array, descending through groups and preset plugins. */
function collectEntries(value: unknown, active: boolean, rows: BundleRow[]): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name === '') continue
    const enabled = active && !disabled(record)
    const config = record.config
    const presetId = typeof config === 'object' && config !== null && typeof (config as Record<string, unknown>).id === 'string'
      ? (config as Record<string, unknown>).id as string
      : undefined
    rows.push({
      ...(typeof record.id === 'string' && record.id !== '' ? { id: record.id } : {}),
      name: record.name,
      enabled,
      ...(record.name === '@deepseek-ai/dsh-agent-preset' && presetId !== undefined ? { presetId } : {}),
    })
    if (record.group === true && Array.isArray(config)) collectEntries(config, enabled, rows)
    else if (record.name === '@deepseek-ai/dsh-agent-preset' && typeof config === 'object' && config !== null) {
      const plugins = (config as Record<string, unknown>).plugins
      if (Array.isArray(plugins)) collectEntries(plugins, enabled, rows)
    }
  }
}

/** Walk the patch operations and read only their insert entry lists. */
function rowsOf(value: unknown): BundleRow[] {
  const rows: BundleRow[] = []
  if (!Array.isArray(value)) return rows
  for (const operation of value) {
    if (typeof operation !== 'object' || operation === null) continue
    const insert = (operation as Record<string, unknown>).insert
    collectEntries(insert, true, rows)
  }
  return rows
}

/** Read every plugin's bundle patch and return the module rows it declares. */
export function pluginBundles(workdir: string): PluginBundle[] {
  const bundles: PluginBundle[] = []
  for (const plugin of findPlugins(workdir)) {
    const dsh = plugin.manifest.dsh
    const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>).bundle : undefined
    const patch = typeof bundle === 'object' && bundle !== null ? (bundle as Record<string, unknown>).patch : undefined
    if (typeof patch !== 'string') continue
    try {
      const parsed: unknown = parse(readFileSync(join(workdir, plugin.dir, patch), 'utf8'), { logLevel: 'silent' })
      bundles.push({ dir: plugin.dir, name: plugin.name, patchDir: dirname(patch), rows: rowsOf(parsed) })
    } catch {
      // A malformed patch is a migration failure elsewhere; this check only sees what parses.
    }
  }
  return bundles
}

/** The agent presets plugins declare through the official preset row. */
export function declaredPresets(workdir: string): { id: string; plugin: string }[] {
  return pluginBundles(workdir).flatMap(bundle => bundle.rows.flatMap(row => row.presetId === undefined || !row.enabled ? [] : [{ id: row.presetId, plugin: bundle.name }]))
}

/** Whether a row's specifier resolves from the plugin or the target dsh installation. */
function resolves(specifier: string, fromPlugin: NodeJS.Require, fromDsh: NodeJS.Require | undefined): boolean {
  const requireFrom = specifier.startsWith('@deepseek-ai/') ? fromDsh ?? fromPlugin : fromPlugin
  try {
    requireFrom.resolve(specifier)
    return true
  } catch {
    if (fromDsh !== undefined && fromDsh !== fromPlugin) {
      try {
        fromDsh.resolve(specifier)
        return true
      } catch {
        // Report the unresolved row below.
      }
    }
    return false
  }
}

/** Declared rows whose package or subpath does not resolve in the target install. */
export function unresolvedBundleRows(workdir: string, bin: string): BundleRow[] {
  if (!existsSync(bin)) return []
  const fromDsh = createRequire(realpathSync(bin))
  const unresolved: BundleRow[] = []
  for (const bundle of pluginBundles(workdir)) {
    const fromPlugin = createRequire(join(workdir, bundle.dir, bundle.patchDir, 'package.json'))
    for (const row of bundle.rows) {
      if (!row.enabled || row.name.startsWith('cordis:')) continue
      if (!resolves(row.name, fromPlugin, fromDsh)) unresolved.push(row)
    }
  }
  return unresolved
}
