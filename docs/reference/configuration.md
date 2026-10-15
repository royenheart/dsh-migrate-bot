---
kind: reference
description: Every key of .github/dsh-migrate.yml with its type, default and meaning.
---

# Configuration reference

A consumer configures the Action in `.github/dsh-migrate.yml`. Every key is optional, and an unknown key is an error. This page is generated from `src/config/schema.ts` by `scripts/references.ts`; edit the source, not this page.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `target` | string | `latest` | Target release: `latest`, a version such as `0.2.0-rc.2`, or a `dsh-v*` tag. |
| `review.policy` | `always` \| `when-checks-fail` | `always` | `always` runs the overlap and extension-point reviews; `when-checks-fail` skips them when the unmodified tree passes every check on the target release. |
| `tests.commands` | list of string | — | Shell commands that replace the built-in mechanical checks; they run in each plugin's directory. |
| `prompts.overlap` | string | — | Replaces the overlap review prompt. |
| `prompts.extensionPoints` | string | — | Replaces the extension-point review prompt. |
| `prompts.repair` | string | — | Replaces the repair prompt. |
| `agent.provider` | string | `deepseek-official` | Model provider route of the agent sessions. |
| `agent.model` | string | `deepseek-v4-flash` | Model of the agent sessions. |
| `agent.thinking` | `enabled` \| `disabled` | `enabled` | Provider thinking mode. |
| `agent.reasoningEffort` | `off` \| `low` \| `high` \| `max` | `max` | Provider reasoning effort. |
| `agent.upgradeSkills` | boolean | `true` | Load the `plugin-upgrade` skill of the community upgrade skills into the review and repair sessions. The skill ships in the image; nothing is fetched or sent. |
| `repair.maxAttempts` | integer | `5` | Attempt limit: the most repair attempts one migration runs. |
| `secrets.apiKeyEnv` | string | `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` | Environment variable holding the DeepSeek API key. The reusable workflow sets only the default name; another name needs a job that runs the Action itself. |
| `quota.limit` | number | — | Spend cap: the most USD the agent sessions of one migration job (reviews, repair attempts, end-to-end authoring) may spend, priced from their own usage. |
| `checks.cards.enabled` | boolean | `true` | After the reviews, hold the tree to the ledger the sessions keep of the upgrade skill's change cards between the source and the target release. Needs `agent.upgradeSkills`. |
| `checks.boot.enabled` | boolean | `true` | Run the boot check. |
| `checks.boot.timeoutMs` | integer | `180000` | Watchdog for one boot check, in milliseconds. |
| `checks.web.enabled` | boolean | `true` | Run the web check. |
| `checks.web.timeoutMs` | integer | `120000` | Watchdog for one web check, in milliseconds. |
| `checks.e2e.enabled` | boolean | `true` | Record an end-to-end baseline on the source release, check it on the target, and keep the suite on its branch. |
| `checks.e2e.branch` | string | `dsh-migrate/e2e` | Branch that holds the end-to-end suite and nothing else. |
| `checks.e2e.dir` | string | `e2e` | Directory of the suite on its branch. |
| `checks.e2e.publish` | boolean | `true` | After the migration concludes, keep the suite on its branch, writing it first when no end-to-end baseline was recorded. Off, the suite is still read, recorded and checked against, but never written after the conclusion or pushed. |
| `checks.e2e.failurePolicy` | `advisory` \| `blocking` | `advisory` | `advisory` never lets an end-to-end failure stop a migration: a test that failed on the way through the host's UI is reported at once, one that failed in the plugin's part is repaired and reported when the repairs do not fix it. `blocking` repairs every failure and fails the migration when the repairs do not fix it. |
| `timeouts.agentMs` | integer | `3600000` | Watchdog for one agent session. |
| `timeouts.commandMs` | integer | `1200000` | Watchdog for one mechanical command. |
| `timeouts.checkoutMs` | integer | `600000` | Watchdog for the harness checkout. |
| `reports.enabled` | boolean | `true` | Send merge reports at all; each channel also needs its own `enabled`. |
| `reports.channels` | mapping | — | Report channels by id. Built-in ids: `upgrade-skill`, `migrate-bot`, `harness-discussion`. |
| `reports.channels.<id>.enabled` | boolean | `false` | Send merge reports to this channel. |
| `reports.channels.<id>.repo` | string | — | Repository the channel writes to. Required for a channel that is not built in. |
| `reports.channels.<id>.method` | `issue` \| `discussion` | — | `issue` or `discussion`. Required for a channel that is not built in. |
| `reports.channels.<id>.tokenEnv` | string | — | Environment variable holding a token that may write to `repo`. Required for a channel that is not built in, whose job must set the variable: the reusable workflow sets only the built-in names. |
| `reports.channels.<id>.prompt` | string | — | Replaces the channel prompt. Required for a channel that is not built in. |
| `reports.channels.<id>.labels` | list of string | — | Labels applied to a created issue. |
| `reports.channels.<id>.discussionCategory` | string | — | Discussion category slug, for `method: discussion`. |
| `deploy.enabled` | boolean | `false` | Use a deploy service. |
| `deploy.endpoint` | URL | — | Base URL of the deploy service. Required when `enabled`. |
| `deploy.tokenEnv` | string | `DSH_MIGRATE_DEPLOY_TOKEN` | Environment variable holding the deploy service token. The reusable workflow sets only the default name; another name needs a job that runs the Action itself. |
| `deploy.logStream` | boolean | `true` | Stream the run log to the deploy service. |
| `deploy.commands` | boolean | `true` | Accept `/dsh-migrate` comment commands. |
| `deploy.preview.enabled` | boolean | `true` | Allow preview deployments. |
| `deploy.preview.ttlDays` | integer | `7` | Days before a preview deployment is destroyed. |
| `deploy.preview.idleMinutes` | integer | `120` | Minutes without a request before a preview deployment stops. |
| `deploy.preview.extendDays` | integer | — | Days one `extend` command asks for; at most `ttlDays`, which is also the default. |
