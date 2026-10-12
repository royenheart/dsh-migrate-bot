---
kind: design
description: The four checks a migration runs, the agent runtime the sessions run in, and the end-to-end suite and its baseline.
---

# Checks and the agent runtime

A check looks at the plugin working tree under one release and produces a check result: `pass`, `fail` or `skipped`, a failure fingerprint, and the output. The [workflow design](workflow.md) decides which checks run when; this document explains each check, the end-to-end suite the agent maintains, and the dsh installation the agent sessions run in.

## Principles

1. **Let the agent explore; classify nothing in advance.** A runtime failure shows up in open-ended ways: service collisions, duplicate slot registrations, renamed services, patch targets that disappeared. A fixed failure taxonomy would be wrong often, and a wrong label would enter every later repair prompt as a fact. The checks report what happened; the repair session interprets it.
2. **Decide from evidence.** The repair loop continues while the failure fingerprint changes and stops on a repeated fingerprint, an upstream blocker with all evidence fields, the attempt limit, or the spend cap. It never stops on a guess about the cause.
3. **Cheap checks first.** A pass stops at its first failure, and the repair session receives the output of that check only.
4. **The repair session cannot edit the tests.** The end-to-end suite lives outside the plugin tree, on its own branch, so a repair cannot make the suite pass by weakening it.

## The four checks

| Check | What it runs | Needs an API key | What it catches |
|---|---|---|---|
| `mechanical` | In each plugin's directory: the dependency contract, the plugin-shape scan, then `npm install`, the `@deepseek-ai/dsh-*` dependencies pinned to the release, and the plugin's `build`, `typecheck` and `test` scripts; `tests.commands` replaces the scripts | no | A dependency the release no longer publishes or a range that does not admit it; type, build and unit-test failures |
| `boot` | Installs every plugin of the tree into one temporary profile and starts dsh | no | A plugin that fails to load, throws in `apply`, waits forever for a service, or hangs the host |
| `web` | Starts `dsh web` headless with every plugin mounted and waits for the ready line; skipped when no plugin declares `dsh.client` | no | A web client that never attaches |
| `e2e` | The suite from the suite branch, against a `dsh web` of the release serving every plugin; a test of the end-to-end baseline that no longer passes fails the check; skipped while no suite exists | no | A feature a user reached before the migration and can no longer reach, layout and console errors |

A plugin is a directory whose `package.json` declares `dsh.bundle` (`src/plugins.ts`). A repository is one plugin at its root, or several below it, for example a host, a web and a tools plugin shipped together; then the mechanical check runs in each plugin's directory and reports every failing plugin by name, and the boot and web checks load all of them into one profile, as a user who installs them together does. One migration and one proposal cover every plugin, and the source release is the earliest release every plugin's ranges admit.

The dependency contract (`src/mechanical/dependencies.ts`) runs first, because pinning the dependencies to the release hides what a user installing the plugin would meet. Every `@deepseek-ai/dsh-*` package is published with the release's version and a removed one stops at its last release, so each package the plugin names must be published at the release, under a range that admits it by npm's rules, which compare a prerelease only within the same `major.minor.patch`. The published versions are read from the npm registry; when it cannot be read, the contract decides nothing and the install that follows fails instead.

A plugin that declares no build, typecheck or test command produces a skipped mechanical check, not a passing one. Each release a check needs is installed once into its own cached prefix (`src/verify/dsh-install.ts`), with `npm install --before` an hour after the release was published, so it gets the dependencies it was published with: a fresh install of an older release otherwise resolves today's Cordis and fails to boot whatever the plugin does. An installation that fails is an error of the Action, not a failed check. A plugin with a browser half (`dsh.client`) may need services only the web composition provides, so the boot check loads the plugins without one and the web check loads every plugin in the web composition; when every plugin has a browser half, the boot check is skipped and says so. The web check passes `--no-open` only to a release whose `dsh web --help` lists it.

### Why the boot check needs no key

dsh's boot path ends by asserting that every entry activated, so it reports an import failure, an `apply` that threw, or an entry pending on a service nobody provides, and exits non-zero. The boot check gives dsh a placeholder key and points the model route at a closed port: reaching the credential or connection error proves the plugin tree assembled and activated, and the check costs nothing. dsh has no hang protection, so the check carries its own watchdog.

## The end-to-end suite and its baseline

The suite (`src/e2e/suite.ts`) is a self-contained Playwright project: its own `package.json` pinning `@playwright/test` to the image's Playwright, a configuration using Chromium, the specs, and an `index.json` with one row per user-visible feature. It never starts dsh. The Action serves the plugin tree with `dsh web` of a release and hands the suite the launch URL in `DSH_MIGRATE_WEB_URL`, so the same tests run against any release.

| Decision | Value | Reason |
|---|---|---|
| Location | `checks.e2e.dir` on `checks.e2e.branch` (default `dsh-migrate/e2e`), a branch that holds the suite and nothing else | Never part of a proposal's diff, so a proposal stays reviewable, two migrations never conflict over the suite, and a repair session never sees it |
| Baseline | Before the migration changes anything, the suite runs against the unmodified tree on the source release; the tests that pass are the end-to-end baseline. When the branch has no suite yet, an agent session writes it first, against that same served tree | A test written against the source release and passing there describes what the plugin did, not what the migration made of it |
| Check | After every review and repair, the suite runs on the target release. A baseline test that no longer passes fails the check, and its id enters the failure fingerprint and the repair prompt; a test outside the baseline cannot fail it | A failure means a feature broke in the migration, which the repair loop must fix |
| Publishing | After the migration concludes, the suite is committed as `dir/` on the branch and pushed. Without a baseline (no source release, or the source release does not serve the plugins), a session first writes or extends the suite against the migrated tree on the target release | The next migration starts from the suite this one checked, and writing a suite never delays a proposal |
| Index | `index.json` lists each feature, how a user reaches it, what is asserted, and the spec; `INDEX.md` renders it with the release it was last checked on | The index is the coverage record a maintainer reads |

A failure of a baseline test is a regression and is treated as one under either failure policy. Without a baseline, a suite was written against the migrated tree and passes by construction, so its result is weak evidence: under the default `advisory` policy its failure becomes a warning in the proposal, and `blocking` makes it fail the migration.

### Assertions

| Layer | Approach | Needs a baseline |
|---|---|---|
| Structure | ARIA roles and accessible names, text content, geometry invariants (content clipped by its box, elements outside their parent's clip, occluded or collapsed elements), console and `pageerror` tripwires | no |
| Timing | Drive to a state, then poll until two consecutive reads agree; never wait for network idle, which an open event stream never reaches | no |
| Visual | `toHaveScreenshot()` with reference images on the suite branch | yes |

The suite uses Playwright with Chromium, as dsh tests its own web client, but asserts on roles and labels rather than dsh's internal `data-*` attributes, which change between releases.

## Watchdogs

dsh has no hang protection, so every process the Action starts has a wall-clock limit (`timeouts.*`, `checks.*.timeoutMs`). An agent session is sent `SIGTERM` and then `SIGKILL`, and its partial output is kept; a mechanical command is killed and reported as `command timed out after Ns (watchdog)`. A watchdog bounds a hang; the attempt limit and the spend cap bound the work.

## Agent Notes stay out of the plugin

The harness records its design decisions as Agent Notes under its own `.agents/notes/`. The prompts tell the agent to read them as evidence and never to write such files into the plugin. The rule is also structural: `.agents/notes/`, `.dsh-migrate/`, `.secrets.local.json` and `node_modules/`, which the checks install, are the ignored paths (`src/git/worktree.ts`), excluded through `.git/info/exclude`, from the changed-tree check, from the staged set, and from the proposal diff. Only `.agents/notes/` is ignored, because a plugin may ship its own `.agents/skills/`.

## The agent runtime

The agent sessions run in the agent runtime: a dsh installation and the `migrate` profile, separate from the releases the checks install. It is pinned in `container/agent-runtime/package.json` with a committed lockfile and installed with `npm ci`, so no transitive release changes it. The runtime and the target release are independent: the runtime is upgraded deliberately, after its self-test passes, and a migration to any target release uses the same runtime.

The self-test (`dsh-migrate self-test`, `src/agents/self-test.ts`) starts one session without an API key and passes when it stops at the credential check. The image build runs it, and every run calls it before the first agent session; a failure is reported as status `error`, so a broken runtime is never recorded as a failed migration. The sessions run with `DSH_PERMISSION_MODE=danger-full-access` because the job container is the isolation boundary and a headless session has nobody to answer an approval prompt.
