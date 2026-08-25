# dsh-migrate

Public **containerized GitHub Action** that watches DeepSeek Harness (`dsh-v*`) and migrates a third-party plugin: mechanical tests first, then two review sessions on a **dsh** agent (DeepSeek V4 Pro, thinking `max`, [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)), then a repair loop, then Issue + PR **only if the working tree is dirty**.

This is not a hosted GitHub App. Users add one workflow file to their plugin repository. The Action image runs on **their** GitHub-hosted runner; they provide `DEEPSEEK_API_KEY` as a repository secret.

## Can it be published to the Marketplace? Can it run on a schedule?

Yes to both, with one GitHub constraint:

- Publish this repo as a [GitHub Action](https://docs.github.com/en/actions/sharing-automations/publishing-actions-in-github-marketplace) (container `runs.using: docker`). Create a tagged release (for example `v0.1.0`) and tick “Publish this Action to the GitHub Marketplace”. Other people then install it by referencing `owner/dsh-migrate-bot@v0` in a workflow.
- **Timers are declared in the consumer workflow**, not inside the Action. GitHub only fires `on.schedule` cron from a workflow YAML in *their* repo. We ship a template — they edit the cron.

```yaml
on:
  schedule:
    - cron: '0 3 * * *'   # their timezone policy
  workflow_dispatch:
```

The Action cannot register a cron on their behalf. Optional extras: `workflow_dispatch` (manual) and `repository_dispatch` (an external watcher that fires when a new `dsh-v*` tag appears).

## Install in a plugin repo

1. Add repository secret `DEEPSEEK_API_KEY`.
2. Copy [examples/workflow.yml](examples/workflow.yml) to `.github/workflows/dsh-migrate.yml` and edit the cron.
3. Optionally copy [examples/dsh-migrate.yml](examples/dsh-migrate.yml) to `.github/dsh-migrate.yml`.

Permissions needed: `contents: write`, `issues: write`, `pull-requests: write`.

The example workflow uploads `.dsh-migrate/` with `actions/upload-artifact`. Those files are **not** committed; a clean plugin tree never opens an Issue or PR.

Action inputs (`dsh_version`, `config`, `mechanical_only`, `skip_github`, `force`, `workdir`) are forwarded from GitHub `INPUT_*` environment variables to the CLI.

## Pipeline

1. Resolve the target `dsh-v*` (`latest` or a pin).
2. **Update gate.** Compare that target with the last successful run stored on the plugin repo’s **`dsh-migrate/state`** branch (`seen.json` only). If this is the first run (branch missing), continue. If the version is unchanged, exit `skipped` and do not call the agent. Pass `force: true` (or `--force`) to ignore the gate. Failed runs do **not** update the branch, so the next schedule retries.
3. Mechanical tests (built-in, or `tests.commands` if set — that list **replaces** the default suite).
4. Review policy:
   - `always` (default): run overlap review (A) then alignment review (B).
   - `skip-if-mechanical-pass`: if step 3 passed, skip A/B.
5. After A+B, mechanical tests **must** run again.
6. On failure: new dsh session with A+B + **error lines only** + prior `C1..Cn-1`; write `Cn`; retest; repeat up to `loop.maxAttempts`.
7. If the git worktree is **clean**: stop. No Issue, no PR. (`.dsh-migrate/` reports do not count as dirty.)
8. If **dirty**: open an Issue and a PR (default English; `issuePr.language: zh` for Chinese). Full A/B/C reports stay in `.dsh-migrate/` / the Action artifact, not in the PR.

The state branch is written with git objects (`hash-object` / `commit-tree` / `push`) and is **never checked out** onto the plugin worktree, so user source on `main` / `master` is not modified. Do not merge `dsh-migrate/state` into the default branch. Keep `contents: write` so the Action can create and update that branch.

Set `watch.enabled: false` in `.github/dsh-migrate.yml` to disable the gate.

## Local CLI

```sh
npm install
npm test
node dist/src/cli.js run --workdir /path/to/plugin --mechanical-only --dsh-version 0.1.1-rc.2
```

`--skip-github` runs the agent pipeline without opening an Issue or PR. `--mechanical-only` skips the agent and GitHub entirely.

Host agent runs need a real `dsh` binary on `PATH`. A shell alias (for example `npx @deepseek-ai/dsh`) is not visible to `spawn`. Set `DSH_BIN` to an executable, or run inside the Action image where dsh is installed globally.

Agent runs need a key. Put it in **`.secrets.local.json`** at the app root or the plugin root (this file is gitignored). Copy [.secrets.local.json.example](.secrets.local.json.example):

```json
{ "DEEPSEEK_API_KEY": "sk-..." }
```

Environment variables override the file. Live e2e (real dsh + key):

```sh
DSH_MIGRATE_LIVE=1 npm run test:e2e
```

Local container (same image the Action uses):

```sh
docker build -t dsh-migrate .
docker run --rm \
  -e DEEPSEEK_API_KEY \
  -v "$PWD/fixtures/plugins/typecheck-ok:/github/workspace" \
  dsh-migrate run --workdir /github/workspace --mechanical-only --dsh-version 0.1.1-rc.2
```

Pass the key with `-e DEEPSEEK_API_KEY` or a `KEY=value` env file. Do not use `.secrets.local.json` as Docker `--env-file`; that flag is not JSON.

The image installs `@deepseek-ai/dsh`, clones [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) into `/opt/dsh-anchored-standard`, and prepares a `migrate` profile so agent steps run as `dsh --profile migrate "<task>"` with preset `anchored-standard`.

## Defaults

| Field | Default |
|---|---|
| backend | dsh only |
| model | `deepseek-v4-pro` |
| thinking | enabled / `max` |
| mode | `anchored-standard` (other [anchored-standard modes](https://github.com/xiaobright/dsh-anchored-standard) are preinstalled in the image) |
| review | `always` |
| watch | enabled (skip when dsh-v* is unchanged) |
| Issue/PR language | `en` |
| repair loops | 5 |

Prompts ship in English and can be overridden under `prompts.absorption`, `prompts.alignment`, and `prompts.fix` in `.github/dsh-migrate.yml`.

## Versioning this Action

The release version is declared once in [`.cz.toml`](.cz.toml) (`version = "…"`). [Commitizen](https://commitizen-tools.github.io/commitizen/) (`cz bump`) is the only bump path. It also rewrites:

- [`VERSION`](VERSION) (plain-text copy)
- `package.json` / `package-lock.json` `version` fields
- [`CHANGELOG.md`](CHANGELOG.md)

Install Commitizen (Python) once, then bump from conventional commits:

```sh
pipx install commitizen   # or: uv tool install commitizen
npm run commit            # cz commit
npm run bump              # cz bump --changelog → tag vX.Y.Z
```

Use `feat:` / `fix:` / `BREAKING CHANGE` so the bump size is inferred. After a bump, push the commit and tags (see below).

## Publish (after the GitHub repo exists)

1. Push this repository (`git remote add origin git@github.com:<you>/dsh-migrate-bot.git && git push -u origin HEAD`).
2. Bump if needed (`npm run bump`) and push the version commit plus tags:
   ```sh
   git push origin HEAD --follow-tags
   git tag -f v0                # floating major tag consumers pin
   git push origin v0 --force
   ```
   GitHub Actions that `uses: docker` **build the image from the tagged commit’s Dockerfile**. The moving `v0` tag is what plugin repos should pin.
3. On GitHub: **Releases → Draft a new release** from tag `v0.1.0` (or whatever `cz bump` created). Tick **Publish this Action to the GitHub Marketplace**, pick a category, publish.
4. Confirm the Action appears at `https://github.com/marketplace/actions/…` and that `https://github.com/<you>/dsh-migrate-bot/blob/v0/action.yml` exists.

You do not publish the container to GHCR for Marketplace install; consumers pull this repo at a tag and GitHub builds/runs the Dockerfile.

## Use in a plugin repository

1. In the **plugin** repo, add secret `DEEPSEEK_API_KEY`.
2. Copy [examples/workflow.yml](examples/workflow.yml) to `.github/workflows/dsh-migrate.yml`. Change `uses: royenheart/dsh-migrate-bot@v0` to `<you>/dsh-migrate-bot@v0`.
3. Optionally copy [examples/dsh-migrate.yml](examples/dsh-migrate.yml) to `.github/dsh-migrate.yml`.
4. Keep `permissions.contents: write` so the Action can create `dsh-migrate/state`.
5. First scheduled or **Run workflow** run always proceeds (no prior state). Later crons no-op until a new `dsh-v*` appears. Use `force: true` on `workflow_dispatch` to re-run the same version.
6. If migration dirties the plugin tree, an Issue + PR open on the default branch. `dsh-migrate/state` stays separate; leave it unmerged.
