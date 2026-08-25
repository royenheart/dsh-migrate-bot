import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Default GitHub Actions secret / env var that holds the DeepSeek API key. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY_DSH_MIGRATE_BOT'

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
