import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_API_KEY_ENV, DEFAULT_DEPLOY_TOKEN_ENV, type MigrateConfig } from './config/schema.ts'
import { BUILTIN_CHANNELS, resolveChannels } from './merge-reports/channels.ts'

/** Env var the dsh CLI itself reads. */
export const DSH_API_KEY_ENV = 'DEEPSEEK_API_KEY'

export interface Secrets {
  apiKey?: string
  githubToken?: string
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function jsonString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Load secrets from the environment, then from `.secrets.local.json` if present.
 * The JSON file is never committed; see `.secrets.local.json.example`.
 * @param searchRoots - directories to look for `.secrets.local.json`
 * @param options.apiKeyEnv - env / JSON key for the DeepSeek API key (default `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT`)
 */
export function loadSecrets(
  searchRoots: readonly string[],
  options: { apiKeyEnv?: string; env?: NodeJS.ProcessEnv } = {},
): Secrets {
  const env = options.env ?? process.env
  const apiKeyEnv = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const merged: Secrets = {}
  const fromEnv = firstNonEmpty(env[apiKeyEnv], env[DSH_API_KEY_ENV])
  if (fromEnv !== undefined) merged.apiKey = fromEnv
  if (env.GITHUB_TOKEN) merged.githubToken = env.GITHUB_TOKEN

  for (const root of searchRoots) {
    const file = resolve(root, '.secrets.local.json')
    if (!existsSync(file)) continue
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`${file} must be a JSON object`)
    }
    const record = parsed as Record<string, unknown>
    if (merged.apiKey === undefined) {
      const fromFile = firstNonEmpty(
        jsonString(record, apiKeyEnv),
        jsonString(record, DEFAULT_API_KEY_ENV),
        jsonString(record, DSH_API_KEY_ENV),
      )
      if (fromFile !== undefined) merged.apiKey = fromFile
    }
    if (merged.githubToken === undefined) {
      const token = jsonString(record, 'GITHUB_TOKEN')
      if (token !== undefined) merged.githubToken = token
    }
    break
  }
  return merged
}

/**
 * The environment of a check: the Action's own, without a secret it holds,
 * under its configured name or the default one the reusable workflow sets.
 * The checks need no key; this keeps one out of what they print and read from
 * their environment. It is not a sandbox (docs/design/checks.md).
 */
export function withoutSecrets(env: NodeJS.ProcessEnv, config: MigrateConfig): NodeJS.ProcessEnv {
  const names = new Set([
    config.secrets.apiKeyEnv, DEFAULT_API_KEY_ENV, DSH_API_KEY_ENV,
    config.deploy.tokenEnv, DEFAULT_DEPLOY_TOKEN_ENV,
    ...resolveChannels(config).map(channel => channel.tokenEnv), ...Object.values(BUILTIN_CHANNELS).map(channel => channel.tokenEnv),
    'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ])
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)))
}
