import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MigrateConfig } from '../config/schema.ts'
import { extractMechanicalErrors } from './errors.ts'
import { dshPeerSpecs, pinDshPeersCommand } from './peers.ts'
import { scanKeyedSlots, scanPluginShape } from './scan.ts'

export interface MechanicalResult {
  ok: boolean
  errors: string
  log: string
}

/** Optional run context so tests pin `@deepseek-ai/dsh-*` to the target tag. */
export interface MechanicalOptions {
  /** Resolved harness version (no `dsh-v` prefix), e.g. `0.1.1-rc.2`. */
  dshVersion?: string
}

function runCommand(
  command: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { ok: boolean; output: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const ok = result.status === 0
  return { ok, output }
}

function readPackageJson(root: string): unknown {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return undefined
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown
}

function packageScripts(pkg: unknown): Record<string, string> {
  if (typeof pkg !== 'object' || pkg === null) return {}
  const scripts = (pkg as Record<string, unknown>).scripts
  if (typeof scripts !== 'object' || scripts === null) return {}
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/**
 * `npm install` when node_modules is missing, then pin dsh packages to the
 * target version when one was resolved.
 */
function installCommands(root: string, pkg: unknown, dshVersion: string | undefined): string[] {
  const commands: string[] = []
  if (pkg !== undefined && !existsSync(join(root, 'node_modules'))) {
    commands.push('npm install')
  }
  if (dshVersion !== undefined && pkg !== undefined) {
    const pin = pinDshPeersCommand(dshPeerSpecs(pkg, dshVersion))
    if (pin !== undefined) commands.push(pin)
  }
  return commands
}

function runList(
  commands: readonly string[],
  root: string,
  extraEnv: NodeJS.ProcessEnv,
): MechanicalResult {
  const logs: string[] = []
  for (const command of commands) {
    const result = runCommand(command, root, extraEnv)
    logs.push(`$ ${command}\n${result.output}`)
    if (!result.ok) {
      const log = logs.join('\n')
      return { ok: false, errors: extractMechanicalErrors(result.output), log }
    }
  }
  const log = logs.join('\n')
  return { ok: true, errors: '', log }
}

/**
 * Run the configured mechanical suite (user commands replace the default suite).
 * @param root - plugin working tree
 * @param config - loaded migrate config
 * @param options - target harness version used to pin `@deepseek-ai/dsh-*`
 */
export function runMechanical(
  root: string,
  config: MigrateConfig,
  options: MechanicalOptions = {},
): MechanicalResult {
  const pkg = readPackageJson(root)
  const extraEnv: NodeJS.ProcessEnv = options.dshVersion === undefined
    ? {}
    : { DSH_MIGRATE_TARGET_VERSION: options.dshVersion }
  const prefix = installCommands(root, pkg, options.dshVersion)

  if (config.tests !== undefined) {
    return runList([...prefix, ...config.tests.commands], root, extraEnv)
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

  const scripts = packageScripts(pkg)
  const commands = [...prefix]
  if (scripts.build !== undefined) commands.push('npm run build')
  if (scripts.typecheck !== undefined) commands.push('npm run typecheck')
  else if (existsSync(join(root, 'tsconfig.json'))) commands.push('npx tsc --noEmit')
  if (scripts.test !== undefined) commands.push('npm test')

  const ran = runList(commands, root, extraEnv)
  if (logs.length === 0) return ran
  return {
    ok: ran.ok,
    errors: ran.errors,
    log: `${logs.join('\n')}\n${ran.log}`,
  }
}
