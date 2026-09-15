import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MigrateConfig } from '../config/schema.ts'
import { extractMechanicalErrors } from './errors.ts'
import { dshPeerSpecs, pinDshPeersCommand } from './peers.ts'
import { scanKeyedSlots, scanPluginShape } from './scan.ts'
import { typecheckCommand } from './typecheck.ts'
import { inline } from '../render/text.ts'

export interface MechanicalResult {
  ok: boolean
  errors: string
  log: string
  /**
   * How many commands ran that were checks rather than installs.
   *
   * Zero means the plugin declares no build, typecheck or test command and no
   * suite is configured, so `ok` says nothing about whether the plugin works —
   * a distinction a caller that publishes on the strength of this result has to
   * be able to make.
   */
  checks: number
}

/** Optional run context so tests pin `@deepseek-ai/dsh-*` to the target tag. */
export interface MechanicalOptions {
  /** Resolved harness version (no `dsh-v` prefix), e.g. `0.1.1-rc.2`. */
  dshVersion?: string
  /**
   * Watchdog for each command. A hung `npm test` must not hold the job until
   * the runner's own six-hour limit.
   */
  timeoutMs?: number
}

function runCommand(
  command: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs?: number,
): { ok: boolean; output: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: 'SIGKILL' as const }),
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    const seconds = Math.round((timeoutMs ?? 0) / 1000)
    return { ok: false, output: `${output}\nerror: command timed out after ${seconds}s (watchdog): ${command}` }
  }
  return { ok: result.status === 0, output }
}

function readPackageJson(root: string): unknown {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return undefined
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown
}

/**
 * The `name` in a plugin's `package.json`, when that file holds a usable one.
 *
 * The package.json belongs to the tree being migrated, so a file that is not
 * JSON, or a name that is not a non-empty string, is nothing rather than a
 * crash: this is read once to name the plugin in the boot probe's profile and
 * again to name it in a report, and neither is worth failing a run over.
 * @param workdir - the plugin working tree.
 */
export function readPackageName(workdir: string): string | undefined {
  try {
    const pkg = readPackageJson(workdir)
    if (typeof pkg !== 'object' || pkg === null) return undefined
    const name = (pkg as { name?: unknown }).name
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * The name a report calls the plugin by.
 *
 * That name lands in an issue title and an issue body, so it is collapsed to one
 * line and bounded like every other value that came from outside this Action; a
 * tree with no usable name is called `plugin` rather than nothing.
 * @param workdir - the plugin working tree.
 */
export function readPluginName(workdir: string): string {
  const name = readPackageName(workdir)
  if (name === undefined) return 'plugin'
  const collapsed = inline(name, 80)
  return collapsed === '' ? 'plugin' : collapsed
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
  timeoutMs: number | undefined,
): MechanicalResult {
  const logs: string[] = []
  for (const command of commands) {
    const result = runCommand(command, root, extraEnv, timeoutMs)
    logs.push(`$ ${command}\n${result.output}`)
    if (!result.ok) {
      const log = logs.join('\n')
      return { ok: false, errors: extractMechanicalErrors(result.output), log, checks: 0 }
    }
  }
  const log = logs.join('\n')
  return { ok: true, errors: '', log, checks: 0 }
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
  const timeoutMs = options.timeoutMs

  if (config.tests !== undefined) {
    return { ...runList([...prefix, ...config.tests.commands], root, extraEnv, timeoutMs), checks: config.tests.commands.length }
  }

  const logs: string[] = []
  const shape = scanPluginShape(root)
  if (shape.length > 0) {
    const text = shape.map(item => `error: ${item.message}`).join('\n')
    logs.push(text)
    return { ok: false, errors: text, log: text, checks: 0 }
  }

  const slots = scanKeyedSlots(root)
  if (slots.length > 0) {
    const text = slots.map(item => `${item.file}: ${item.message}`).join('\n')
    logs.push(`error: ${text}`)
    return { ok: false, errors: text, log: `error: ${text}`, checks: 0 }
  }

  const scripts = packageScripts(pkg)
  const commands = [...prefix]
  if (scripts.build !== undefined) commands.push('npm run build')
  if (scripts.typecheck !== undefined) commands.push('npm run typecheck')
  else if (existsSync(join(root, 'tsconfig.json'))) {
    commands.push(typecheckCommand(root, fileURLToPath(import.meta.url)))
  }
  if (scripts.test !== undefined) commands.push('npm test')

  const ran = runList(commands, root, extraEnv, timeoutMs)
  const checks = commands.length - prefix.length
  if (logs.length === 0) return { ...ran, checks }
  return {
    ok: ran.ok,
    errors: ran.errors,
    log: `${logs.join('\n')}\n${ran.log}`,
    checks,
  }
}
