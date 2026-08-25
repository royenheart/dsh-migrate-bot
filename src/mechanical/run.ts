import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MigrateConfig } from '../config/schema.ts'
import { extractMechanicalErrors } from './errors.ts'
import { scanKeyedSlots, scanPluginShape } from './scan.ts'

export interface MechanicalResult {
  ok: boolean
  errors: string
  log: string
}

function runCommand(command: string, cwd: string): { ok: boolean; output: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: process.env,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const ok = result.status === 0
  return { ok, output }
}

function packageScripts(root: string): Record<string, string> {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return {}
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (typeof pkg !== 'object' || pkg === null) return {}
  const scripts = (pkg as Record<string, unknown>).scripts
  if (typeof scripts !== 'object' || scripts === null) return {}
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/**
 * Run the configured mechanical suite (user commands replace the default suite).
 * @param root - plugin working tree
 * @param config - loaded migrate config
 */
export function runMechanical(root: string, config: MigrateConfig): MechanicalResult {
  if (config.tests !== undefined) {
    const logs: string[] = []
    for (const command of config.tests.commands) {
      const result = runCommand(command, root)
      logs.push(`$ ${command}\n${result.output}`)
      if (!result.ok) {
        const log = logs.join('\n')
        return { ok: false, errors: extractMechanicalErrors(result.output), log }
      }
    }
    const log = logs.join('\n')
    return { ok: true, errors: '', log }
  }

  const logs: string[] = []
  const shape = scanPluginShape(root)
  if (shape.length > 0) {
    const text = shape.map(item => `error: ${item.message}`).join('\n')
    logs.push(text)
    return { ok: false, errors: text, log: text }
  }

  const slots = scanKeyedSlots(root)
  if (slots.length > 0) {
    const text = slots.map(item => `error: ${item.file}: ${item.message}`).join('\n')
    logs.push(text)
    return { ok: false, errors: text, log: text }
  }

  const scripts = packageScripts(root)
  const commands: string[] = []
  if (existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'node_modules'))) {
    // already installed or lockfile present
  } else if (existsSync(join(root, 'package.json'))) {
    commands.push('npm install')
  }
  if (scripts.build !== undefined) commands.push('npm run build')
  if (scripts.typecheck !== undefined) commands.push('npm run typecheck')
  else if (existsSync(join(root, 'tsconfig.json'))) commands.push('npx tsc --noEmit')
  if (scripts.test !== undefined) commands.push('npm test')

  for (const command of commands) {
    const result = runCommand(command, root)
    logs.push(`$ ${command}\n${result.output}`)
    if (!result.ok) {
      const log = logs.join('\n')
      return { ok: false, errors: extractMechanicalErrors(result.output), log }
    }
  }

  return { ok: true, errors: '', log: logs.join('\n') }
}
