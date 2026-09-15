import type { FeedbackChannelKind } from './types.ts'
import type { FeedbackMethod } from '../config/schema.ts'

/**
 * The three channels this Action ships.
 *
 * Each is off until a user turns it on, and each needs its own token: the
 * workflow's `GITHUB_TOKEN` is minted for the plugin repository and cannot write
 * to any of these targets. A channel that is on but has no token is skipped with
 * a logged reason rather than failing the run.
 *
 * This module is metadata only, so config validation can consult the built-in
 * defaults without pulling the prompt modules into the config layer. The prompt
 * each channel runs is in `src/feedback/prompts.ts`.
 */
export interface BuiltinChannel {
  /** `owner/name` this channel writes to. */
  repo: string
  method: FeedbackMethod
  /** Env var (and repository secret name) holding a token that may write to `repo`. */
  tokenEnv: string
  kind: FeedbackChannelKind
  labels: string[]
  discussionCategory: string
}

/**
 * Reports what a real migration found wrong in the community upgrade knowledge
 * base. Delivers an issue in that repository's own bug-template shape, never a
 * pull request: their rules forbid adding cards as a side effect of migrating
 * somebody else's plugin, and a version-corridor claim is a coordination lock a
 * machine must not take.
 */
export const UPGRADE_SKILL_CHANNEL = 'upgrade-skill'

/**
 * Reports how this Action performed, so the Action can be improved. The merge is
 * the maintainer's verdict, and any edit they made on the branch first is the
 * most specific defect signal available.
 */
export const MIGRATE_BOT_CHANNEL = 'migrate-bot'

/**
 * Posts a feature-request discussion the migration already drafted, after
 * checking that nobody proposed the same thing between the reviews and the
 * merge. This is the one channel whose prompt classifies instead of writing.
 */
export const HARNESS_DISCUSSION_CHANNEL = 'harness-discussion'

export const BUILTIN_CHANNELS: Record<string, BuiltinChannel> = {
  [UPGRADE_SKILL_CHANNEL]: {
    repo: 'oh-my-dsh/dsh-plugin-upgrade-skill',
    method: 'issue',
    tokenEnv: 'DSH_MIGRATE_FEEDBACK_UPGRADE_SKILL_TOKEN',
    kind: 'analysis',
    labels: ['bug'],
    discussionCategory: 'ideas',
  },
  [MIGRATE_BOT_CHANNEL]: {
    repo: 'royenheart/dsh-migrate-bot',
    method: 'issue',
    tokenEnv: 'DSH_MIGRATE_FEEDBACK_BOT_TOKEN',
    kind: 'analysis',
    labels: [],
    discussionCategory: 'ideas',
  },
  [HARNESS_DISCUSSION_CHANNEL]: {
    repo: 'deepseek-ai/deepseek-harness',
    method: 'discussion',
    tokenEnv: 'DSH_MIGRATE_FEEDBACK_HARNESS_TOKEN',
    kind: 'dedupe',
    labels: [],
    discussionCategory: 'ideas',
  },
}

/** Built-in channel ids, in the order they run. */
export const BUILTIN_CHANNEL_IDS = [
  UPGRADE_SKILL_CHANNEL,
  MIGRATE_BOT_CHANNEL,
  HARNESS_DISCUSSION_CHANNEL,
] as const
