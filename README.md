# dsh-migrate-bot

GitHub Action that watches [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh-v*`) releases and migrates a third-party plugin: mechanical tests, two dsh review sessions (DeepSeek V4 Pro, thinking `max`, [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)), a repair loop, then an Issue and PR only if the plugin tree is dirty.

Install it by adding a workflow to the plugin repository. It runs on that repo’s GitHub-hosted runners. Provide `DEEPSEEK_API_KEY` as a repository secret.

Pin the Action as `royenheart/dsh-migrate-bot@v0`.

## Usage

1. Add repository secret `DEEPSEEK_API_KEY`.
2. Copy [examples/workflow.yml](examples/workflow.yml) to `.github/workflows/dsh-migrate.yml` and set the cron.
3. Optionally copy [examples/dsh-migrate.yml](examples/dsh-migrate.yml) to `.github/dsh-migrate.yml`.

Required permissions: `contents: write`, `issues: write`, `pull-requests: write`.

Schedule, `workflow_dispatch`, and `repository_dispatch` belong in **that** workflow file. GitHub only runs `on.schedule` from a workflow in the plugin repo; the Action itself cannot register a timer.

The first run always proceeds. Later scheduled runs skip when `dsh-v*` has not changed (`status: skipped`). Re-run the same version with `force: true` on `workflow_dispatch`.

Last processed version is stored on branch `dsh-migrate/state` (`seen.json` only). Leave that branch unmerged. Reports under `.dsh-migrate/` are uploaded as an artifact and are not committed.

## Pipeline

1. Resolve the target `dsh-v*` (`latest` or a pin).
2. Skip if that version matches `dsh-migrate/state`, unless `force` is set or `watch.enabled` is `false`. Failed runs do not update the branch, so the next schedule retries.
3. Mechanical tests (built-in, or `tests.commands` — that list **replaces** the default suite).
4. Review: `always` (default) runs overlap (A) then alignment (B); `skip-if-mechanical-pass` skips A/B when step 3 passed.
5. Re-run mechanical tests after A+B.
6. On failure, a new dsh session gets A+B, error lines only, and prior `C1..Cn-1`; write `Cn`; retest; up to `loop.maxAttempts`.
7. Clean worktree: no Issue, no PR (`.dsh-migrate/` does not count as dirty).
8. Dirty worktree: open an Issue and a PR (`issuePr.language`: `en` or `zh`). Full A/B/C reports stay in the artifact.

## Configuration

| Field | Default |
|---|---|
| model | `deepseek-v4-pro` |
| thinking | enabled / `max` |
| mode | `anchored-standard` |
| review | `always` |
| watch | enabled |
| Issue/PR language | `en` |
| repair loops | 5 |

Override prompts under `prompts.absorption`, `prompts.alignment`, and `prompts.fix` in `.github/dsh-migrate.yml`.

Inputs: `dsh_version`, `config`, `mechanical_only`, `skip_github`, `force`, `workdir`.

## Local CLI

```sh
npm install
npm test
node dist/src/cli.js run --workdir /path/to/plugin --mechanical-only --dsh-version 0.1.1-rc.2
```

`--skip-github` runs the agent without opening an Issue or PR. `--mechanical-only` skips the agent and GitHub. Host agent runs need a real `dsh` binary on `PATH` (`DSH_BIN` if it is not named `dsh`). A shell alias is not visible to `spawn`.

Put the API key in gitignored `.secrets.local.json` (see [.secrets.local.json.example](.secrets.local.json.example)), or set `DEEPSEEK_API_KEY`. Live e2e: `DSH_MIGRATE_LIVE=1 npm run test:e2e`.

```sh
docker build -t dsh-migrate-bot .
docker run --rm \
  -e DEEPSEEK_API_KEY \
  -v "$PWD/fixtures/plugins/typecheck-ok:/github/workspace" \
  dsh-migrate-bot run --workdir /github/workspace --mechanical-only --dsh-version 0.1.1-rc.2
```

Pass the key with `-e DEEPSEEK_API_KEY` or a `KEY=value` env file, not `.secrets.local.json` as Docker `--env-file`.

## Releasing

Version lives in [`.cz.toml`](.cz.toml). [Commitizen](https://commitizen-tools.github.io/commitizen/) (`cz bump`) updates `VERSION`, `package.json`, `package-lock.json`, and `CHANGELOG.md`.

```sh
pipx install commitizen
npm run commit
npm run bump
git push origin HEAD --follow-tags
git tag -f v0
git push origin v0 --force
```

Create a GitHub Release from the version tag. Consumers pin `@v0`.
