/** User-facing review policy after the first mechanical pass. */
export type ReviewPolicy = 'always' | 'skip-if-mechanical-pass'

/** Language used for the GitHub Issue and pull request bodies. */
export type IssuePrLanguage = 'en' | 'zh'

/** Supported dsh-anchored-standard mode directory names. */
export const ANCHORED_MODES = [
  'anchored-standard',
  'zero-anchored-standard',
  'whoami-standard',
  'eternal-minimal',
  'wire-think-standard',
  'combo-anchored',
] as const

export type AnchoredMode = (typeof ANCHORED_MODES)[number]

/** DeepSeek thinking effort accepted by `@deepseek-ai/dsh-llm-deepseek`. */
export const THINKING_EFFORTS = ['off', 'low', 'high', 'max'] as const

export type ThinkingEffort = (typeof THINKING_EFFORTS)[number]

/** Prompt files the user may override in config. */
export interface PromptOverrides {
  absorption?: string
  alignment?: string
  fix?: string
}

/** Commands that replace the built-in mechanical suite when present. */
export interface TestConfig {
  commands: string[]
}

export interface DshBackendConfig {
  provider: string
  model: string
  thinking: 'enabled' | 'disabled'
  reasoningEffort: ThinkingEffort
  mode: AnchoredMode
}

export interface IssuePrConfig {
  language: IssuePrLanguage
}

export interface LoopConfig {
  maxAttempts: number
}

export interface WatchConfig {
  /** When true (default), skip the pipeline if dsh has not changed since last success. */
  enabled: boolean
}

export interface MigrateConfig {
  dshVersion: string
  review: { policy: ReviewPolicy }
  tests?: TestConfig
  prompts: PromptOverrides
  dsh: DshBackendConfig
  issuePr: IssuePrConfig
  loop: LoopConfig
  watch: WatchConfig
}

export const DEFAULT_CONFIG: MigrateConfig = {
  dshVersion: 'latest',
  review: { policy: 'always' },
  prompts: {},
  dsh: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    thinking: 'enabled',
    reasoningEffort: 'max',
    mode: 'anchored-standard',
  },
  issuePr: { language: 'en' },
  loop: { maxAttempts: 5 },
  watch: { enabled: true },
}
