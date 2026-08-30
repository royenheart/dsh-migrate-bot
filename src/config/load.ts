import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  ANCHORED_MODES,
  DEFAULT_CONFIG,
  THINKING_EFFORTS,
  type AnchoredMode,
  type IssuePrLanguage,
  type MigrateConfig,
  type ReviewPolicy,
  type ThinkingEffort,
} from './schema.ts'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return asString(value, path)
}

function asInt(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ConfigError(`${path} must be an integer >= ${min}`)
  }
  return value
}

function asPositiveNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${path} must be a number > 0`)
  }
  return value
}

function asEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ConfigError(`${path} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * Merge a parsed YAML object onto the shipped defaults and reject unknown shapes.
 * @param raw - decoded YAML root
 */
export function parseConfig(raw: unknown): MigrateConfig {
  if (raw === null || raw === undefined) {
    return {
      ...DEFAULT_CONFIG,
      dsh: { ...DEFAULT_CONFIG.dsh },
      review: { ...DEFAULT_CONFIG.review },
      prompts: {},
      issuePr: { ...DEFAULT_CONFIG.issuePr },
      loop: { ...DEFAULT_CONFIG.loop },
      watch: { ...DEFAULT_CONFIG.watch },
      secrets: { ...DEFAULT_CONFIG.secrets },
      quota: { ...DEFAULT_CONFIG.quota },
    }
  }
  if (!isRecord(raw)) throw new ConfigError('config root must be a mapping')

  const tests = raw.tests
  let testConfig: MigrateConfig['tests']
  if (tests !== undefined) {
    if (!isRecord(tests) || !Array.isArray(tests.commands) || tests.commands.length === 0) {
      throw new ConfigError('tests.commands must be a non-empty string list when tests is set')
    }
    testConfig = {
      commands: tests.commands.map((command, index) => asString(command, `tests.commands[${index}]`)),
    }
  }

  const reviewRaw = raw.review
  const policy: ReviewPolicy = reviewRaw === undefined
    ? DEFAULT_CONFIG.review.policy
    : !isRecord(reviewRaw)
      ? (() => { throw new ConfigError('review must be a mapping') })()
      : asEnum(reviewRaw.policy, 'review.policy', ['always', 'skip-if-mechanical-pass'] as const)

  const promptsRaw = raw.prompts
  const prompts: MigrateConfig['prompts'] = {}
  if (promptsRaw !== undefined) {
    if (!isRecord(promptsRaw)) throw new ConfigError('prompts must be a mapping')
    const absorption = optionalString(promptsRaw.absorption, 'prompts.absorption')
    const alignment = optionalString(promptsRaw.alignment, 'prompts.alignment')
    const fix = optionalString(promptsRaw.fix, 'prompts.fix')
    if (absorption !== undefined) prompts.absorption = absorption
    if (alignment !== undefined) prompts.alignment = alignment
    if (fix !== undefined) prompts.fix = fix
  }

  const dshRaw = raw.dsh
  const dsh = { ...DEFAULT_CONFIG.dsh }
  if (dshRaw !== undefined) {
    if (!isRecord(dshRaw)) throw new ConfigError('dsh must be a mapping')
    if (dshRaw.provider !== undefined) dsh.provider = asString(dshRaw.provider, 'dsh.provider')
    if (dshRaw.model !== undefined) dsh.model = asString(dshRaw.model, 'dsh.model')
    if (dshRaw.thinking !== undefined) dsh.thinking = asEnum(dshRaw.thinking, 'dsh.thinking', ['enabled', 'disabled'] as const)
    if (dshRaw.reasoningEffort !== undefined) {
      dsh.reasoningEffort = asEnum(dshRaw.reasoningEffort, 'dsh.reasoningEffort', THINKING_EFFORTS)
    }
    if (dshRaw.mode !== undefined) {
      dsh.mode = asEnum(dshRaw.mode, 'dsh.mode', ANCHORED_MODES) as AnchoredMode
    }
  }

  const issueRaw = raw.issuePr
  const language: IssuePrLanguage = issueRaw === undefined
    ? DEFAULT_CONFIG.issuePr.language
    : !isRecord(issueRaw)
      ? (() => { throw new ConfigError('issuePr must be a mapping') })()
      : issueRaw.language === undefined
        ? DEFAULT_CONFIG.issuePr.language
        : asEnum(issueRaw.language, 'issuePr.language', ['en', 'zh'] as const)

  const loopRaw = raw.loop
  const maxAttempts = loopRaw === undefined
    ? DEFAULT_CONFIG.loop.maxAttempts
    : !isRecord(loopRaw)
      ? (() => { throw new ConfigError('loop must be a mapping') })()
      : asInt(loopRaw.maxAttempts, 'loop.maxAttempts', 1)

  const watchRaw = raw.watch
  let watchEnabled = DEFAULT_CONFIG.watch.enabled
  if (watchRaw !== undefined) {
    if (!isRecord(watchRaw)) throw new ConfigError('watch must be a mapping')
    if (watchRaw.enabled !== undefined) {
      if (typeof watchRaw.enabled !== 'boolean') {
        throw new ConfigError('watch.enabled must be a boolean')
      }
      watchEnabled = watchRaw.enabled
    }
  }

  const secretsRaw = raw.secrets
  let apiKeyEnv = DEFAULT_CONFIG.secrets.apiKeyEnv
  if (secretsRaw !== undefined) {
    if (!isRecord(secretsRaw)) throw new ConfigError('secrets must be a mapping')
    if (secretsRaw.apiKeyEnv !== undefined) {
      apiKeyEnv = asString(secretsRaw.apiKeyEnv, 'secrets.apiKeyEnv')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        throw new ConfigError('secrets.apiKeyEnv must be a valid environment variable name')
      }
    }
  }

  const quotaRaw = raw.quota
  const quota: MigrateConfig['quota'] = {}
  if (quotaRaw !== undefined) {
    if (!isRecord(quotaRaw)) throw new ConfigError('quota must be a mapping')
    if (quotaRaw.limit !== undefined) quota.limit = asPositiveNumber(quotaRaw.limit, 'quota.limit')
  }

  return {
    dshVersion: raw.dshVersion === undefined ? DEFAULT_CONFIG.dshVersion : asString(raw.dshVersion, 'dshVersion'),
    review: { policy },
    ...(testConfig === undefined ? {} : { tests: testConfig }),
    prompts,
    dsh,
    issuePr: { language },
    loop: { maxAttempts },
    watch: { enabled: watchEnabled },
    secrets: { apiKeyEnv },
    quota,
  }
}

/**
 * Load and validate a YAML config file.
 * @param filePath - absolute or relative path
 */
export function loadConfigFile(filePath: string): MigrateConfig {
  const text = readFileSync(filePath, 'utf8')
  return parseConfig(parseYaml(text))
}

export type { ThinkingEffort }
