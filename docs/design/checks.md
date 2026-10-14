---
kind: design
description: The five checks a migration runs, the change-card ledger, the agent runtime the sessions run in, and the end-to-end suite and its baseline.
---

# Checks and the agent runtime

A check looks at the plugin working tree under one release and produces a check result: `pass`, `fail` or `skipped`, a failure fingerprint, and the output. The [workflow design](workflow.md) decides which checks run when; this document explains each check, the end-to-end suite the agent maintains, and the dsh installation the agent sessions run in.

## Principles

1. **Let the agent explore; classify nothing in advance.** A runtime failure shows up in open-ended ways: service collisions, duplicate slot registrations, renamed services, patch targets that disappeared. A fixed failure taxonomy would be wrong often, and a wrong label would enter every later repair prompt as a fact. The checks report what happened; the repair session interprets it.
2. **Decide from evidence.** The repair loop continues while the failure fingerprint changes and stops on a repeated fingerprint, an upstream blocker with all evidence fields, the attempt limit, or the spend cap. It never stops on a guess about the cause.
3. **Cheap checks first.** A pass stops at its first failure, and the repair session receives the output of that check only.
4. **The repair session cannot edit the tests.** The end-to-end suite lives outside the plugin tree, on its own branch, so a repair cannot make the suite pass by weakening it.

## The five checks

| Check | What it runs | Needs an API key | What it catches |
|---|---|---|---|
| `cards` | After the reviews: the card ledger the sessions keep against the upgrade skill's change cards between the source and the target release; skipped without a source release, without the skill, or when no card lies in the span | no | A breaking change the plugin still carries, which a plugin without tests of its own shows nowhere else |
| `mechanical` | In each plugin's directory: the dependency contract with its manifest and its sources, the plugin-shape scan, then `npm install`, the `@deepseek-ai/dsh-*` dependencies pinned to the release, and the plugin's `build`, `typecheck` and `test` scripts; `tests.commands` replaces the scripts | no | A dependency the release no longer publishes or a range that does not admit it; type, build and unit-test failures |
| `boot` | Installs every plugin of the tree into one temporary profile and starts dsh | no | A plugin that fails to load or that dsh skips, throws in `apply`, waits forever for a service, or hangs the host |
| `web` | Serves a temporary web profile with every plugin mounted and waits for the ready line; skipped when no plugin declares `dsh.client` | no | A web client that never attaches, or a plugin dsh left out of the served profile |
| `e2e` | The suite from the suite branch, against a web profile of the release serving every plugin; a test of the end-to-end baseline that no longer passes fails the check; skipped while no suite exists | no | A feature a user reached before the migration and can no longer reach, layout and console errors |

A plugin is a directory whose `package.json` declares `dsh.bundle` (`src/plugins.ts`). A repository is one plugin at its root, or several below it, for example a host, a web and a tools plugin shipped together; then the mechanical check runs in each plugin's directory and reports every failing plugin by name, and the boot and web checks load all of them into one profile, as a user who installs them together does. One migration and one proposal cover every plugin, and the source release is the earliest release every plugin's ranges admit.

The dependency contract (`src/mechanical/dependencies.ts`) runs first, because pinning the dependencies to the release hides what a user installing the plugin would meet. Every `@deepseek-ai/dsh-*` package is published with the release's version and a removed one stops at its last release, so each package the plugin names must be published at the release, under a range that admits it by npm's rules, which compare a prerelease only within the same `major.minor.patch`. An optional peer the release no longer publishes is the exception: npm installs it only for whoever needs it, so it harms nothing and is not pinned; its range must still admit the release, because dsh refuses a plugin whose peer ranges do not. The contract also covers what the plugin's sources refer to: its tracked sources, build output aside, are parsed with TypeScript, JSDoc included, and an import, re-export, `require`, `import()` or `import('…')` type that names a dsh package the release does not publish fails the check with its file and line. A review can mark a change done while one reference remains, which a plugin without a typecheck shows nowhere else. The published versions are read from the npm registry; when it cannot be read, the contract decides nothing and the install that follows fails instead.

A plugin that declares no build, typecheck or test command produces a skipped mechanical check, not a passing one. Each release a check needs is installed once into its own cached prefix (`src/verify/dsh-install.ts`), with `npm install --before` set before the next prerelease of its own line, so it gets the dependencies it was published with: until 0.1.7-alpha.2 a release's packages declare `^` ranges on each other, which npm satisfies with a later prerelease of the same `major.minor.patch`, and a fresh install of an older release otherwise resolves today's Cordis and fails to boot whatever the plugin does. The cutoff sits two hours before that next prerelease, because a release's packages appear over more than an hour around dsh's own (one of 0.2.0-rc.2's came 80 minutes after it, some of 0.1.2-alpha.3's before it); a release with no later prerelease of its line has none. The mechanical check pins the plugin's dsh packages with the same `--before`: a prerelease's packages declare `^` ranges on each other until 0.1.7-alpha.2, so without it they resolve their peers to a later prerelease of the line and the install fails on a peer conflict. An installation that fails is an error of the Action, not a failed check. A plugin with a browser half (`dsh.client`) may need services only the web composition provides, so the boot check loads the plugins without one and the web check loads every plugin in the web composition; when every plugin has a browser half, the boot check is skipped and says so. The web check serves its profile by name (`dsh --profile <name>`): `dsh web` is `dsh --profile web`, a profile of its own, which would serve a fresh default composition without the plugins. It passes `--no-open` only to a release whose `dsh web --help` lists it. dsh from 0.2 skips a bundle it refuses (a peer range that does not admit the release, a malformed patch) with `skipping profile bundle`, and still boots or serves; both checks fail on that line, before reading anything else.

### The change-card ledger

The upgrade skill keeps one file per release (`references/v<version>.md`) listing, card by card, the changes that release made a plugin face, each with a type, an action level (`required`, `required-if-hit`, `conditional`, `optional`, `informational`) and a migration recipe (`src/skills/cards.ts`). A migration crosses every card of the releases after its source up to its target. The extension-point review and every repair attempt are given those cards and keep a ledger of them in the run directory, outside the plugin tree: for each card, whether it applies to the plugin, whether the migration must act on it, its status, and the files that show it was done. A card that applies is required by its level, and an `optional` capability card is required too when the plugin carries a patch, shim or private call that the capability replaces, because a migration retires a workaround once the release offers the public way.

The cards check fails while a card is missing from the ledger, a required card is not done, or the evidence of a done card names a file that is not in the tree; its output gives each such card's recipe to the repair. The check verifies the ledger against the cards and the tree, not the change itself: the sessions judge whether a card applies, and the other checks judge whether the plugin works. It does not run on the unmodified tree, which has no ledger, so a plugin whose initial checks pass still concludes without a session.

### Why the boot check needs no key

dsh's boot path ends by asserting that every entry activated, so it reports an import failure, an `apply` that threw, or an entry pending on a service nobody provides, and exits non-zero. The boot check gives dsh a placeholder key and points the model route at a closed port: reaching the credential or connection error proves the plugin tree assembled and activated, and the check costs nothing. dsh has no hang protection, so the check carries its own watchdog.

## The end-to-end suite and its baseline

The suite (`src/e2e/suite.ts`) is a self-contained Playwright project: its own `package.json` pinning `@playwright/test` to the image's Playwright, a configuration using Chromium, the specs, and an `index.json` with one row per user-visible feature. It never starts dsh. The Action serves the plugin tree in a web profile of a release and hands the suite the launch URL in `DSH_MIGRATE_WEB_URL`, so the same tests run against any release.

| Decision | Value | Reason |
|---|---|---|
| Location | `checks.e2e.dir` on `checks.e2e.branch` (default `dsh-migrate/e2e`), a branch that holds the suite and nothing else | Never part of a proposal's diff, so a proposal stays reviewable, two migrations never conflict over the suite, and a repair session never sees it |
| Baseline | Before the migration changes anything, the suite runs against the unmodified tree on the source release; the tests that pass are the end-to-end baseline. When the branch has no suite yet, an agent session writes it first, against that same served tree | A test written against the source release and passing there describes what the plugin did, not what the migration made of it |
| Check | After every review and repair, the suite runs on the target release. A baseline test that no longer passes fails the check, with its id in the failure fingerprint and Playwright's first error in the output; a test outside the baseline cannot fail it | A failure names a feature a user reached before the migration and cannot reach now, or a step of the host's own UI the test walks through that the release changed |
| Publishing | After the migration concludes, the suite is committed as `dir/` on the branch and pushed. Without a baseline (no source release, or the source release does not serve the plugins), a session first writes or extends the suite against the migrated tree on the target release | The next migration starts from the suite this one checked, and writing a suite never delays a proposal |
| Index | `index.json` lists each feature, how a user reaches it, what is asserted, and the spec; `INDEX.md` renders it with the release it was last checked on | The index is the coverage record a maintainer reads |

A test reaches a plugin's feature through the host's UI (a settings dialog, a plugin list), and a release that reworks that UI breaks the test while the plugin works; no change to the plugin fixes that, and in the benchmark it was most end-to-end failures. So every test is written as top-level `test.step`s titled `reach: …`, the way through the host's UI, and `check: …`, assertions on what the plugin renders and does, with the page-error tripwires in a last check step; the failing step places the failure (`src/e2e/suite.ts`). Under the default `advisory` policy a failure in a check step is the plugin's and is repaired like any failing check, and reported when the repairs do not fix it, because a test can misplace the host's UI in a check step and an advisory check never stops a migration; a failure in a reach step, or one outside any step (a suite written before the steps), is reported, never worked on: it starts no review and no repair attempt, the proposal carries a warning, and the pull request shows the failing tests, where each failed, and their errors. Under `blocking` every failure is repaired, and one the repairs do not fix fails the migration. The authoring session is told that everything the host renders (navigation, dialogs, settings pages, the plugin list, boot data) belongs to reach steps, and to keep them as short as the feature allows.

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
