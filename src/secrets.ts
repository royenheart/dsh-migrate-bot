import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Secrets {
  DEEPSEEK_API_KEY?: string
  GITHUB_TOKEN?: string
}

/**
 * Load secrets from the environment, then from `.secrets.local.json` if present.
 * The JSON file is never committed; see `.secrets.local.json.example`.
 * @param searchRoots - directories to look for `.secrets.local.json`
 */
export function loadSecrets(searchRoots: readonly string[]): Secrets {
  const merged: Secrets = {}
  if (process.env.DEEPSEEK_API_KEY) merged.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
  if (process.env.GITHUB_TOKEN) merged.GITHUB_TOKEN = process.env.GITHUB_TOKEN

  for (const root of searchRoots) {
    const file = resolve(root, '.secrets.local.json')
    if (!existsSync(file)) continue
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`${file} must be a JSON object`)
    }
    const record = parsed as Record<string, unknown>
    if (merged.DEEPSEEK_API_KEY === undefined && typeof record.DEEPSEEK_API_KEY === 'string') {
      merged.DEEPSEEK_API_KEY = record.DEEPSEEK_API_KEY
    }
    if (merged.GITHUB_TOKEN === undefined && typeof record.GITHUB_TOKEN === 'string') {
      merged.GITHUB_TOKEN = record.GITHUB_TOKEN
    }
    break
  }
  return merged
}
