import { z } from 'zod'
import { DEFAULT_API_KEY_ENV } from '../secrets.ts'

/**
 * The consumer configuration, `.github/dsh-migrate.yml`.
 *
 * This schema is the only definition of the configuration: `parseConfig`
 * validates against it, and `docs/reference/configuration.md` is generated from
 * it by `scripts/gen-config-reference.ts`. Every object is strict, so a
 * misspelled or removed key fails validation instead of being ignored.
 */

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name')
const repoSlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"')
const branchName = z.string().min(1).refine(
  name => !/[\s~^:?*[\\]/.test(name) && !name.includes('..') && !name.startsWith('-') && !name.endsWith('/'),
  'must be a valid git branch name',
)
const relativeDir = z.string().min(1)
  .refine(dir => !dir.startsWith('/') && !dir.split('/').includes('..'), 'must be a repository-relative path without ".."')
const normalizeDir = (dir: string): string => dir.replace(/^\.\//, '').replace(/\/+$/, '')
const milliseconds = z.number().int().min(1000)

export const THINKING_EFFORTS = ['off', 'low', 'high', 'max'] as const
export const REVIEW_POLICIES = ['always', 'when-checks-fail'] as const
export const E2E_FAILURE_POLICIES = ['advisory', 'blocking'] as const
export const REPORT_METHODS = ['issue', 'discussion'] as const

const checkSchema = (timeoutMs: number, what: string) => z.strictObject({
  enabled: z.boolean().default(true).describe(`Run the ${what}.`),
  timeoutMs: milliseconds.default(timeoutMs).describe(`Watchdog for one ${what}, in milliseconds.`),
})

const reportChannelSchema = z.strictObject({
  enabled: z.boolean().default(false).describe('Send merge reports to this channel.'),
  repo: repoSlug.optional().describe('Repository the channel writes to. Required for a channel that is not built in.'),
  method: z.enum(REPORT_METHODS).optional().describe('`issue` or `discussion`. Required for a channel that is not built in.'),
  tokenEnv: envName.optional().describe('Environment variable holding a token that may write to `repo`.'),
  prompt: z.string().min(1).optional().describe('Replaces the channel prompt. Required for a channel that is not built in.'),
  labels: z.array(z.string().min(1)).optional().describe('Labels applied to a created issue.'),
  discussionCategory: z.string().min(1).optional().describe('Discussion category slug, for `method: discussion`.'),
})

export const configSchema = z.strictObject({
  target: z.string().min(1).default('latest')
    .describe('Target release: `latest`, a version such as `0.2.0-rc.2`, or a `dsh-v*` tag.'),
  review: z.strictObject({
    policy: z.enum(REVIEW_POLICIES).default('always')
      .describe('`always` runs the overlap and extension-point reviews; `when-checks-fail` skips them when the unmodified tree passes every check on the target release.'),
  }).prefault({}),
  tests: z.strictObject({
    commands: z.array(z.string().min(1)).min(1).describe('Shell commands that replace the built-in mechanical checks; they run in each plugin\'s directory.'),
  }).optional(),
  prompts: z.strictObject({
    overlap: z.string().min(1).optional().describe('Replaces the overlap review prompt.'),
    extensionPoints: z.string().min(1).optional().describe('Replaces the extension-point review prompt.'),
    repair: z.string().min(1).optional().describe('Replaces the repair prompt.'),
  }).prefault({}),
  agent: z.strictObject({
    provider: z.string().min(1).default('deepseek-official').describe('Model provider route of the agent sessions.'),
    model: z.string().min(1).default('deepseek-v4-flash').describe('Model of the agent sessions.'),
    thinking: z.enum(['enabled', 'disabled']).default('enabled').describe('Provider thinking mode.'),
    reasoningEffort: z.enum(THINKING_EFFORTS).default('max').describe('Provider reasoning effort.'),
    upgradeSkills: z.boolean().default(true)
      .describe('Load the `plugin-upgrade` skill of the community upgrade skills into the review and repair sessions. The skill ships in the image; nothing is fetched or sent.'),
  }).prefault({}),
  repair: z.strictObject({
    maxAttempts: z.number().int().min(1).default(5).describe('Attempt limit: the most repair attempts one migration runs.'),
  }).prefault({}),
  secrets: z.strictObject({
    apiKeyEnv: envName.default(DEFAULT_API_KEY_ENV).describe('Environment variable holding the DeepSeek API key.'),
  }).prefault({}),
  quota: z.strictObject({
    limit: z.number().positive().optional().describe('Spend cap: the most USD one migration may spend, priced from its own usage.'),
  }).prefault({}),
  checks: z.strictObject({
    boot: checkSchema(180_000, 'boot check').prefault({}),
    web: checkSchema(120_000, 'web check').prefault({}),
    e2e: z.strictObject({
      enabled: z.boolean().default(true).describe('Record an end-to-end baseline on the source release, check it on the target, and keep the suite on its branch.'),
      branch: branchName.default('dsh-migrate/e2e').describe('Branch that holds the end-to-end suite and nothing else.'),
      dir: relativeDir.default('e2e').describe('Directory of the suite on its branch.')
        .transform(normalizeDir),
      failurePolicy: z.enum(E2E_FAILURE_POLICIES).default('advisory')
        .describe('Without an end-to-end baseline, `advisory` reports a failing test in the proposal and `blocking` fails the migration. With one, a test that passed on the source release and fails on the target always fails the migration.'),
    }).prefault({}),
  }).prefault({}),
  timeouts: z.strictObject({
    agentMs: milliseconds.default(60 * 60_000).describe('Watchdog for one agent session.'),
    commandMs: milliseconds.default(20 * 60_000).describe('Watchdog for one mechanical command.'),
    checkoutMs: milliseconds.default(10 * 60_000).describe('Watchdog for the harness checkout.'),
  }).prefault({}),
  reports: z.strictObject({
    enabled: z.boolean().default(true).describe('Send merge reports at all; each channel also needs its own `enabled`.'),
    channels: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase channel id'), reportChannelSchema)
      .default({}).describe('Report channels by id. Built-in ids: `upgrade-skill`, `migrate-bot`, `harness-discussion`.'),
  }).prefault({}),
  deploy: z.strictObject({
    enabled: z.boolean().default(false).describe('Use a deploy service.'),
    endpoint: z.url({ protocol: /^https?$/ }).optional().transform(url => url?.replace(/\/+$/, ''))
      .describe('Base URL of the deploy service. Required when `enabled`.'),
    tokenEnv: envName.default('DSH_MIGRATE_DEPLOY_TOKEN').describe('Environment variable holding the deploy service token.'),
    logStream: z.boolean().default(true).describe('Stream the run log to the deploy service.'),
    commands: z.boolean().default(true).describe('Accept `/dsh-migrate` comment commands.'),
    preview: z.strictObject({
      enabled: z.boolean().default(true).describe('Allow preview deployments.'),
      ttlDays: z.number().int().min(1).default(7).describe('Days before a preview deployment is destroyed.'),
      idleMinutes: z.number().int().min(1).default(120).describe('Minutes without a request before a preview deployment stops.'),
      extendDays: z.number().int().min(1).optional().describe('Days one `extend` command asks for; at most `ttlDays`, which is also the default.'),
    }).prefault({})
      .refine(preview => preview.extendDays === undefined || preview.extendDays <= preview.ttlDays, {
        path: ['extendDays'],
        message: 'must not exceed deploy.preview.ttlDays',
      })
      .transform(preview => ({ ...preview, extendDays: preview.extendDays ?? preview.ttlDays })),
  }).prefault({}),
})
  .superRefine((config, context) => {
    if (config.deploy.enabled && config.deploy.endpoint === undefined) {
      context.addIssue({ code: 'custom', path: ['deploy', 'endpoint'], message: 'is required when deploy.enabled is true' })
    }
  })

export type MigrateConfig = z.output<typeof configSchema>
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number]
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number]
export type ReportMethod = (typeof REPORT_METHODS)[number]
export type ReportChannelConfig = z.output<typeof reportChannelSchema>
export type AgentConfig = MigrateConfig['agent']
