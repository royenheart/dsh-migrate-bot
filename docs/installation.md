# Installation and configuration

Everything a consumer sets up: the secrets to create, the workflow to copy, every configuration key and its default, and the optional feedback channels that report a merged migration back to the projects it concerns.

## Install

1. Add the repository secret `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` (or another name, mapped through `api_key_env` / `secrets.apiKeyEnv`).
2. Copy [examples/workflow.yml](../examples/workflow.yml) to `.github/workflows/dsh-migrate.yml` and set the cron.
3. Optionally copy [examples/dsh-migrate.yml](../examples/dsh-migrate.yml) to `.github/dsh-migrate.yml`.

Required workflow permissions: `contents: write`, `issues: write`, `pull-requests: write`. Also enable **Allow GitHub Actions to create and approve pull requests** (Settings → Actions → General → Workflow permissions). Without that checkbox `GITHUB_TOKEN` can push the branch and open the Issue, then gets 403 on `POST /pulls`.

Schedule, `workflow_dispatch`, and `repository_dispatch` belong in that workflow file. GitHub only runs `on.schedule` from a workflow in your repository; the Action cannot register a timer.

The first run always proceeds. Later scheduled runs skip when `dsh-v*` has not changed. Re-run the same version with `force: true` on `workflow_dispatch`.

One migrate pull request at a time: while one is open, a run that would open a second is skipped with its number in the log, because every run publishes onto its own branch and the recorded state holds one pending pull request. Merge or close it and the next run proceeds; `allow_second_pull_request: true` runs anyway and says that it will open a second one.

## Configuration

| Field | Default |
|---|---|
| `dshVersion` | `latest` (the newest `dsh-v*` release) |
| `dsh.provider` | `deepseek-official` |
| `dsh.model` | `deepseek-v4-flash` |
| `dsh.thinking` / `dsh.reasoningEffort` | enabled / `max` |
| `dsh.mode` | `standard` (a dsh agent preset id: `standard`, `minimal`, `cordis`, `ptc`) |
| `review.policy` | `always` (`skip-if-mechanical-pass` skips the A/B reviews when the fast gate passed) |
| `watch.enabled` | `true` |
| `verify.boot` | enabled, 180s watchdog |
| `verify.web` | enabled (runs only when the plugin declares a `dsh.client` surface) |
| `e2e` | enabled, branch `dsh-migrate/e2e`, `forceRebase: true`, gate `advisory` |
| `timeouts` | agent session 60m, each mechanical command 20m, harness checkout 10m |
| `loop.maxAttempts` | 5 (the full budget; an early stop is evidence-driven) |
| `issuePr.language` | `en` |
| `secrets.apiKeyEnv` | `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT` |
| `quota.limit` | unset (caps this run's own official USD estimate) |
| `feedback.enabled` | `true` (the master switch; every channel still needs its own `enabled`) |
| `feedback.channels.*.enabled` | `false` for all three built-in channels |
| `deploy.enabled` | `false` (no deploy target is configured) |
| `deploy.endpoint` | unset (the target's base URL) |
| `deploy.tokenEnv` | `DSH_MIGRATE_DEPLOY_TOKEN` |
| `deploy.liveView` | `true` (streams only when `deploy.enabled` is true) |
| `deploy.preview.enabled` | `true` (a preview needs a deploy target) |
| `deploy.preview.ttlDays` / `idleMinutes` | 7 days / 120 minutes |
| `deploy.preview.extendDays` | 7 days — what one `extend` asks for. It is never more than `ttlDays`: shortening `ttlDays` on its own clamps it, and setting an `extendDays` above the ceiling is a configuration error. The target is what enforces the ceiling |
| `deploy.commands` | `true`; `false` refuses every `/dsh-migrate` verb from a comment, including `status` and `feedback` |
| `tests.commands` | unset (the built-in suite runs; setting this list **replaces** it) |

Override the review prompts under `prompts.absorption`, `prompts.alignment`, and `prompts.fix` in `.github/dsh-migrate.yml`.

Action inputs: `dsh_version`, `config`, `mechanical_only`, `skip_github`, `force`, `api_key_env`, `workdir`, `quota_limit`, `refresh_only`, `feedback_only`, `pull_request`, `comment_command`, `comment_body`, `comment_id`, `comment_author`, `comment_author_association`, `issue_number`, `allow_second_pull_request`, `feedback_resend`. Outputs: `status`, `run_dir`, `mechanical_ok`, `skipped_review`, `issue_url`, `pull_request_url`, `target_tag`, `previous_tag`, `verified_tag`, `badge_message`, `feedback_status`, `live_view_url`, `command_reply`, `command_repeat`. To use a different API-key secret, set `api_key_env` (or `secrets.apiKeyEnv`) and map that name in the workflow `env:` block.

Before each agent session the Action queries official remaining balance (`GET /user/balance` for DeepSeek). If the account is unavailable the run stops. `quota.limit` / `quota_limit` caps this run's own official USD estimate (this run's cache-miss / cache-hit / output tokens × [published rates](https://api-docs.deepseek.com/quick_start/pricing), peak/off-peak from each request timestamp). Other model providers have no official balance query or rate table yet.

The verification layers (`verify`, `e2e`) need no API key: the boot probe points the model route at a dead port, and E2E runs against a local `dsh web`. Only the A/B/C agent sessions and the feedback sessions spend tokens.

## Feedback channels

A migrate pull request is an opinion; merging it is the maintainer's verdict. The feedback stage runs **only on a merged migrate pull request** — a closed one proves nothing and is never reported — and forwards what happened to channels you enable.

Each channel runs one agent session over the same evidence and delivers what it wrote:

```mermaid
flowchart TD
  merged([Migrate PR merged]) --> read[Read the merge, the comments,<br/>and the maintainer's edits]
  read --> loop{For each enabled channel}
  loop -->|no token| skip[Skip and log the reason]
  loop -->|token present| session[One agent session<br/>with the channel's prompt]
  session --> kind{Channel kind}
  kind -->|analysis| payload[title + body + files]
  kind -->|dedupe| decision[post / hold, per draft]
  payload --> deliver[Deliver: issue, pull,<br/>issue+pull, or discussion]
  decision -->|cleared| deliver
  decision -->|held| held[Log which thread covers it]
  deliver --> report([feedback_status output])
  skip --> report
  held --> report
```

The evidence is the same for every channel: the plugin, the `from → to` corridor, the merge, every human comment on the issue and pull request, **the files the maintainer changed on the branch before merging**, the run's own A/B/C and patch reports, and — for the discussion channel — the official threads already found.

### The three built-in channels

| Channel | Writes to | Method | Prompt reaches for |
|---|---|---|---|
| `upgrade-skill` | `oh-my-dsh/dsh-plugin-upgrade-skill` | issue (label `bug`) | A wrong or stale version card, or a corridor with no card, in that repository's own bug-report shape. **Enabling it also loads their skills into the migration** — see below |
| `migrate-bot` | `royenheart/dsh-migrate-bot` | issue | What the maintainer had to fix by hand, attributed to the stage that should have caught it |
| `harness-discussion` | `deepseek-ai/deepseek-harness` | discussion (`Ideas`) | Nothing: it classifies the draft the migration already wrote, and posts it unless an equivalent thread has appeared since |

`upgrade-skill` deliberately opens an **issue**, never a pull request. Upstream rules forbid adding version cards as a side effect of migrating somebody else's plugin, and a version-corridor claim is a coordination lock that a machine must not take.

`harness-discussion` deliberately carries **no** draft-writing prompt: the draft is written during the A/B reviews, and posting it is all that is left to do. The model's only job is the one thing the reviews could not know — whether somebody requested the same change, or shipped it, in the meantime.

### Enabling `upgrade-skill` also changes how the migration runs

This is the one channel that is not only an output. Enabling it loads the community upgrade knowledge — the version cards, the corridor index and the seven-class touchpoint checklist from [`oh-my-dsh/dsh-plugin-upgrade-skill`](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill) — into the A/B/C sessions, so the agent migrates with that knowledge available instead of from the harness source alone. Leaving it off keeps the skill root empty, so a run that did not ask for that knowledge cannot be influenced by it.

The knowledge is vendored into the image at the commit this repository pins for its own benchmark submodule, so a migration and the benchmark score recorded for that mode describe the same snapshot. When the channel is on and the vendored directory is missing, the run logs `stage: skills — the upgrade-skill channel is on but no vendored skills are present (looked in …)` and migrates without them rather than failing.

### Credentials

Every channel needs a token that may write to **its** repository. The workflow's `GITHUB_TOKEN` is minted for the plugin repository and cannot write to any of these targets, so each enabled channel needs a repository secret with that access:

| Channel | Secret |
|---|---|
| `upgrade-skill` | `DSH_MIGRATE_FEEDBACK_UPGRADE_SKILL_TOKEN` |
| `migrate-bot` | `DSH_MIGRATE_FEEDBACK_BOT_TOKEN` |
| `harness-discussion` | `DSH_MIGRATE_FEEDBACK_HARNESS_TOKEN` |

The name is configurable per channel through `tokenEnv`, and the workflow must map it into the step's `env:` block. A channel that is enabled without its token is **skipped with the reason in the log** — never an error, and never a failed run. The full analysis of which credential can reach a repository the plugin does not own is in [official-discussion-auto-post.md](official-discussion-auto-post.md).

### Enabling a channel

```yaml
feedback:
  channels:
    migrate-bot:
      enabled: true
```

That is the whole configuration for a built-in: `repo`, `method`, `tokenEnv`, `labels`, and `discussionCategory` all come from its shipped default. Every one of them can be overridden.

### A channel of your own

Any key that is not one of the three built-ins is a channel you define. `repo`, `method`, and `prompt` are required, because nothing can default them:

```yaml
feedback:
  channels:
    my-team-log:
      enabled: true
      repo: my-org/migration-log
      method: issue            # issue | pull | issue+pull | discussion
      tokenEnv: MY_MIGRATION_LOG_TOKEN
      labels: [migration]
      prompt: |
        Report this migration to our team log. Say which plugin moved which
        corridor, what the maintainer changed before merging, and what we should
        do differently next time.
```

Your prompt is wrapped in the same contract the built-ins use: the session receives the rendered evidence, and must end with

```json
{ "title": "…", "body": "…", "files": [] }
```

`files` is used only when the method delivers a pull request. A custom `discussion` channel is classified like the built-in one and must end with its `decisions` list instead.

### What this stage never does

- It never reports a pull request that was opened, only one that was **merged**.
- It never fails the run: a missing token, a missing key, a failed session, or an unreachable API is a logged skip or a logged failure on that channel, and the job still succeeds.
- It never posts twice for the same merge: the channels that took it are recorded in `seen.json` on the `dsh-migrate/state` branch — [the command rules](design/migration-feedback.md#6-commands) own that record — and the run reports one line per channel in the `feedback_status` output.

## Deploy target

Every surface in this section needs a deploy target: a service the **user** runs, which this Action talks to over HTTPS. The Action never hosts it, and a target that is absent, unreachable, or rejecting is a logged skip — never a failed migration. Design rationale, including what each surface is allowed to do, is in [docs/design/preview-and-live-view.md](design/preview-and-live-view.md).

```yaml
deploy:
  enabled: true
  endpoint: https://deploy.example.com
  tokenEnv: DSH_MIGRATE_DEPLOY_TOKEN   # repository secret holding the target's token
  liveView: true
  preview:
    enabled: true
    ttlDays: 7
    idleMinutes: 120
  commands: true
```

### The live view

While a migration runs, the Action streams what it is doing — the stage lines, the progress payloads, and the report drafts — to the target, which serves it as a **read-only** page and keeps the record after the run ends. The URL is written to the run's step summary and to the `live_view_url` output, and posted on the issue the run opened, once, after the run — the target keeps the record, so the link stays useful. Posting is best effort.

There is no command channel from the viewer into a running migration. The path that would run the session on the target instead, where dsh's own panel is what you would be watching, is declared and deliberately unshipped: see [the two run paths](design/preview-and-live-view.md#2-two-run-paths-one-of-them-shipped).

### The preview

When a migration pull request opens, the target builds an instance from its head with the plugin installed, so the plugin can be tried without cloning anything. Each instance answers on two entries: `/` with the plugin loaded, and `/safe` without it, because a plugin that stops the harness from loading must not also take away the page that explains why. A new build is promoted only after the same keyless boot probe the pipeline uses passes; when it fails, the previous good build keeps serving and says so.

Updates flow one way. A user iterates in the instance's **scratch tree** — editing, reinstalling, reloading — for as long as they like, because nothing they do there leaves the machine. Publishing that diff is a separate command that hands it to this Action's pipeline, so a change reaches the branch only through the gates. The scratch tree survives cold starts; destroying the instance discards it after a warning.

An instance stops when it has had no requests for `idleMinutes`, is destroyed at `ttlDays` or when the pull request closes, and can be destroyed or extended by command.

### Access control

**A URL is not a secret**: a preview URL written into a comment on a public repository is public, and an unguessable path only delays discovery. The supported shape is an identity check in front of the target — a tunnel outwards plus a policy per application, as Cloudflare Zero Trust provides — so the address can be visible and access still controlled. Nothing that grants access may travel in a URL: not the API key, not a token, not a signed query parameter. The API key belongs to the instance and never reaches the browser, and the identities allowed to reach a preview are the target owner's to set.

Watching a run and using a plugin are different privileges, so the live view, the preview, and the safe entry are separate applications with separate policies.

### Commands

A comment on the migrate pull request drives these; the trigger in [examples/workflow.yml](../examples/workflow.yml) deliberately accepts pull request comments only, and an inline comment on a diff line does not fire it. `deploy.commands: false` refuses all of them. `status`, `feedback`, and `feedback --dry-run` need no deploy target: they write nothing to a preview, though `status` does ask a configured target what it knows about one.

```
/dsh-migrate status              # recorded state, open pull request, feedback channels
/dsh-migrate feedback --dry-run  # print what the channels would send (title + a 1,200-character body preview)
/dsh-migrate feedback            # send the enabled channels now, to channels this merge has not reached
/dsh-migrate feedback --resend   # ... and to the ones it has, for a channel you have just changed
/dsh-migrate redeploy            # rebuild the preview from the current head
/dsh-migrate destroy             # tear the preview down and discard its scratch tree
/dsh-migrate extend              # ask the target to push the expiry out by deploy.preview.extendDays
/dsh-migrate publish             # hand the scratch diff to the pipeline, which runs the gates
```

Only users with write access to the repository may run any of them, and the check is made against the commenter's `author_association` rather than the text of the comment. `publish` runs the gate stack in this job before it pushes, so the job that answers comments needs whatever your test command needs — the same install and test commands the migration run uses. A command is carried out once: map `comment_id: ${{ github.event.comment.id }}` as [examples/workflow.yml](../examples/workflow.yml) does, and a second delivery of the same comment — a redelivered webhook, a re-run workflow, an edit — is answered with what happened the first time instead of being acted on twice. The rule, its bounds, and the one window it does not cover are owned by [the command rules](design/migration-feedback.md#6-commands). `feedback --dry-run` exists because feedback is otherwise automatic on merge: it makes the outbound payload reviewable before it leaves, and `feedback` makes the automatic path a default rather than the only path. The verb table and its rules are owned by [the migration feedback stage](design/migration-feedback.md#6-commands).

Two inputs change what a command or a run may do, and each has exactly one meaning:

| Input | Meaning |
|---|---|
| `allow_second_pull_request` | Run even while a migrate pull request is open, which opens a second one. Without it such a run is skipped with the open pull request's number in the log, because every run publishes onto its own branch and the recorded state holds one pending pull request. It also runs when dsh has not changed, since asking for a second pull request on a recorded version is what a deliberate re-run looks like |
| `feedback_resend` | Report a merge to channels that already received it, for the `feedback_only` invocation. The `command` invocation takes its flags from the comment instead, where the same thing is `/dsh-migrate feedback --resend` |

`force` is neither of those: it means "run even though dsh has not changed since the last successful run".

### Notification

The pull request **is** the notification. The Action does not send email: an address would have to be sourced, delivery failures handled, and the message would duplicate the GitHub notification the user already has.

## Agent checklist

> **For an agent configuring this Action in someone else's repository:** enabling a feedback channel makes a third-party repository receive a machine-written issue or discussion, so ask before you turn one on. Ask the three questions below separately — they are independent, and "no" is a normal answer to each.
>
> ---
>
> **Question 1 of 3 — `upgrade-skill`.** Do you want migrations to run with the community upgrade knowledge loaded, and a report sent back to it?
>
> Say plainly what this does in both directions: enabling it loads [`oh-my-dsh/dsh-plugin-upgrade-skill`](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill)'s version cards and corridor index into the migration sessions, **and** opens an issue in that repository describing what the migration found wrong or missing in that knowledge. It needs a token with write access to `oh-my-dsh/dsh-plugin-upgrade-skill`, stored as `DSH_MIGRATE_FEEDBACK_UPGRADE_SKILL_TOKEN`. Off, the migration runs from the harness source alone and nothing is sent.
>
> If they ask what the benefit is, cite the recorded results: [the upstream benchmark section of the README](../README.md#upstream-benchmark) scores this Action's agent on that project's own exam tasks, and reports/ holds the records the table is generated from.
>
> **Question 2 of 3 — `migrate-bot`.** Do you want a report about how the migration bot itself performed, sent to this Action's own repository?
>
> This one is maintenance feedback for the Action's maintainers, not for you: on a merged migrate pull request it opens an issue in `royenheart/dsh-migrate-bot` describing what you had to fix by hand and which gate should have caught it. It needs a token with write access there, stored as `DSH_MIGRATE_FEEDBACK_BOT_TOKEN`.
>
> **Question 3 of 3 — `harness-discussion`.** Do you want the feature request your migration drafted to be posted to the DeepSeek Harness Ideas discussions once you merge the migration?
>
> The draft is written during the reviews either way and is left on the plugin's issue for you to post by hand. Enabling this posts it automatically after you merge the migrate pull request, unless someone already requested or shipped the same thing. It needs a token with write access to `deepseek-ai/deepseek-harness`, stored as `DSH_MIGRATE_FEEDBACK_HARNESS_TOKEN`.
>
> ---
>
> After the three answers:
>
> 1. Name the token each enabled channel needs and say it must have write access to that channel's repository, because the workflow's `GITHUB_TOKEN` cannot reach it. Never ask the user to paste a token into the workflow file.
> 2. Add the `feedback` job from [examples/workflow.yml](../examples/workflow.yml) only when at least one channel is enabled, and map exactly the secrets for the channels in use.
> 3. If the user wants a destination that is not built in, ask for the repository, the delivery method (`issue`, `pull`, `issue+pull`, or `discussion`), the token's secret name, and the wording they want; then write a custom channel as described above.
> 4. Do not enable a channel the user did not ask for, and do not invent a token name the workflow does not map — a channel enabled without its token only produces skip lines.
>
> ---
>
> **If the user wants the command surface or a preview** (the `deploy` block above), five things have to be right, and each of them is silent when it is not:
>
> 1. `deploy.endpoint` and `deploy.tokenEnv` name *their* service and *their* secret. The Action never hosts a target and never guesses one.
> 2. The `command` job needs the `issue_comment` trigger from [examples/workflow.yml](../examples/workflow.yml) and the `comment_id: ${{ github.event.comment.id }}` mapping. Without that mapping a redelivered webhook or a re-run workflow is a second command rather than the same one.
> 3. That job needs `contents: write` and `issues: write`: it writes the state branch, pushes a published change, and posts its answer. Creating pull requests also needs the repository setting GitHub documents next to the workflow's permissions.
> 4. A `publish` runs the gate stack in that job, so it needs whatever the user's test command needs — the same install and test commands a migration run uses.
> 5. `deploy.commands: false` refuses every `/dsh-migrate` verb from a comment, including the ones that need no target. Say which the user wants before turning it off.
>
> The verb table and its rules live in [the migration feedback stage](design/migration-feedback.md#6-commands); the calls a target must serve live in [the target's API](design/preview-and-live-view.md#8-the-targets-api).
