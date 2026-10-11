---
kind: design
description: The four checks a migration runs, the agent runtime the sessions run in, and the end-to-end suite branch.
---

# Checks and the agent runtime

A check looks at the plugin working tree under one release and produces a check result: `pass`, `fail` or `skipped`, a failure fingerprint, and the output. The [workflow design](workflow.md) decides which checks run when; this document explains each check, the end-to-end suite the agent maintains, and the dsh installation the agent sessions run in.

## Principles

1. **Let the agent explore; classify nothing in advance.** A runtime failure shows up in open-ended ways: service collisions, duplicate slot registrations, renamed services, patch targets that disappeared. A fixed failure taxonomy would be wrong often, and a wrong label would enter every later repair prompt as a fact. The checks report what happened; the repair session interprets it.
2. **Decide from evidence.** The repair loop continues while the failure fingerprint changes and stops on a repeated fingerprint, an upstream blocker with all evidence fields, the attempt limit, or the spend cap. It never stops on a guess about the cause.
3. **Cheap checks first.** A pass stops at its first failure, and the repair session receives the output of that check only.
4. **The repair session cannot edit the tests.** The end-to-end suite lives on its own branch, so a repair cannot make the suite pass by weakening it.

## The four checks

| Check | What it runs | Needs an API key | What it catches |
|---|---|---|---|
| `mechanical` | The dependency contract, the plugin-shape scan, then `npm install`, the `@deepseek-ai/dsh-*` dependencies pinned to the release, and the plugin's `build`, `typecheck` and `test` scripts; `tests.commands` replaces the scripts | no | A dependency the release no longer publishes or a range that does not admit it; type, build and unit-test failures |
| `boot` | Installs the tree into a temporary profile and starts dsh | no | A plugin that fails to load, throws in `apply`, waits forever for a service, or hangs the host |
| `web` | Starts `dsh web` headless with the plugin mounted and waits for the ready line; skipped when the plugin declares no `dsh.client` | no | A web client that never attaches |
| `e2e` | The agent-authored suite from the suite branch, overlaid on the tree; `subset` runs the previously failing tests and the smoke tests, `full` runs everything; skipped while no suite exists | no | Runtime behaviour, layout and console errors |

The dependency contract (`src/mechanical/dependencies.ts`) runs first, because pinning the dependencies to the release hides what a user installing the plugin would meet. Every `@deepseek-ai/dsh-*` package is published with the release's version and a removed one stops at its last release, so each package the plugin names must be published at the release, under a range that admits it by npm's rules, which compare a prerelease only within the same `major.minor.patch`. The published versions are read from the npm registry; when it cannot be read, the contract decides nothing and the install that follows fails instead.

A plugin that declares no build, typecheck or test command produces a skipped mechanical check, not a passing one. Each release a check needs is installed once into its own cached prefix (`src/verify/dsh-install.ts`); an installation that fails is an error of the Action, not a failed check.

### Why the boot check needs no key

dsh's boot path ends by asserting that every entry activated, so it reports an import failure, an `apply` that threw, or an entry pending on a service nobody provides, and exits non-zero. The boot check gives dsh a placeholder key and points the model route at a closed port: reaching the credential or connection error proves the plugin tree assembled and activated, and the check costs nothing. dsh has no hang protection, so the check carries its own watchdog.

## The end-to-end suite branch

The suite is a durable asset; a proposal is a reviewed change. They are kept apart:

| Decision | Value | Reason |
|---|---|---|
| Branch | `checks.e2e.branch`, default `dsh-migrate/e2e` | Never part of a proposal's diff, so a proposal stays reviewable and two migrations never conflict over the suite |
| Base | Rebased onto the consumer's default branch (`checks.e2e.baseRef`) when `checks.e2e.forceRebase` is on | The tests describe the code they run against |
| Discovery | An existing Playwright, Cypress or Vitest configuration, a `test:e2e` script, or an `e2e/` directory is extended; otherwise a suite is created under `checks.e2e.dir` | A plugin keeps one end-to-end stack |
| Index | `index.json` lists every user-visible feature, how it is reached, what is asserted, the spec, and the release it last passed on; `files` lists what belongs to the suite | The index is the coverage record, and `files` lets a later run restore suite files after overlaying the plugin tree |

The suite is authored after the migration, so its first result is weak evidence: the agent wrote the tests it then passes. The default failure policy is therefore `advisory`, which reports a failure in the proposal; `blocking` makes it fail the migration once a suite with a passing history exists.

### Assertions

| Layer | Approach | Needs a baseline |
|---|---|---|
| Structure | ARIA roles and accessible names, text content, geometry invariants (content clipped by its box, elements outside their parent's clip, occluded or collapsed elements), console and `pageerror` tripwires | no |
| Timing | Drive to a state, then poll until two consecutive reads agree; never wait for network idle, which an open event stream never reaches | no |
| Visual | `toHaveScreenshot()` with baselines on the suite branch | yes |

The suite uses Playwright with Chromium, as dsh tests its own web client, but asserts on roles and labels rather than dsh's internal `data-*` attributes, which change between releases.

## Watchdogs

dsh has no hang protection, so every process the Action starts has a wall-clock limit (`timeouts.*`, `checks.*.timeoutMs`). An agent session is sent `SIGTERM` and then `SIGKILL`, and its partial output is kept; a mechanical command is killed and reported as `command timed out after Ns (watchdog)`. A watchdog bounds a hang; the attempt limit and the spend cap bound the work.

## Agent Notes stay out of the plugin

The harness records its design decisions as Agent Notes under its own `.agents/notes/`. The prompts tell the agent to read them as evidence and never to write such files into the plugin. The rule is also structural: `.agents/notes/`, `.dsh-migrate/`, `.secrets.local.json` and `node_modules/`, which the checks install, are the ignored paths (`src/git/worktree.ts`), excluded through `.git/info/exclude`, from the changed-tree check, from the staged set, and from the proposal diff. Only `.agents/notes/` is ignored, because a plugin may ship its own `.agents/skills/`.

## The agent runtime

The agent sessions run in the agent runtime: a dsh installation and the `migrate` profile, separate from the releases the checks install. It is pinned in `container/agent-runtime/package.json` with a committed lockfile and installed with `npm ci`, so no transitive release changes it. The runtime and the target release are independent: the runtime is upgraded deliberately, after its self-test passes, and a migration to any target release uses the same runtime.

The self-test (`dsh-migrate self-test`, `src/agents/self-test.ts`) starts one session without an API key and passes when it stops at the credential check. The image build runs it, and every run calls it before the first agent session; a failure is reported as status `error`, so a broken runtime is never recorded as a failed migration. The sessions run with `DSH_PERMISSION_MODE=danger-full-access` because the job container is the isolation boundary and a headless session has nobody to answer an approval prompt.
