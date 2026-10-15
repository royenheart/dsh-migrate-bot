# dsh-migrate-bot

A GitHub Action that moves a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin to each new `dsh-v*` release. It checks the plugin against the release, and when the plugin needs changes, agent sessions review and repair it until the checks pass. The result is proposed to the maintainer as a pull request.

## What it does

For each consumer repository and target release, one migration, which covers the plugin at the repository's root or every plugin below it:

1. boots the unmodified plugin on the release it last worked on and on the target release, to tell a regression from a pre-existing failure;
2. runs an overlap review (which documented capabilities the release now covers) and an extension-point review (which official extension points the plugin should use), unless the review policy skips them because the unmodified plugin already passes;
3. runs the [checks](docs/design/checks.md#the-five-checks) — the change cards of the upgrade skill, mechanical (dependency contract, build, typecheck, tests), boot, web, and the agent-authored end-to-end suite — and repairs the plugin until they pass or the attempt limit is reached;
4. proposes a changed plugin on the branch `dsh-migrate/proposal`, with a pull request and an issue that carries the review and repair reports;
5. after the maintainer merges the proposal, sends merge reports to the channels the consumer enabled.

A newer release takes over the open proposal instead of opening a second one. Every check runs without an API key ([what a check can read](docs/design/checks.md#what-the-code-a-check-runs-can-read)); only the agent sessions spend tokens. The workflow is specified as a statechart; its states and transitions are in the [workflow reference](docs/reference/workflow.md), and the design is in [docs/design/workflow.md](docs/design/workflow.md).

## Install

A plugin repository adds a secret with a DeepSeek API key, a workflow that calls this repository's reusable workflow, and optionally a configuration file; [docs/operations/install.md](docs/operations/install.md#the-workflow) has the steps. A coding agent working in the plugin repository can do it instead, asking the maintainer what it cannot find out: give it a prompt such as

> Set up dsh-migrate in this repository by following https://github.com/royenheart/dsh-migrate-bot/blob/<release>/docs/operations/install.md#setting-it-up-with-an-agent

with `<release>` the release to pin ([what a consumer pins](docs/operations/release.md#what-a-consumer-pins)). Every configuration key is in the [configuration reference](docs/reference/configuration.md).

## The state branch and the badge

The Action keeps its record on the branch `dsh-migrate/state`: one event log per migration, the reports a merge report quotes, and `badge.json`. Leave the branch unmerged. The badge shows the newest verified release and, when a newer release is in progress, what happened to it:

```markdown
[![dsh](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FOWNER%2FREPO%2Frefs%2Fheads%2Fdsh-migrate%2Fstate%2Fbadge.json)](https://github.com/OWNER/REPO/tree/dsh-migrate/state)
```

## Comment commands

On a proposal's issue or pull request, a commenter the Action admits ([who](docs/design/workflow.md#9-comment-commands)) can comment `/dsh-migrate status`, `/dsh-migrate report`, and, with a deploy service configured, the preview deployment commands. The [command reference](docs/reference/commands.md) lists them. A deploy service is an HTTP service the consumer runs; this repository ships [a reference implementation](docs/operations/deploy-service.md) and a conformance suite for any other.

## Run it locally

```sh
npm ci
npm test
node dist/src/cli.js check --workdir /path/to/plugin --target 0.2.0-rc.2
```

`check` runs every check on a working tree without an API key. `run` migrates; put the API key in a gitignored `.secrets.local.json` (see [.secrets.local.json.example](.secrets.local.json.example)) or in `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT`, and pass `--skip-github` so it calls no GitHub API: it opens no proposal, issue or report, and catches nothing up ([starting a migration](docs/design/workflow.md#6-starting-a-migration)). It still writes its state branch, and the end-to-end suite when one is [published](docs/design/checks.md#the-end-to-end-suite-and-its-baseline), to the checkout's `origin` when there is one, and streams its log to a configured deploy service; in a clone without an `origin` remote both branches stay local. Agent sessions need the agent runtime's `dsh` on `PATH`, or `DSH_BIN`.

```sh
docker build -t dsh-migrate-bot .
docker run --rm -v "$PWD/fixtures/plugins/typecheck-ok:/github/workspace" dsh-migrate-bot check --workdir /github/workspace --target 0.2.0-rc.2
```

## Benchmark

The Action is scored on two task suites, the upgrade skill's and a suite of real migrations across release spans: the full workflow (`pipeline`) and a single agent session (`session`), each with and without the community upgrade skill. The results, their trends and the diff behind every attempt are published at [royenheart.github.io/dsh-migrate-bot](https://royenheart.github.io/dsh-migrate-bot/) from the records on the `bench/records` branch; [the evaluation design](docs/design/evaluation.md) says what is measured and how.

## Contributing

[AGENTS.md](AGENTS.md) holds the rules for working in this repository, and [docs/index.md](docs/index.md) lists every document. Run `npm run gates` and `npm test` before pushing.
