---
kind: operations
description: Setting the Action up in a plugin repository, by hand or with a coding agent: secrets, the workflow, permissions, report channels and the deploy service.
---

# Installing the Action

## Setting it up with an agent

A coding agent working in the plugin repository can set the Action up by following this section; the maintainer only answers its questions and adds the secrets. The agent reads the documents of the release it pins, at `https://github.com/royenheart/dsh-migrate-bot/blob/<release>/`, because keys and defaults change between releases. The rest of this page and the [configuration reference](../reference/configuration.md) hold the facts it applies.

### Looking before asking

The agent first finds out what it can without asking, and reports it:

| Fact | How |
|---|---|
| The repository holds a plugin | A tracked `package.json` that declares `dsh.bundle`, at the root or below it. Without one the Action has nothing to migrate: stop and say so |
| The plugin has a browser half | Its `package.json` declares `dsh.client`; only then does the end-to-end check matter |
| The plugin has its own checks | `package.json` scripts `build`, `typecheck` and `test`; without any, the mechanical check is skipped unless `tests.commands` names commands |
| The v0 Action is installed | A workflow under `.github/workflows/` that uses `royenheart/dsh-migrate-bot@v0`, a `.github/dsh-migrate.yml` with v0 keys, a remote branch `dsh-migrate/e2e`, or open pull requests from `dsh-migrate/<version>-<time>` branches (`git ls-remote origin 'refs/heads/dsh-migrate/*'`, and the `headRefName` of `gh pr list --json number,headRefName,title`) |
| The API key secret exists | `gh secret list`, which shows names only |
| Actions may open pull requests | `gh api repos/OWNER/REPO/actions/permissions/workflow`, field `can_approve_pull_request_reviews` |
| The releases | `gh release list -R royenheart/dsh-migrate-bot`; a prerelease is a release candidate |

### Questions for the maintainer

Each question has a default. The agent asks every question that applies, says the default and what it means, and writes only the answers that differ from it.

| Question | Default | Becomes |
|---|---|---|
| Which release of the Action to pin | The newest release; a release candidate only when the maintainer wants to try one | The `@<release>` of the reusable workflow in the workflow file |
| When the scheduled run starts, in UTC | Every day at 03:00 | The cron of the workflow file |
| The most one migration may spend, in USD | No cap; recommend setting one | `quota.limit` |
| Whether the reviews run when the unmodified plugin already passes every check | They run | `review.policy: when-checks-fail` skips them, which costs less on a release that breaks nothing |
| How many repair attempts a migration gets | 5 | `repair.maxAttempts` |
| Which commands test the plugin, when its scripts do not | Its `build`, `typecheck` and `test` scripts | `tests.commands` |
| For a plugin with a browser half: whether to keep the end-to-end check, and whether a broken end-to-end test should fail the migration | Kept; a failure is reported in the proposal and never fails the migration | `checks.e2e.enabled`, `checks.e2e.failurePolicy: blocking` |
| Whether to send merge reports to another repository | None | `reports.channels.<id>.enabled`, each with its own token ([report channels](#report-channels)); ask per channel, naming the repository it writes to |
| Whether a deploy service previews pull requests | No | The `deploy` keys; [running the deploy service](deploy-service.md#setting-it-up-with-an-agent) has its own questions |
| For a v0 installation: keep the old end-to-end suite, and what to do with the old proposals | Rename `dsh-migrate/e2e` to `dsh-migrate/e2e-v0`; leave the pull requests open until the first v1 proposal | [Moving from v0](#moving-from-v0) |

### Applying the answers

1. Create a branch, for example `dsh-migrate-setup`.
2. Write `.github/workflows/dsh-migrate.yml` from `examples/workflow.yml` of the pinned release, with the chosen cron and the reusable workflow at `@<release>`. A v0 workflow file is replaced, not merged.
3. Write `.github/dsh-migrate.yml` with the answers that differ from the defaults, and nothing else. Every key must be in the configuration reference of the pinned release; a v0 file is rewritten by the table in [Moving from v0](#moving-from-v0).
4. When the API key secret is missing, ask the maintainer to add it: `gh secret set DEEPSEEK_API_KEY_DSH_MIGRATE_BOT`, which prompts for the value, or Settings → Secrets and variables → Actions. The same goes for every report channel and deploy service token.
5. When Actions may not open pull requests, ask before changing the setting, then keep the default token permission as it is and turn only this on: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=<the current value> -F can_approve_pull_request_reviews=true`. An organisation policy can forbid it; the maintainer then changes it there.
6. For a v0 installation, and only with the maintainer's answer: rename the end-to-end branch (`git fetch origin dsh-migrate/e2e`, `git push origin FETCH_HEAD:refs/heads/dsh-migrate/e2e-v0`, then `git push origin --delete dsh-migrate/e2e`).
7. Open a pull request with the two files, listing each answer and each repository setting changed.

### The first run

The scheduled and manual triggers read the workflow from the default branch, so the first run waits for the pull request to be merged. Then `gh workflow run dsh-migrate.yml`, optionally with `-f target=<version>`, starts a migration, and `gh run watch` follows it. The run's summary and its `status` output say how it ended: `compatible` (nothing to change), `proposed` (a proposal issue and pull request are open for the maintainer to review), `failed` (the checks still fail after the repair attempts; the summary and the log say why), `error` (the Action itself failed, for example on a configuration key it does not know, whose message names the replacement) or `skipped` (the release was already processed; `-f force=true` runs it again). For a v0 installation, the agent offers to close the old proposals once the first v1 proposal is open.

### What the agent never does

- Ask for a key or a token in the conversation, or put one in a file, a command line or a commit. The maintainer enters secrets in GitHub.
- Enable a report channel or a deploy service the maintainer did not ask for, since each sends data to a service outside the repository.
- Push to the default branch, delete or rename a branch, close a pull request or change a repository setting without the maintainer's answer.

## The workflow

1. Add the repository secret `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` with a DeepSeek API key. Another name works when `secrets.apiKeyEnv` names it.
2. Copy [examples/workflow.yml](../../examples/workflow.yml) to `.github/workflows/dsh-migrate.yml` and set the cron. The file chooses the triggers and calls the reusable workflow [`.github/workflows/migrate.yml`](../../.github/workflows/migrate.yml) of this repository with `secrets: inherit`; the reusable workflow maps the secrets, holds the concurrency group that keeps one writer of the state branch at a time, and runs the job each trigger needs: `migrate` on the schedule and on manual dispatch, `pull-request-closed` when a pull request closes, and `comment` when a comment contains `/dsh-migrate`.
3. Optionally copy [examples/dsh-migrate.yml](../../examples/dsh-migrate.yml) to `.github/dsh-migrate.yml`. Every key is optional and listed in the [configuration reference](../reference/configuration.md); an unknown or renamed key fails the run with a message that names the replacement.
4. In Settings → Actions → General → Workflow permissions, enable **Allow GitHub Actions to create and approve pull requests**. Without it the workflow token pushes the proposal branch and opens the issue, and then gets HTTP 403 when it opens the pull request.

The caller grants `contents: write` (the proposal branch and the state branch), `issues: write` and `pull-requests: write`. The reusable workflow takes three inputs: `target` and `force` for a manual run, and `config` for a configuration file at another path.

The Action runs the image `ghcr.io/royenheart/dsh-migrate-bot` of its release. The image is built and self-tested once per release, so every consumer run uses the same agent runtime and the same system packages.

The first scheduled run migrates to the target release. Later runs skip a release that was already processed; a manual run with `force` migrates it again. A failure of the Action itself (status `error`) is retried by the next run.

## Moving from v0

A plugin repository that ran the v0 Action changes four things before its first v1 run:

1. **The workflow.** Replace `.github/workflows/dsh-migrate.yml` with [examples/workflow.yml](../../examples/workflow.yml). The secret `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` keeps its name.
2. **The configuration.** v1 refuses a key it does not know, so `.github/dsh-migrate.yml` is rewritten:

   | v0 | v1 |
   |---|---|
   | `dshVersion: latest` | `target: latest`, the default |
   | `review.policy: skip-if-mechanical-pass` | `review.policy: when-checks-fail` |
   | `loop.maxAttempts` | `repair.maxAttempts` |
   | `watch.enabled` | removed: the schedule in the workflow finds new releases |
   | `issuePr.language` | removed: every body is English |

3. **The end-to-end branch.** v0's `dsh-migrate/e2e` holds the whole plugin tree with a suite that starts dsh itself, which v1 would read as its suite. Delete the branch before the first run, or set `checks.e2e.branch` to a new name.
4. **The old proposals.** v1 keeps its proposal on `dsh-migrate/proposal` and does not take over v0's `dsh-migrate/<version>-<time>` branches or their pull requests; close them once the v1 proposal is open.

The state branch `dsh-migrate/state` needs nothing: v1 does not read v0's `seen.json` and writes its own files beside it, so its first run takes the source release from the plugin's declared ranges.

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

A channel with any other id is your own and needs `repo`, `method` (`issue` or `discussion`) and `prompt`; its session receives the same evidence and must print `{ "title": …, "body": … }` as its last fenced JSON block. A channel without its token is skipped with the reason in the log. `agent.upgradeSkills`, on by default, loads the community upgrade skill into the review and repair sessions; it ships in the image, fetches and sends nothing, and is independent of the `upgrade-skill` channel.

Each channel writes to a repository the consumer does not own, so whoever configures the Action for someone else asks before enabling one: what the channel sends and where, and which token with write access to that repository it needs.

## Comment commands

The `comment` job runs the [comment commands](../reference/commands.md) for users whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. A second delivery of the same comment has no second effect and no second reply. `deploy.commands: false` refuses every command.

## The deploy service

A deploy service is an HTTP service you run; it serves the run log stream and the preview deployments, and receives the preview commands. An absent or failing service is a log line, never a failed migration. [The deploy service design](../design/deploy-service.md) describes what it serves, and [running the deploy service](deploy-service.md) is how to run the reference implementation and point a repository at it.

```yaml
deploy:
  enabled: true
  endpoint: https://deploy.example.com
```

The token is the repository secret `DSH_MIGRATE_DEPLOY_TOKEN`. A `publish` command runs the checks in the `comment` job before it pushes, so that job needs whatever the plugin's own test commands need.
