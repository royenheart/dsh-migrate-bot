/**
 * The feedback plane's prompts: one per built-in channel.
 *
 * A channel is a prompt plus a delivery target. The three built-ins are
 * deliberately different shapes — an issue written in a maintainer's own bug
 * template, an issue about this Action, and a classification pass over a draft
 * that already exists — so each lives in its own file and shares only the
 * evidence block and the output contract from `shared.ts`.
 */
export {
  FEEDBACK_DUPLICATE_CONTRACT,
  FEEDBACK_REPORT_CONTRACT,
  assembleFeedbackPrompt,
} from './shared.ts'
export {
  MIGRATE_BOT_FEEDBACK_PROMPT,
  MIGRATE_BOT_FEEDBACK_RULES,
  migrateBotFeedbackPrompt,
} from './migrate-bot.ts'
export {
  UPGRADE_SKILL_FEEDBACK_PROMPT,
  UPGRADE_SKILL_FEEDBACK_RULES,
  upgradeSkillFeedbackPrompt,
} from './upgrade-skill.ts'
export {
  HARNESS_DISCUSSION_FEEDBACK_PROMPT,
  HARNESS_DISCUSSION_FEEDBACK_RULES,
  harnessDiscussionFeedbackPrompt,
} from './harness-discussion.ts'
