import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  DEFAULT_CONFIG,
  PRESET_ID_PATTERN,
  REMOVED_PRESET_IDS,
  THINKING_EFFORTS,
  type IssuePrLanguage,
  type MigrateConfig,
  type ReviewPolicy,
  type ThinkingEffort,
} from './schema.ts'
import { BUILTIN_CHANNELS } from '../feedback/channels.ts'

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

function asPresetId(value: unknown, path: string): string {
  const id = asString(value, path)
  if ((REMOVED_PRESET_IDS as readonly string[]).includes(id)) {
    throw new ConfigError(
      `${path}: preset '${id}' was installed from dsh-anchored-standard, which this Action no longer ships;`
      + " use 'standard'",
    )
  }
  if (!PRESET_ID_PATTERN.test(id)) {
    throw new ConfigError(
      `${path} must be a dsh agent preset id (lowercase letters, digits, and dashes;`
      + ' shipped ids: standard, minimal, cordis, ptc)',
    )
  }
  return id
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(`${path} must be a boolean`)
  return value
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FEEDBACK_METHODS = ['issue', 'pull', 'issue+pull', 'discussion'] as const

/**
 * Parse one feedback channel.
 *
 * A built-in channel inherits every target field from its shipped default, so
 * `enabled: true` is the whole configuration. A channel the user names must
 * carry `repo`, `method`, and `prompt`: without a prompt there is nothing to
 * run, and without a target there is nowhere to deliver it.
 * @param id - channel id, which is also the key in `feedback.channels`.
 * @param raw - the channel's YAML value.
 */
function parseFeedbackChannel(id: string, raw: unknown): MigrateConfig['feedback']['channels'][string] {
  const path = `feedback.channels.${id}`
  if (!isRecord(raw)) throw new ConfigError(`${path} must be a mapping`)
  const channel: MigrateConfig['feedback']['channels'][string] = { enabled: false }
  if (raw.enabled !== undefined) channel.enabled = asBoolean(raw.enabled, `${path}.enabled`)
  if (raw.repo !== undefined) {
    const repo = asString(raw.repo, `${path}.repo`)
    if (!REPO_SLUG.test(repo)) throw new ConfigError(`${path}.repo must be "owner/name"`)
    channel.repo = repo
  }
  if (raw.method !== undefined) channel.method = asEnum(raw.method, `${path}.method`, FEEDBACK_METHODS)
  if (raw.tokenEnv !== undefined) {
    const tokenEnv = asString(raw.tokenEnv, `${path}.tokenEnv`)
    if (!ENV_NAME.test(tokenEnv)) {
      throw new ConfigError(`${path}.tokenEnv must be a valid environment variable name`)
    }
    channel.tokenEnv = tokenEnv
  }
  if (raw.prompt !== undefined) channel.prompt = asString(raw.prompt, `${path}.prompt`)
  if (raw.discussionCategory !== undefined) {
    channel.discussionCategory = asString(raw.discussionCategory, `${path}.discussionCategory`)
  }
  if (raw.labels !== undefined) {
    if (!Array.isArray(raw.labels)) throw new ConfigError(`${path}.labels must be a list of strings`)
    channel.labels = raw.labels.map((label, index) => asString(label, `${path}.labels[${String(index)}]`))
  }
  return channel
}

/**
 * Parse `feedback`, folding the built-ins' shipped defaults under the user's
 * channel entries so a built-in needs only `enabled` and a user channel is
 * checked for the three fields nothing can default for it.
 * @param raw - the `feedback` YAML value.
 */
function parseFeedback(raw: unknown): MigrateConfig['feedback'] {
  const feedback: MigrateConfig['feedback'] = {
    enabled: DEFAULT_CONFIG.feedback.enabled,
    channels: {},
  }
  for (const [id, channel] of Object.entries(DEFAULT_CONFIG.feedback.channels)) {
    feedback.channels[id] = { ...channel }
  }
  if (raw === undefined) return feedback
  if (!isRecord(raw)) throw new ConfigError('feedback must be a mapping')
  if (raw.enabled !== undefined) feedback.enabled = asBoolean(raw.enabled, 'feedback.enabled')
  if (raw.channels === undefined) return feedback
  if (!isRecord(raw.channels)) throw new ConfigError('feedback.channels must be a mapping')
  for (const [id, value] of Object.entries(raw.channels)) {
    if (!isRecord(value)) throw new ConfigError(`feedback.channels.${id} must be a mapping`)
    const parsed = parseFeedbackChannel(id, value)
    const builtin = BUILTIN_CHANNELS[id]
    if (builtin === undefined) {
      for (const field of ['repo', 'method', 'prompt'] as const) {
        if (parsed[field] === undefined) {
          throw new ConfigError(`feedback.channels.${id}.${field} is required for a channel that is not built in`)
        }
      }
    }
    feedback.channels[id] = parsed
  }
  return feedback
}

/** Git ref name with the characters git refuses, plus the traversal cases. */
function asBranchName(value: unknown, path: string): string {
  const name = asString(value, path)
  if (/[\s~^:?*[\\]/.test(name) || name.includes('..') || name.startsWith('-') || name.endsWith('/')) {
    throw new ConfigError(`${path} must be a valid git branch name`)
  }
  return name
}

/** Repository-relative directory the Action creates the E2E suite in. */
function asRelativeDir(value: unknown, path: string): string {
  const dir = asString(value, path)
  if (dir.startsWith('/') || dir.split('/').includes('..')) {
    throw new ConfigError(`${path} must be a repository-relative path without ".."`)
  }
  return dir.replace(/^\.\//, '').replace(/\/+$/, '')
}

function asVerifyStep(
  raw: unknown,
  path: string,
  fallback: { enabled: boolean; timeoutMs: number },
): { enabled: boolean; timeoutMs: number } {
  if (raw === undefined) return fallback
  if (!isRecord(raw)) throw new ConfigError(`${path} must be a mapping`)
  return {
    enabled: raw.enabled === undefined ? fallback.enabled : asBoolean(raw.enabled, `${path}.enabled`),
    timeoutMs: raw.timeoutMs === undefined ? fallback.timeoutMs : asInt(raw.timeoutMs, `${path}.timeoutMs`, 1000),
  }
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
      verify: {
        boot: { ...DEFAULT_CONFIG.verify.boot },
        web: { ...DEFAULT_CONFIG.verify.web },
      },
      e2e: { ...DEFAULT_CONFIG.e2e },
      timeouts: { ...DEFAULT_CONFIG.timeouts },
      feedback: parseFeedback(undefined),
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
      dsh.mode = asPresetId(dshRaw.mode, 'dsh.mode')
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

  const verifyRaw = raw.verify
  const verify: MigrateConfig['verify'] = {
    boot: { ...DEFAULT_CONFIG.verify.boot },
    web: { ...DEFAULT_CONFIG.verify.web },
  }
  if (verifyRaw !== undefined) {
    if (!isRecord(verifyRaw)) throw new ConfigError('verify must be a mapping')
    verify.boot = asVerifyStep(verifyRaw.boot, 'verify.boot', verify.boot)
    verify.web = asVerifyStep(verifyRaw.web, 'verify.web', verify.web)
  }

  const e2eRaw = raw.e2e
  const e2e: MigrateConfig['e2e'] = { ...DEFAULT_CONFIG.e2e }
  if (e2eRaw !== undefined) {
    if (!isRecord(e2eRaw)) throw new ConfigError('e2e must be a mapping')
    if (e2eRaw.enabled !== undefined) e2e.enabled = asBoolean(e2eRaw.enabled, 'e2e.enabled')
    if (e2eRaw.forceRebase !== undefined) e2e.forceRebase = asBoolean(e2eRaw.forceRebase, 'e2e.forceRebase')
    if (e2eRaw.subsetFirst !== undefined) e2e.subsetFirst = asBoolean(e2eRaw.subsetFirst, 'e2e.subsetFirst')
    if (e2eRaw.branch !== undefined) e2e.branch = asBranchName(e2eRaw.branch, 'e2e.branch')
    if (e2eRaw.baseRef !== undefined) e2e.baseRef = asString(e2eRaw.baseRef, 'e2e.baseRef')
    if (e2eRaw.dir !== undefined) e2e.dir = asRelativeDir(e2eRaw.dir, 'e2e.dir')
    if (e2eRaw.gate !== undefined) e2e.gate = asEnum(e2eRaw.gate, 'e2e.gate', ['advisory', 'blocking'] as const)
  }

  const timeoutsRaw = raw.timeouts
  const timeouts: MigrateConfig['timeouts'] = { ...DEFAULT_CONFIG.timeouts }
  if (timeoutsRaw !== undefined) {
    if (!isRecord(timeoutsRaw)) throw new ConfigError('timeouts must be a mapping')
    for (const key of ['agentMs', 'commandMs', 'checkoutMs'] as const) {
      if (timeoutsRaw[key] !== undefined) timeouts[key] = asInt(timeoutsRaw[key], `timeouts.${key}`, 1000)
    }
  }

  const feedback = parseFeedback(raw.feedback)

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
    verify,
    e2e,
    timeouts,
    feedback,
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
