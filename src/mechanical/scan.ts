import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

/** Slots that dsh treats as keyed — omitting `key` throws at load (rc.8+). */
export const KEYED_SLOTS = [
  'settings.plugin.item',
  'conversation.chat.node',
  'conversation.chat.toolview',
  'tool.call.toolview',
] as const

export interface ScanFinding {
  file: string
  message: string
}

function walk(dir: string, files: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'lib') continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, files)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(extname(entry))) files.push(path)
  }
}

/**
 * Heuristic: a `slots.register({...})` that names a keyed slot must include `key:`.
 * @param root - plugin working tree
 */
export function scanKeyedSlots(root: string): ScanFinding[] {
  const files: string[] = []
  walk(join(root, 'src'), files)
  walk(join(root, 'client'), files)
  if (existsSync(join(root, 'client.js'))) files.push(join(root, 'client.js'))
  const findings: ScanFinding[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const slot of KEYED_SLOTS) {
      const named = text.includes(`'${slot}'`) || text.includes(`"${slot}"`)
      if (!named) continue
      const register = /slots\.register\(\s*\{([\s\S]*?)\}\s*,/g
      let match: RegExpExecArray | null
      while ((match = register.exec(text)) !== null) {
        const block = match[1] ?? ''
        if (!block.includes(slot)) continue
        if (!/\bkey\s*:/.test(block)) {
          findings.push({
            file,
            message: `keyed slot "${slot}" is registered without options.key`,
          })
        }
      }
    }
  }
  return findings
}

export interface ShapeFinding {
  message: string
}

/**
 * Check the out-of-tree plugin package contract used by `dsh plugin add`.
 * @param root - plugin working tree
 */
export function scanPluginShape(root: string): ShapeFinding[] {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return [{ message: 'package.json is missing' }]
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (typeof pkg !== 'object' || pkg === null) return [{ message: 'package.json is not an object' }]
  const record = pkg as Record<string, unknown>
  const findings: ShapeFinding[] = []
  const dsh = record.dsh
  if (dsh === undefined) {
    findings.push({ message: 'package.json has no dsh.bundle; the package will not activate as a plugin' })
    return findings
  }
  if (typeof dsh !== 'object' || dsh === null) {
    findings.push({ message: 'package.json dsh block must be an object' })
    return findings
  }
  const bundle = (dsh as Record<string, unknown>).bundle
  if (typeof bundle !== 'object' || bundle === null) {
    findings.push({ message: 'dsh.bundle is required for an out-of-tree plugin' })
  } else {
    const patch = (bundle as Record<string, unknown>).patch
    if (typeof patch !== 'string') {
      findings.push({ message: 'dsh.bundle.patch must point at cordis.patch.yml' })
    } else if (!existsSync(join(root, patch))) {
      findings.push({ message: `dsh.bundle.patch file is missing: ${patch}` })
    }
  }
  return findings
}
