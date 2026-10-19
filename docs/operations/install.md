---
kind: operations
description: Setting the Action up in a plugin repository, by hand or with a coding agent: secrets, the workflow, permissions, report channels and the deploy service.
---

# Installing the Action

## The workflow

1. Add the repository secrets the Action uses. The reusable workflow passes each to the Action under its name below, and only these names reach it:

   | Secret | Needed for |
   |---|---|
   | `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` | Every migration: the agent sessions |
   | `DSH_MIGRATE_REPORT_UPGRADE_SKILL_TOKEN`, `DSH_MIGRATE_REPORT_BOT_TOKEN`, `DSH_MIGRATE_REPORT_HARNESS_TOKEN` | A built-in [report channel](#report-channels) that is enabled |
   | `DSH_MIGRATE_DEPLOY_TOKEN` | A [deploy service](#the-deploy-service) |

   The `secrets.apiKeyEnv`, `deploy.tokenEnv` and `reports.channels.<id>.tokenEnv` keys name the variable the Action reads, and a [report channel](#report-channels) of your own names its token in the last; a name not in the table needs [a copy of the reusable workflow](#a-copy-of-the-reusable-workflow).
2. Copy [examples/workflow.yml](../../examples/workflow.yml) to `.github/workflows/dsh-migrate.yml`, set the cron, and pin the release as [releasing](release.md#what-a-consumer-pins) describes. The file chooses the triggers and calls the reusable workflow [`.github/workflows/migrate.yml`](../../.github/workflows/migrate.yml) of this repository, or [your copy of it](#a-copy-of-the-reusable-workflow), with `secrets: inherit`.
3. Optionally copy [examples/dsh-migrate.yml](../../examples/dsh-migrate.yml) to `.github/dsh-migrate.yml`. Every key is optional and listed in the [configuration reference](../reference/configuration.md); an unknown or renamed key fails the run with a message that names the replacement.
4. In Settings → Actions → General → Workflow permissions, enable **Allow GitHub Actions to create and approve pull requests**. Without it the workflow token pushes the proposal branch and opens the issue, and then gets HTTP 403 when it opens the pull request.

The reusable workflow holds the concurrency group that keeps one writer of the state branch at a time, and runs the job each event needs: `migrate` on the schedule and on manual dispatch, `pull-request-closed` when the proposal's pull request closes, and `comment` when a commenter the Action admits ([comment commands](#comment-commands)) writes `/dsh-migrate`. No other pull request or comment starts a job, because GitHub cancels a job waiting in a concurrency group when another is queued behind it; and each `migrate` run first asks GitHub whether the open proposal's pull request was closed, so a close whose job was cancelled anyway is still delivered. The caller grants `contents: write` (the proposal branch and the state branch), `issues: write` and `pull-requests: write`. The reusable workflow takes three inputs, `target` and `force` for a manual run and `config` for a configuration file at another path, and returns the Action's `status`, `target_tag`, `verified_tag`, `pull_request_url`, `log_stream_url` and `command_reply` as its outputs.

The Action runs the image `ghcr.io/royenheart/dsh-migrate-bot` of its release. The image is built and self-tested once per release, so every consumer run uses the same agent runtime and the same system packages.

The first scheduled run migrates to the target release. When a later run skips a release, and what `force` changes, is in [starting a migration](../design/workflow.md#6-starting-a-migration).

### A copy of the reusable workflow

A variable the table above does not name, a renamed one or the token of a report channel of your own, reaches the Action only through a copy of the reusable workflow in the plugin repository:

1. Copy `.github/workflows/migrate.yml` of the release you would pin to `.github/workflows/dsh-migrate-jobs.yml`, and set each such variable in its top-level `env` from its secret. For the major tag, that is the release it points to now: the `vX.Y.Z` tag that `git ls-remote --tags https://github.com/royenheart/dsh-migrate-bot` lists with the major tag's commit, never a release candidate.
2. In the workflow of step 2 above, call `./.github/workflows/dsh-migrate-jobs.yml` instead, still with `secrets: inherit`. The copy runs the release its `uses:` lines name, and its jobs are that release's, so leave them as copied.
3. A major tag moving on no longer upgrades the Action: an upgrade is a new copy of the new release's `migrate.yml`, with the variables set again.

The Action step's inputs are in [`action.yml`](../../action.yml).

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
| Which release of the Action to pin | As [releasing](release.md#what-a-consumer-pins) says: the major tag, or a release candidate when the maintainer wants to try one | The `@` of the reusable workflow in the workflow file, or, when an answer needs [a copy](#a-copy-of-the-reusable-workflow), the release it is copied from |
| When the scheduled run starts, in UTC | Every day at 03:00 | The cron of the workflow file |
| The most the agent sessions of one migration job may spend, in USD ([what it counts](#spend)) | No cap; recommend setting one | `quota.limit` |
| Whether the reviews run when the unmodified plugin already passes every check | They run | `review.policy: when-checks-fail` skips them, which costs less on a release that breaks nothing |
| How many repair attempts a migration gets | 5 | `repair.maxAttempts` |
| Which commands test the plugin, when its scripts do not | Its `build`, `typecheck` and `test` scripts | `tests.commands` |
| For a plugin with a browser half: whether to keep the end-to-end check, and whether a broken end-to-end test should fail the migration ([the policy](../design/checks.md#the-end-to-end-suite-and-its-baseline)) | Kept, `advisory` | `checks.e2e.enabled`, `checks.e2e.failurePolicy: blocking` |
| Whether to send merge reports to another repository | None | `reports.channels.<id>.enabled`, each with its own token ([report channels](#report-channels)); ask per channel, naming the repository it writes to. A channel of your own needs [a copy of the reusable workflow](#a-copy-of-the-reusable-workflow), which no longer follows a major tag: say so when the maintainer pinned one |
| Whether a deploy service previews pull requests | No | The `deploy` keys; [running the deploy service](deploy-service.md#setting-it-up-with-an-agent) has its own questions |
| For a v0 installation: what to do with the old end-to-end branch and the old proposals | Rename the branch; close the old pull requests once the first v1 proposal is open | [Moving from v0](#moving-from-v0), steps 4 and 5 |

### Applying the answers

1. Create a branch, for example `dsh-migrate-setup`.
2. Write the files of [the workflow](#the-workflow), steps 2 and 3, from the examples of the pinned release: the workflow with the chosen cron and pin, and `.github/dsh-migrate.yml` with the answers that differ from the defaults and nothing else; when an answer needs a name the secrets table does not hold, such as a report channel of your own, also [a copy of the reusable workflow](#a-copy-of-the-reusable-workflow) of the chosen release, as its step 1 says. A v0 workflow file is replaced, not merged, and a v0 configuration is rewritten as [Moving from v0](#moving-from-v0) says.
3. For each secret the answers need, from [the workflow](#the-workflow) table or named in a copy's `env`, that `gh secret list` lacks, ask the maintainer to add it: `gh secret set <NAME>` prompts for the value, or Settings → Secrets and variables → Actions.
4. When Actions may not open pull requests (step 4 of [the workflow](#the-workflow)), ask before changing the setting, then keep the default token permission as it is and turn only this on: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=<the current value> -F can_approve_pull_request_reviews=true`. An organisation policy can forbid it; the maintainer then changes it there.
5. For a v0 installation, and only with the maintainer's answer, handle the end-to-end branch as [Moving from v0](#moving-from-v0) step 4 says.
6. Open a pull request with those files, listing each answer and each repository setting changed, and, with a copy, the release it holds and that upgrading means copying again.

### The first run

The scheduled and manual triggers read the workflow from the default branch, so the first run waits for the pull request to be merged. Then `gh workflow run dsh-migrate.yml`, optionally with `-f dsh_release=<version>` (the dsh release to migrate to) or `-f migrate_again=true`, starts a migration, and `gh run watch` follows it. The run's summary and its `status` output say how it ended: `compatible` (nothing to change), `proposed` (a proposal issue and pull request are open for the maintainer to review), `failed` (the checks still fail after the repair attempts; the summary and the log say why), `error` (the Action itself failed, for example on a configuration key it does not know, whose message names the replacement) or `skipped` (the run's log says why; [starting a migration](../design/workflow.md#6-starting-a-migration) says when `-f force=true` runs it again). For a v0 installation, the agent offers to close the old proposals once the first v1 proposal is open.

### What the agent never does

- Ask for a key or a token in the conversation, or put one in a file, a command line or a commit. The maintainer enters secrets in GitHub.
- Enable a report channel or a deploy service the maintainer did not ask for, since each sends data to a service outside the repository.
- Push to the default branch, delete or rename a branch, close a pull request or change a repository setting without the maintainer's answer.

## Moving from v0

A plugin repository that ran the v0 Action changes these before its first v1 run:

1. **The workflow.** Replace `.github/workflows/dsh-migrate.yml` with [examples/workflow.yml](../../examples/workflow.yml), pinned as [releasing](release.md#what-a-consumer-pins) describes. The secret `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` keeps its name.
2. **The report channel secrets.** `DSH_MIGRATE_FEEDBACK_UPGRADE_SKILL_TOKEN`, `DSH_MIGRATE_FEEDBACK_BOT_TOKEN` and `DSH_MIGRATE_FEEDBACK_HARNESS_TOKEN` are `DSH_MIGRATE_REPORT_UPGRADE_SKILL_TOKEN`, `DSH_MIGRATE_REPORT_BOT_TOKEN` and `DSH_MIGRATE_REPORT_HARNESS_TOKEN`; a channel whose secret keeps the old name is skipped.
3. **The configuration.** v1 refuses a key it does not know, so `.github/dsh-migrate.yml` is rewritten. The common keys:

   | v0 | v1 |
   |---|---|
   | `dshVersion: latest` | `target: latest`, the default |
   | `review.policy: skip-if-mechanical-pass` | `review.policy: when-checks-fail` |
   | `loop.maxAttempts` | `repair.maxAttempts` |
   | `watch.enabled` | removed: the schedule in the workflow finds new releases |
   | `issuePr.language` | removed: every body is English |

   Every other v0 key (`dsh`, `verify`, `e2e`, `feedback`, `prompts.*`, `deploy.liveView`) fails the run with a message naming its v1 replacement, or saying it was removed.
4. **The end-to-end branch.** v0's `dsh-migrate/e2e` holds the whole plugin tree with a suite that starts dsh itself, which v1 would read as its suite. Before the first run, either rename it to keep the old tests (`git fetch origin dsh-migrate/e2e`, `git push origin FETCH_HEAD:refs/heads/dsh-migrate/e2e-v0`, `git push origin --delete dsh-migrate/e2e`), delete it, or set `checks.e2e.branch` to a new name.
5. **The old proposals.** v1 keeps its proposal on `dsh-migrate/proposal` and does not take over v0's `dsh-migrate/<version>-<time>` branches or their pull requests; close them once the v1 proposal is open.

The state branch `dsh-migrate/state` needs nothing: v1 does not read v0's `seen.json` and writes its own files beside it, so its first run takes the source release from the plugin's declared ranges.

## Spend

Before each agent session of a migration job (the reviews, the repair attempts and the end-to-end authoring) the Action asks DeepSeek for the account balance, and stops when the account is unavailable or the sessions of the job have spent `quota.limit`, priced from their own token usage at the published rates. A review or a repair attempt that may not run stops the migration; an end-to-end authoring session that may not run leaves the suite as it was, and the migration goes on with the reason reported. A job cut short before the proposal was published leaves no log, so the next run starts the migration again and counts from zero. The merge report's sessions, one per channel, are not counted, whichever job sends them.

## Report channels

When a proposal is merged, each enabled report channel receives a merge report; [the workflow design](../design/workflow.md#8-merge-reports) lists the built-in channels, where each writes and why each needs its own token. Every channel is off by default, and its token is the secret in [the workflow](#the-workflow) table. Enabling a built-in channel is one key:

```yaml
reports:
  channels:
    migrate-bot:
      enabled: true
```

A channel with any other id is your own and needs `repo`, `method` (`issue` or `discussion`), `prompt` and `tokenEnv`; its session receives the same evidence and must print `{ "title": …, "body": … }` as its last fenced JSON block. The reusable workflow sets only the built-in token names, so a channel of your own needs [a copy of the reusable workflow](#a-copy-of-the-reusable-workflow). A channel without its token is skipped with the reason in the log. `agent.upgradeSkills`, on by default, loads the community upgrade skill into the review and repair sessions; it ships in the image, fetches and sends nothing, and is independent of the `upgrade-skill` channel.

Each channel writes to a repository the consumer does not own, so whoever configures the Action for someone else asks before enabling one: what the channel sends and where, and which token with write access to that repository it needs.

## Comment commands

The `comment` job runs the [comment commands](../reference/commands.md); [the workflow design](../design/workflow.md#9-comment-commands) says who may run them and how a repeated delivery is handled. `deploy.commands: false` refuses every command.

## The deploy service

A deploy service is an HTTP service you run; it serves the run log stream and the preview deployments, and receives the preview commands. An absent or failing service is a log line, never a failed migration. [The deploy service design](../design/deploy-service.md) describes what it serves, and [running the deploy service](deploy-service.md) is how to run the reference implementation and point a repository at it.

```yaml
deploy:
  enabled: true
  endpoint: https://deploy.example.com
```

The token is the repository secret `DSH_MIGRATE_DEPLOY_TOKEN`. A `publish` command runs the checks in the `comment` job before it pushes, so that job needs whatever the plugin's own test commands need.
