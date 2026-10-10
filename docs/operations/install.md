---
kind: operations
description: Setting the Action up in a plugin repository: secrets, the workflow, permissions, report channels and the deploy service.
---

# Installing the Action

## The workflow

1. Add the repository secret `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` with a DeepSeek API key. Another name works when `secrets.apiKeyEnv` names it and the workflow maps it.
2. Copy [examples/workflow.yml](../../examples/workflow.yml) to `.github/workflows/dsh-migrate.yml` and set the cron. It has three jobs: `migrate` on the schedule and on manual dispatch, `pull-request-closed` when a pull request closes, and `comment` when a comment contains `/dsh-migrate`.
3. Optionally copy [examples/dsh-migrate.yml](../../examples/dsh-migrate.yml) to `.github/dsh-migrate.yml`. Every key is optional and listed in the [configuration reference](../reference/configuration.md); an unknown or renamed key fails the run with a message that names the replacement.
4. In Settings → Actions → General → Workflow permissions, enable **Allow GitHub Actions to create and approve pull requests**. Without it the workflow token pushes the proposal branch and opens the issue, and then gets HTTP 403 when it opens the pull request.

The workflow needs `contents: write` (the proposal branch and the state branch), `issues: write` and `pull-requests: write`. Its concurrency group keeps one writer of the state branch at a time; keep it when you edit the workflow.

The first scheduled run migrates to the target release. Later runs skip a release that was already processed; a manual run with `force` migrates it again. A failure of the Action itself (status `error`) is retried by the next run.

## Spend

Before each agent session the Action asks DeepSeek for the account balance, and stops the migration when the account is unavailable. `quota.limit` caps the USD one migration may spend, priced from its own token usage at the published rates. Every check runs without an API key.

## Report channels

When a proposal is merged, each enabled report channel receives a merge report, as [the workflow design](../design/workflow.md#8-merge-reports) describes. Every channel is off by default and needs a token that may write to the channel's repository, because the workflow's `GITHUB_TOKEN` cannot write outside the consumer repository:

| Channel | Destination | Secret |
|---|---|---|
| `upgrade-skill` | An issue in `oh-my-dsh/dsh-plugin-upgrade-skill` | `DSH_MIGRATE_REPORT_UPGRADE_SKILL_TOKEN` |
| `migrate-bot` | An issue in `royenheart/dsh-migrate-bot` | `DSH_MIGRATE_REPORT_BOT_TOKEN` |
| `harness-discussion` | A discussion in `deepseek-ai/deepseek-harness` | `DSH_MIGRATE_REPORT_HARNESS_TOKEN` |

Enabling a built-in channel is one key:

```yaml
reports:
  channels:
    migrate-bot:
      enabled: true
```

A channel with any other id is your own and needs `repo`, `method` (`issue` or `discussion`) and `prompt`; its session receives the same evidence and must print `{ "title": …, "body": … }` as its last fenced JSON block. A channel without its token is skipped with the reason in the log. `agent.upgradeSkills` loads the community upgrade skills into the review and repair sessions independently of the `upgrade-skill` channel.

Each channel writes to a repository the consumer does not own, so whoever configures the Action for someone else asks before enabling one: what the channel sends and where, and which token with write access to that repository it needs.

## Comment commands

The `comment` job runs the [comment commands](../reference/commands.md) for users whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. It needs the comment id mapped (`comment_id`): a second delivery of the same comment then has no second effect and no second reply. `deploy.commands: false` refuses every command.

## The deploy service

A deploy service is an HTTP service you run; it serves the run log stream and the preview deployments, and receives the preview commands. The Action never hosts one, and an absent or failing service is a log line, never a failed migration. [The preview design](../design/preview-and-live-view.md) describes what it serves.

```yaml
deploy:
  enabled: true
  endpoint: https://deploy.example.com
  tokenEnv: DSH_MIGRATE_DEPLOY_TOKEN
```

The token is a repository secret mapped in the workflow. A `publish` command runs the checks in the `comment` job before it pushes, so that job needs whatever the plugin's own test commands need.
