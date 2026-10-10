import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { configSchema, type MigrateConfig } from './schema.ts'
import { BUILTIN_CHANNELS } from '../merge-reports/channels.ts'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Keys and values that 1.0 renamed or removed, with what replaced them.
 *
 * Strict validation already rejects them; this table only makes the error name
 * the replacement. It is deleted in 2.0.
 */
const REPLACED: readonly { path: readonly string[]; value?: string; replacement: string }[] = [
  { path: ['dshVersion'], replacement: 'renamed to `target`' },
  { path: ['dsh'], replacement: 'renamed to `agent`; `dsh.mode` was removed because the agent runtime composes no preset' },
  { path: ['loop'], replacement: 'renamed to `repair` (`loop.maxAttempts` is `repair.maxAttempts`)' },
  { path: ['watch'], replacement: 'removed; an unchanged target release is always skipped unless the run is forced' },
  { path: ['issuePr'], replacement: 'removed; every issue and pull request body is English' },
  { path: ['verify'], replacement: 'renamed to `checks` (`verify.boot` is `checks.boot`, `verify.web` is `checks.web`)' },
  { path: ['e2e'], replacement: 'moved to `checks.e2e` (`e2e.gate` is `checks.e2e.failurePolicy`)' },
  { path: ['feedback'], replacement: 'renamed to `reports`' },
  { path: ['prompts', 'absorption'], replacement: 'renamed to `prompts.overlap`' },
  { path: ['prompts', 'alignment'], replacement: 'renamed to `prompts.extensionPoints`' },
  { path: ['prompts', 'fix'], replacement: 'renamed to `prompts.repair`' },
  { path: ['deploy', 'liveView'], replacement: 'renamed to `deploy.logStream`' },
  {
    path: ['review', 'policy'],
    value: 'skip-if-mechanical-pass',
    replacement: 'replaced by `when-checks-fail`, which also requires the boot, web and end-to-end checks to pass',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valueAt(document: unknown, path: readonly string[]): unknown {
  let current = document
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/** The first replaced key or value in a decoded document, as an error message. */
function replacedKey(document: unknown): string | undefined {
  for (const entry of REPLACED) {
    const found = valueAt(document, entry.path)
    if (found === undefined || (entry.value !== undefined && found !== entry.value)) continue
    const subject = entry.value === undefined ? entry.path.join('.') : `${entry.path.join('.')}: \`${entry.value}\``
    return `${subject} was ${entry.replacement}`
  }
  return undefined
}

/** Report channels that are not built in must say where, how, and what to send. */
function checkUserChannels(config: MigrateConfig): void {
  for (const [id, channel] of Object.entries(config.reports.channels)) {
    if (id in BUILTIN_CHANNELS) continue
    for (const field of ['repo', 'method', 'prompt'] as const) {
      if (channel[field] === undefined) {
        throw new ConfigError(`reports.channels.${id}.${field} is required for a channel that is not built in`)
      }
    }
  }
}

/**
 * Validate a decoded YAML document and fill in the defaults.
 * @param raw - the decoded document; `null` or `undefined` is an empty file.
 */
export function parseConfig(raw: unknown): MigrateConfig {
  const document = raw ?? {}
  const replaced = replacedKey(document)
  if (replaced !== undefined) throw new ConfigError(replaced)
  const parsed = configSchema.safeParse(document)
  if (!parsed.success) throw new ConfigError(z.prettifyError(parsed.error))
  checkUserChannels(parsed.data)
  return parsed.data
}

/**
 * Load and validate a configuration file.
 * @param filePath - absolute or relative path.
 */
export function loadConfigFile(filePath: string): MigrateConfig {
  return parseConfig(parseYaml(readFileSync(filePath, 'utf8')))
}
