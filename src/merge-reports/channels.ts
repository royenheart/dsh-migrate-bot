import type { MigrateConfig, ReportMethod } from '../config/schema.ts'

/**
 * The report channels: where a merge report goes, how, and with which token.
 *
 * Each built-in channel is off until a consumer enables it, and each needs its
 * own token, because none of them writes to the plugin repository the workflow
 * token belongs to.
 */

/** `analysis` channels write a report; the `duplicate-check` channel classifies a draft the reviews wrote. */
export type ChannelKind = 'analysis' | 'duplicate-check'

export interface ReportChannel {
  id: string
  enabled: boolean
  repo: string
  method: ReportMethod
  tokenEnv: string
  kind: ChannelKind
  labels: string[]
  discussionCategory: string
  /** The consumer's prompt, replacing the channel's built-in instructions. */
  prompt?: string | undefined
}

export const UPGRADE_SKILL_CHANNEL = 'upgrade-skill'
export const MIGRATE_BOT_CHANNEL = 'migrate-bot'
export const HARNESS_DISCUSSION_CHANNEL = 'harness-discussion'

type Builtin = Omit<ReportChannel, 'id' | 'enabled' | 'prompt'>

export const BUILTIN_CHANNELS: Record<string, Builtin> = {
  [UPGRADE_SKILL_CHANNEL]: {
    repo: 'oh-my-dsh/dsh-plugin-upgrade-skill',
    method: 'issue',
    tokenEnv: 'DSH_MIGRATE_REPORT_UPGRADE_SKILL_TOKEN',
    kind: 'analysis',
    labels: ['bug'],
    discussionCategory: 'ideas',
  },
  [MIGRATE_BOT_CHANNEL]: {
    repo: 'royenheart/dsh-migrate-bot',
    method: 'issue',
    tokenEnv: 'DSH_MIGRATE_REPORT_BOT_TOKEN',
    kind: 'analysis',
    labels: [],
    discussionCategory: 'ideas',
  },
  [HARNESS_DISCUSSION_CHANNEL]: {
    repo: 'deepseek-ai/deepseek-harness',
    method: 'discussion',
    tokenEnv: 'DSH_MIGRATE_REPORT_HARNESS_TOKEN',
    kind: 'duplicate-check',
    labels: [],
    discussionCategory: 'ideas',
  },
}

/**
 * Every channel, built-in ones first, with the consumer's settings over the
 * built-in defaults. A channel is enabled only when `reports.enabled` is too.
 * @param config - the parsed configuration.
 */
export function resolveChannels(config: MigrateConfig): ReportChannel[] {
  const ids = [...new Set([...Object.keys(BUILTIN_CHANNELS), ...Object.keys(config.reports.channels)])]
  return ids.map((id) => {
    const entry = config.reports.channels[id]
    const builtin = BUILTIN_CHANNELS[id]
    return {
      id,
      enabled: config.reports.enabled && entry?.enabled === true,
      // A channel without a built-in has repo, method and prompt: config validation requires them.
      repo: entry?.repo ?? builtin?.repo ?? '',
      method: entry?.method ?? builtin?.method ?? 'issue',
      tokenEnv: entry?.tokenEnv ?? builtin?.tokenEnv ?? '',
      kind: builtin?.kind ?? 'analysis',
      labels: entry?.labels ?? builtin?.labels ?? [],
      discussionCategory: entry?.discussionCategory ?? builtin?.discussionCategory ?? 'ideas',
      ...(entry?.prompt === undefined ? {} : { prompt: entry.prompt }),
    }
  })
}
