import {
  harnessDiscussionFeedbackPrompt,
  migrateBotFeedbackPrompt,
  upgradeSkillFeedbackPrompt,
} from '../prompts/feedback/index.ts'
import {
  HARNESS_DISCUSSION_CHANNEL,
  MIGRATE_BOT_CHANNEL,
  UPGRADE_SKILL_CHANNEL,
} from './channels.ts'
import { assembleFeedbackPrompt, FEEDBACK_REPORT_CONTRACT } from '../prompts/feedback/index.ts'
import type { ResolvedChannel } from './types.ts'

/**
 * The prompt a channel runs, given the rendered evidence.
 *
 * A built-in channel has a shipped prompt. A user-defined channel has no
 * default by construction — config validation requires `prompt` for it — and
 * gets the shared report contract appended so its output is parsed the same way
 * the built-ins' is.
 * @param channel - the resolved channel.
 * @param evidence - the rendered evidence block.
 */
export function channelPrompt(channel: ResolvedChannel, evidence: string): string {
  if (channel.prompt !== undefined) {
    return assembleFeedbackPrompt({
      instructions: channel.prompt,
      contract: FEEDBACK_REPORT_CONTRACT,
      evidence,
    })
  }
  switch (channel.id) {
    case UPGRADE_SKILL_CHANNEL:
      return upgradeSkillFeedbackPrompt(evidence)
    case MIGRATE_BOT_CHANNEL:
      return migrateBotFeedbackPrompt(evidence)
    case HARNESS_DISCUSSION_CHANNEL:
      return harnessDiscussionFeedbackPrompt(evidence)
    default:
      // Unreachable: a channel without a built-in prompt cannot resolve without
      // one, because config validation requires it.
      return assembleFeedbackPrompt({
        instructions: `Report your findings about this migration for the \`${channel.id}\` channel.`,
        contract: FEEDBACK_REPORT_CONTRACT,
        evidence,
      })
  }
}
