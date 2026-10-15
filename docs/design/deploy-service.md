---
kind: design
description: The deploy service a consumer runs for the run log stream and preview deployments, the HTTP contract between it and the Action, its reference implementation, and the conformance suite.
---

# The deploy service

A deploy service is an HTTP service the consumer runs. It serves two things to the person whose plugin is being migrated: the run log stream, a read-only record of a run while it happens and after it ends, and a preview deployment, a running dsh instance with the migrated plugin loaded so it can be tried before the pull request is merged. Neither can write to the pull request. This repository ships the Action's client half of the contract, a reference implementation in `deploy-service/`, and a conformance suite that checks any implementation against the client. How to run the reference implementation is in [the operations guide](../operations/deploy-service.md).

## 1. Why it exists

A migration already boots the migrated tree headlessly and knows whether it loads. Without a deploy service, everything it learns while doing so is thrown away: the job log belongs to the runner, the reports live in an artifact, and the only durable output is a pull request. To judge whether the plugin still works, a person pulls the branch, installs it and starts a harness themselves. The deploy service does that for them.

| What it serves | Question it answers | Lifetime |
|---|---|---|
| **Run log stream** | What is the run doing right now, and what did it do when it failed? | One run; the record is kept after the run ends |
| **Preview deployment** | Does the migrated plugin work when I use it? | One pull request; alive while the pull request is open, up to its expiry |

## 2. Where a migration session runs

A migration session runs on the GitHub runner, inside the Action's container, headless. That is the only place one runs. A second path, running the session on the deploy service as a dsh web session so a person can watch dsh's own panel and interact with it, is not built ([§11](#11-what-is-deliberately-not-built)): it moves the API key and the compute onto the consumer's machine, and it is a different product rather than a larger version of this one. The run log stream is designed so that such a path could reuse it unchanged.

## 3. The run log stream

A run sends what it logs to the deploy service, which serves it as a read-only page. The stream carries the lines the run logs: stage lines, the progress summary each session reports, and the warnings that would otherwise only reach the job log. The service keeps the record after the run ends. The review and repair reports are not streamed: they reach a person through the artifact and the issue, and repeating them would send the same text twice.

Rules:

- **Push, never pull.** The runner never accepts an inbound connection; it reaches the service outbound over HTTPS, which is also why the service can sit behind a tunnel with no open port.
- **Best effort, never fatal.** A service that is missing, unreachable, or refusing is a logged skip. A migration does not fail because the stream did not answer.
- **The stream is read-only.** There is no command channel from the page into a run. A run is unattended, and a reader may only watch it and read its record afterwards.
- **The URL goes where a person already is.** It is the `log_stream_url` output, and it appears in the step summary of every run that renders one. Not by email: an address would have to be sourced, a delivery failure handled, and the notification would duplicate what GitHub already sends.

## 4. The preview deployment

When a pull request is opened, the deploy service builds an instance from its head, installs the plugin into it, and serves it. The reference implementation previews a repository whose plugin is at its root; for a repository of several plugins its build fails with that reason. **Creation is the service's job**: it receives the repository's `pull_request` webhook events and builds from them. The Action calls the preview API only for the verbs a person types, and never creates an instance itself. Every push to the pull request rebuilds the instance from the pushed commit, so what a person sees always corresponds to a commit that exists.

A preview runs the pull request's code on the consumer's machine, so it is built only for a pull request whose branch is in the repository itself: that code was pushed by someone with write access to the repository. A pull request from a fork, or from a fork that was deleted, gets no preview; the service logs the reason, and `status` reports the state `none` with it.

### 4.1 The working copy

An instance holds two trees:

| Tree | Who may change it | What it is for |
|---|---|---|
| **The working copy** | The preview's own agent, and the person through it | Iterating: edit, reinstall the plugin into the instance's own home, reload, try again |
| **The pull request branch** | Only this Action | Publishing a change, after the checks |

A person iterates in the working copy for as long as they like, with no check in the way, because nothing they do there leaves the machine. When they are satisfied, `publish` freezes the working copy's change and hands it to the Action, which runs the same checks every other change goes through. There is no second path to the branch, so iterating cannot bypass the checks.

The working copy survives an idle stop, a cold start and a rebuild, because losing an hour of iteration to an eviction would make the preview not worth using. A rebuild from a new commit carries the working copy's change onto the new head: the person's edits are theirs, not the commit's. Only destroying the preview discards the working copy.

### 4.2 The safe entry

Every instance answers on two entries:

| Entry | Loads |
|---|---|
| `/` | The plugin under migration |
| `/safe` | No third-party plugin: the same harness, the same configuration and the same home, without the plugin |

The safe entry exists because the failure a preview is most likely to show is a plugin that stops the harness from loading, and a person locked out of the only entry cannot even see why. A new build is promoted only after the boot check passes: the same keyless check the Action runs, with a placeholder key and the model route pointed at a closed port, so it runs on the deploy service before any traffic moves. When it fails, the previous good build keeps serving, and the preview's state says the build failed and why.

### 4.3 Lifetime

| Event | Effect |
|---|---|
| Pull request opened or reopened | Create, and build the head |
| Push to the pull request | Rebuild from the new head |
| No request for `idleMinutes`, and no open WebSocket | Stop the instance; keep the record, the working copy and the home. The next visit starts it again |
| Reaches its expiry | Destroy |
| Pull request closed or merged | Destroy. A later push does not bring the preview back; reopening the pull request does |
| `destroy` command | Destroy |
| `extend` command | Move the expiry out by `deploy.preview.extendDays`, never further than `deploy.preview.ttlDays` after the preview was created. The Action refuses a configuration that asks for more than the ceiling before sending it; the deploy service enforces both numbers, and what it grants is its answer |

The idle stop decides what a preview costs: an instance nobody uses costs nothing to keep defined and everything to keep running.

### 4.4 What a preview may not do

- It cannot write to the pull request branch, and it holds no credential that could.
- It cannot reach the deploy service's own control surface: no container runtime socket, and no write access to the service's data outside its own directories. The git directory of its working copy is one of those: it lives outside everything mounted into the instance, because git configuration is code git runs.
- It has no network. It cannot reach the deploy service, another preview, or the cloud metadata endpoint; the service reaches it over Unix sockets. Only the dependency install has a network, in a container that is removed when it ends.
- It does not hold the consumer's primary API key.
- It runs under limits on CPU, memory and processes.

## 5. Access control

A URL is not a secret. A pull request comment on a public repository is public, so a preview URL in one is public too, and an unguessable path only delays discovery. Who may open a page is therefore decided by an identity check in front of the service, not by the obscurity of the address.

The supported shape is Cloudflare Zero Trust: a tunnel from the service outwards, so the machine has no inbound port, and a Cloudflare Access application per entry with a policy naming who may reach it and for how long. The URL in a comment then points at something that authenticates, and its being visible costs nothing.

Rules that hold whatever fronts the service:

- **The API needs the deploy token; the webhook needs its signature.** The Action's calls carry the bearer token, GitHub's deliveries carry an HMAC signature over the body, and neither is ever exempt.
- **No credential in any URL.** Not the API key, not the deploy token, not a signed query parameter that grants access on its own. The Action enforces its half: a page URL the service names is linked only when it parses as `http(s)`, carries no credentials, fits the 300 characters a rendered URL is given, and cannot escape the link it is put in. A URL that fails is dropped, so the run is left without a page rather than republishing a secret or linking somewhere nobody named. Cutting one to fit is a failure too, because what a reader would click would be a different URL.
- **The API key never reaches the browser.** Neither does `dsh web`'s own launch token: the service's proxy exchanges it for a session itself.
- **No credential reaches an instance.** The proxy removes the bearer token, every cookie, and the `cf-access-*` identity headers before a request reaches a preview.
- **The policy is the consumer's.** The deploy service belongs to the consumer, so the identities allowed to reach a preview are theirs to decide; this Action neither hosts the service nor knows the policy.
- **Every entry is behind the same boundary.** The preview, the safe entry and the run log stream page are separate applications with separate policies, because watching a run and using a plugin are different privileges.

Every preview deployment and every run log stream page share one origin, the service's. A preview's client code runs on that origin, so in a person's browser it can send requests, with that person's Access session, to any other preview and to any run page, read the answers, and operate another preview's `dsh web` as that person. The Access policies decide who reaches the paths; they do not separate one preview from another inside one browser. The service does not give previews hosts of their own. What bounds the consequence is the rule in [§4](#4-the-preview-deployment): a preview runs only code from a branch of the repository itself, so whoever could use this already has write access to the repository. A deployment that serves repositories with different sets of writers runs one deploy service per set.

## 6. Commands

The deploy service and the pull request share one command interface: a fixed set of verbs, one permission check, and one reply per comment. The [command reference](../reference/commands.md) owns the verb table.

## 7. Check policy

The checks are not reimplemented for the preview; they cannot be avoided, because the preview cannot write.

| Action | Who runs it | Consequence |
|---|---|---|
| Iterating in the working copy | The preview's agent | Nothing is published; no check applies |
| `publish` | This Action | The frozen change is checked by the same checks as any other change, in the order a migration runs them: mechanical, boot, web, and the end-to-end suite, which refuses only under `checks.e2e.failurePolicy: blocking`. A refusal means no push, and the reason is reported where the person is looking |
| A new commit on the branch | The same pipeline | Same checks; a preview rebuild follows only from a commit that exists |
| A pre-check in the preview | The preview's agent | **Advice only.** It runs the cheap checks locally so a person learns early that a change will likely be refused. It is never the authority, and it is labelled as advice wherever it is shown |

What "passes" means is owned by the pipeline ([the checks design](checks.md#the-five-checks)): mechanical and boot must pass, the web check must pass when the plugin declares a client surface, and the end-to-end suite refuses only under the `blocking` policy; the cards check holds a migration to its ledger and is not run on a handed-back tree, which has none. A publish runs that same stack (`checkTree` in `src/activities/check-tree.ts`), and a tree on which every check was skipped is refused, because nothing verified it.

## 8. The HTTP contract

A deploy service serves the calls below. Every call carries `Authorization: Bearer <token>`, where the token is the value of the secret named by `deploy.tokenEnv`, plus `Accept: application/json` and a `User-Agent`. Every mutating call that is a *request* also carries `Idempotency-Key`, a stable string for the comment that caused it, so the same key twice is one instruction and not two; the `publish-result` report carries none, because repeating a report is harmless. `{repository}` is `owner/name` and `{runId}` is an opaque id, both URL-encoded.

The Action gives an event ten seconds, the `publish-result` report five, and any other call twenty. It reads at most 2 MiB of an answer (8 MiB of a frozen diff), refuses an answer that ran past that or stopped early, and refuses a redirect rather than following it. Every non-2xx answer, timeout, or transport failure is treated the same way: a logged skip that a migration survives. A verb a person asked for reports its refusal on the thread, and a `publish` that cannot continue stops rather than pretending. One refusal ends the event stream, because a service that has refused once keeps refusing and each further event would spend its timeout before the run could finish.

| Call | Body | Answer |
|---|---|---|
| `POST /runs` | `{ runId, repository, kind }` | `{ url }`, the page a person watches |
| `POST /runs/{runId}/events` | `{ seq, at, message }`, one logged line | any 2xx |
| `POST /runs/{runId}/finish` | `{ events, attempted, complete }`: how many events were accepted, how many were produced, and whether the record is whole | any 2xx |
| `POST /previews/{repository}/{pullRequest}` | `{ action, days?, maxTtlDays? }`; `extend` carries both numbers and `publish` carries none. A `redeploy` may carry a `headSha`, which a service ignores, because it resolves the head itself | any 2xx; a `publish` answers `{ revision, headSha }` |
| `GET /previews/{repository}/{pullRequest}/scratch?revision={revision}` | none | the frozen diff: either `{ diff }` as JSON or the patch itself as the body, as in [§8.1](#81-preview-publish) |
| `DELETE /previews/{repository}/{pullRequest}` | none | any 2xx |
| `GET /previews/{repository}/{pullRequest}` | none | the preview's state; `status` reports `state`, `url`, `safeUrl`, `headSha`, `expiresAt` and `detail` (a sentence on the state, such as why the last build failed or why there is no preview) when they are present. Unknown fields are ignored and missing ones are not reported, so a service may answer with as little as a `state` |
| `POST /previews/{repository}/{pullRequest}/publish-result` | `{ revision, outcome, branch, commit?, alreadyPublished?, stage?, detail?, tag?, checks? }`: how a publish ended. `tag` is the release the checks ran against, when one was resolved, and `checks` is one `{ check, outcome }` per check that ran (`mechanical`, `boot`, `web`, `e2e`). `stage` names what refused it: `remote` (the branch could not be read, the checkout is not the repository, or its push would not reach the remote it fetched from), `base` (the branch moved past the frozen revision), `apply` (the revision could not be used or the diff did not apply), `checks`, `push`, or `error` (the publish stopped) | any 2xx; a service that does not implement it is a logged skip |

What a deploy service owes beyond the shape of these calls:

- It resolves the pull request's current head itself on a redeploy: a command handler has no checkout of the branch, and a commit guessed from the runner would be the wrong one to rebuild from.
- It answers an `Idempotency-Key` it has already served with the answer it gave then, and says so with `Idempotency-Replayed: true`, compared without regard to case, so the Action reports a repeat as already done instead of implying a second rebuild. This holds when the Action's own record could not be written: the Action suppresses a repeated comment only while it can read the state branch it remembers in, and a crash or a refused push leaves a window in which the same key arrives twice.
- It never treats a repeated key as a conflict: the answer to a replayed publish is the same frozen revision, because the runner may be retrying a delivery whose reply it never saw.
- It runs the boot check before promoting a build, and keeps the previous good build serving when the check fails.
- It never returns its own control surface to an instance, and never lets an instance reach the runtime socket of its machine.

### 8.1 Preview publish

`publish` is the one verb whose work does not finish at the deploy service, because the service has no write access to the pull request branch and never will. It asks for the change to be published; the Action is what publishes it. A preview publish is four steps, and the deploy service implements the first two.

1. **The service freezes the working copy and names the revision.** `POST /previews/{repository}/{pullRequest}` with `{ action: 'publish' }` answers `200 { revision, headSha }`. Only `revision` is required for the publish to continue: `revision` is an opaque id for the change exactly as it was at that moment, and `headSha`, the pull request head when the publish was accepted, is used to check that the branch has not moved, and must be a full 40-character lowercase commit hash, which the Action refuses otherwise; a service that omits it is taken to mean the pull request's current head. Freezing is what makes a publish one reviewable change: iteration may continue on top of it, and the frozen revision stays fetchable and unchanged whatever the person does next. A service that cannot freeze answers non-2xx, and the Action reports that nothing was published.
2. **The service serves that revision as a diff.** `GET /previews/{repository}/{pullRequest}/scratch?revision={revision}` answers the frozen change as a unified diff that `git apply` accepts. Served as the body, the patch is applied byte for byte; as `{ diff }` JSON it is a string, which cannot carry a change to a text file that is not UTF-8, so such a change needs the body form. A binary file is encoded as text by `git diff --binary` either way. A revision that is unknown or has been pruned is a non-2xx, never an empty diff, because "no changes" and "the changes are gone" must not look the same to the runner.
3. **The Action applies the diff and runs the checks.** It adds a worktree of the pull request branch at `headSha`, applies the diff there, and runs the same checks every other change goes through ([§7](#7-check-policy)). Two things stop it before the checks are spent: a revision already on the branch, which is a retry rather than a new publish, and a branch that has moved past `headSha`. A diff that no longer applies to `headSha` is reported as such, and so are the two cases where the base is the problem rather than the patch: a branch that moved, and a working copy built from an older base than the frozen head, whose change conflicts with it. In both, the remedy is a working copy built on the current head, instead of the Action forcing a merge nobody asked for: the deploy service rebuilds when the pull request's head moves or on `redeploy`, and the next publish freezes a new revision whose `headSha` is the current head.
4. **Only a passing run pushes.** A refusal means nothing reaches the branch, and the reason is reported on the thread: which stage refused, and the outcome of each check. A successful run reports the commit that carries the change: this delivery's push or, when the revision was already on the branch, the commit an earlier delivery pushed, marked as such.

**The checks run the preview's code with the runner's credentials, between the last check and the push.** Applying a diff and then running the plugin's own `npm install` and test commands executes code that came from the working copy, in a job that holds `GITHUB_TOKEN` with `contents: write` and the deploy token. Running the checks before anything reaches the branch requires this. The checks get an environment without the Action's secrets, which keeps them out of what a check prints but is no sandbox: [what the code a check runs can read](checks.md#what-the-code-a-check-runs-can-read). It is also why the checks must be the whole stack: a publish that skipped one is a change pushed on a partial answer. What the Action does about the boundary is small: the commit is taken before the checks run, the push names that commit, and the URL the push would use, read with `git remote get-url --push` in the worktree the push runs from (so a `pushurl`, a `pushInsteadOf`, and a worktree-local configuration all count), is compared with what it was before them. A push URL that does not reach the remote the checkout fetched from is refused before the checks are spent, because a publish that reports a commit as landed while it went to a mirror is worse than a refusal. This catches a check that retargeted the checkout; it is a comparison of configuration, not a sandbox, because the worktree shares the checkout's git configuration and a check can still reach the same remote another way.

The outcome goes back to the deploy service as `POST …/publish-result`: `published` with the commit that carries the change, plus `alreadyPublished: true` when this delivery pushed nothing, or `refused` with the stage that refused it and the outcome of each check, so a preview can show why a change did not reach the branch. Every refusal after the freeze is reported, because the service is then holding a revision; a refusal before it is not, because there is no revision to report. It is a report rather than a request, so it carries no `Idempotency-Key`, and a service that does not serve it is a line in the log: the thread already has the answer. The Action never reports that a request was accepted before the checks ran, because "accepted" is not an outcome a publish has.

A publish runs the checks and stops there. It has no repair loop and no review, because there is nothing to repair: the diff came from a tree a person has been iterating in, and a refusal means they iterate again and publish again.

As a result, the pull request branch has exactly one writer, that writer holds the credentials, and the machine running the code a person is trying has none. In exchange, publishing is a request rather than an operation: the service keeps a revision frozen until the runner has fetched it, and the person's next edit does not silently become part of the change under review. `applyHandback` in `src/deploy/handback.ts` is the Action's half: it owns the git, takes the checks as a port, refuses rather than pushing when it cannot verify what it applied, and does not apply a revision that is already on the branch, which is what makes a retried publish a no-op.

## 9. The reference implementation

`deploy-service/` is a separate npm package: one Node process, `node:http` and `zod`, no database server. Its state is a data directory (`DATA_DIR`), and its configuration is the environment, validated at start; the variables are listed in [the operations guide](../operations/deploy-service.md#configuration).

| Module | Responsibility |
|---|---|
| `src/server.ts` | Routing and the three access rules: the bearer token for the API, the HMAC signature for `/github/webhook`, and the token or `PUBLIC_VIEWS=true` for the pages (`/view/…`, `/p/…`) |
| `src/runs.ts` | The run store, `runs/<runId>/meta.json` and `events.jsonl`; `finish` seals a record and stores what the Action reported next to what was stored; `/view/<runId>` renders the record as escaped HTML |
| `src/idempotency.ts` | `Idempotency-Key` replay: the first 2xx answer to a key on a method and path is stored in `idempotency/` and answered again with `Idempotency-Replayed: true`. Requests with one key are handled one at a time, so at most one acts, and after a failed answer the next one acts while the rest wait for it. Entries are kept for seven days. GitHub's `X-GitHub-Delivery` id is handled the same way, so a redelivered webhook does not rebuild twice |
| `src/webhook.ts` | Reads a `pull_request` event: `opened`, `synchronize` and `reopened` build, `closed` destroys and is remembered in `pull-requests/<id>.json` until `reopened`, every other action is ignored. A pull request whose branch is not in the repository itself is refused (§4). The commit is fetched by id from the repository's clone URL, which must be `https:`; the `process` provider also accepts a local path or `http:` |
| `src/previews.ts` | The preview manager: one record per pull request in `previews/<id>/preview.json`, the build and promotion sequence below, `extend` with its ceiling, `publish`, the revisions, the idle stop and the expiry |
| `src/working-copy.ts` | Git: checking a commit out by id, freezing the working copy's change, and carrying it onto a new head. Every command names the git directory and the work tree explicitly, so git never finds a repository, or its configuration, inside the tree |
| `src/providers/` | The `InstanceProvider` interface and its two implementations |
| `src/proxy.ts` | `/p/{id}/` and `/p/{id}/safe/` to the instance over its Unix sockets, HTTP and WebSocket; an open WebSocket counts as use |
| `preview-image/` | The preview image, and `launcher.mjs`, which both providers run: `install` the plugin's dependencies, the keyless `check`, `serve` the two `dsh web` processes, and `forward` them to Unix sockets |

A preview's id is a hash of `owner/name#number`, so nothing a repository name contains reaches a path, a container name or a URL. Its directory holds `work/` (the working copy), `git/` (its git directory, mounted nowhere), `home/` (the instance's dsh home, shared by both entries), `state/` (the ports and launch tokens `serve` writes), `sockets/` (written only by `forward`), `revisions/<revision>.diff`, and `unapplied/`.

**Building and promoting.** A build checks the announced head out into a candidate beside the working copy. The provider installs the plugin's dependencies there and runs the boot check with the Action's own classifier (`classifyBoot` from `src/verify/boot.ts`, compiled into the package), so a preview is promoted on exactly the evidence a migration accepts. Without a committed lockfile the install runs `npm install --no-package-lock`, so it writes none, and after a check passes every untracked path the repository does not ignore, such as build output, is added to the git directory's exclude file: a file the install or the build creates is never part of the working copy's change. A tracked file the build rewrites is not excluded, and neither is a file the running instance writes; both count as the person's change. When the check passes, the manager takes the preview's lock and stops the instance, so nothing edits the working copy while its change is read. It freezes that change against the commit the copy was built from and applies it to the candidate with `git apply --3way`, after refreshing the candidate's index, since a build may change its files' owner. When the change applies, the candidate is installed and checked again with the change in it, and only a passing check promotes it: what is promoted is what passed. When it does not apply, the change is kept as `unapplied/<time>.diff` (the last twenty are kept), the state's `detail` says so, and the clean head is promoted. Promotion swaps the working copy and its git directory for the candidate's. A build that fails at any point leaves the working copy and the previous build as they were, with the state `failed` and the reason. The instance restarts either way. A newer build, or a destroy, supersedes a build in progress, which then discards its candidate; a restart removes leftover candidates. Starting an instance, promoting and removing a preview take the same lock, so they never overlap.

**Freezing.** `publish` stages the working copy into a temporary index and takes `git diff --cached --binary` against the commit the copy was built from, so untracked files count, and ignored files (installed dependencies, and the files the build created) do not. The diff is carried as bytes, so a file that is not UTF-8 is frozen, served and carried unchanged. An empty change is refused with 409 rather than frozen, and one larger than the 8 MiB the Action reads with 413. A publish whose change, base commit and pull request head all equal the last revision's answers that revision again; any difference, a moved head included, freezes a new one. The last twenty revisions of a preview are kept; an older one answers 404. The `publish-result` report is stored with its revision in `preview.json`.

**States.** `GET` answers `state`, `url`, `safeUrl` and `headSha` (the commit the promoted working copy was built from), `expiresAt`, and `detail` when the last build failed or set the working copy's change aside under `unapplied/`. `state` is `building` while a build runs; `failed` when the last build failed, whether or not an earlier build still serves; `ready` while the instance runs; `stopped` otherwise. A pull request without a preview answers `{ state: 'none' }` rather than 404, with a `detail` when it has none on purpose (a fork, a closed pull request), so the Action's `status` says there is none and why instead of saying the service could not be asked. After a restart nothing runs: the `docker` provider removes every container with its prefix at start, every instance starts again on its next visit, and a build the restart interrupted is recorded as failed.

**The instance provider.** `build(spec, candidateDir)` installs and checks a candidate and answers `{ ok, detail }`; `start(spec)` starts the instance from the promoted working copy and answers where its two entries are; `stop`, `destroy` and `running` complete it. An instance whose process or container exits (a crash, the memory limit) is stopped, so `running` no longer names it and the next visit starts it again. An install or a boot check that runs past its time or its output bound is killed, and with the `docker` provider its container is removed. An instance is two `dsh web` processes, `preview` with the plugin linked into its profile and `safe` without it, both on the same home. `dsh web` binds only a loopback address and authenticates a browser with a launch token it exchanges for a cookie bound to the `Host` it was served under. `serve` writes each loopback port and launch token to `state/ready.json`; `forward`, a launcher process that runs none of the plugin's code, listens on `sockets/plugin.sock` and `sockets/safe.sock` and forwards each to its port. The service's proxy connects to those sockets and sends every request with the loopback authority as `Host` and its own session cookie. The plugin's code never sees `sockets/`, so it cannot replace a socket with a link to another one.

| Provider | Where an instance runs | Isolation |
|---|---|---|
| `docker` | Containers from `DSH_IMAGE`: the install in a throwaway container on Docker's default bridge, the boot check in one with `--network none`, `serve` in one with `--network none`, and `forward` in a second container that joins its network namespace | No Docker socket, no capabilities, `no-new-privileges`, an unprivileged user, `--cpus 1`, `--memory 2g`, `--pids-limit 512`. `serve` mounts the working copy, the home and `state/`; `forward` mounts `state/` read-only and `sockets/`. The Terraform module also drops every container's traffic to the metadata endpoint, which the install container could otherwise reach |
| `process` | Child processes of the service, on its host, with `DSH_BIN` or `DSH_VERSION` installed into `DATA_DIR` | None: for CI and tests, never for code its operator has not read. The plugin's processes receive only `PATH`, `HOME`, the dsh binary, npm's cache directory and the launcher's variables, never the service's own environment |

**Conformance mode.** Started with `--conformance`, the service honours a test-only request header on any API path, after the token check: `X-Conformance: slow` answers after 25 seconds, past the Action's twenty; `oversize` answers more than 2 MiB; `redirect` answers 302; `seed` on `POST /previews/…` creates a preview whose working copy holds one change, with no GitHub event and no instance, so the preview calls can be exercised by a suite that has no pull request; a redeploy of it fails, because the seed is not a plugin. Without the flag the header is ignored, so nobody holding the token can make a deployment misbehave.

## 10. The conformance suite

`deploy-service/conformance/` checks a deploy service from the Action's side: every call goes through the Action's own client, `src/deploy/client.ts` and `src/deploy/log-stream.ts`, which the package compiles into `dist/action/` (`tsconfig.action.json`) and imports as `#action/*`. A check therefore passes exactly when a consumer's run would accept the answer, and a change to the client changes what the suite demands. It runs against any URL; the command is in [Verifying a deployment](../operations/deploy-service.md#verifying-a-deployment).

| Check | Needs |
|---|---|
| A wrong or missing token is refused with 401 | |
| `POST /runs` answers a `url` the Action will link; events and `finish` are accepted | |
| The Action's own log stream opens, delivers, and seals without a refusal | |
| `GET` a preview answers a `state` | a preview |
| The same `Idempotency-Key` replays the same body with `Idempotency-Replayed: true`, and does not move the expiry again | a preview |
| `publish` freezes a revision, and a replayed `publish` names the same one | a preview with an unpublished change |
| The frozen revision is served as a non-empty diff; an unknown revision is not served | a preview with an unpublished change |
| `publish-result` and `redeploy` are accepted | a preview |
| `destroy` removes the preview | a seeded preview; a named one is left in place |
| The client refuses a slow answer, an oversize answer, and a redirect | `--conformance` |

A preview comes from `--preview owner/name#N`, which must hold an unpublished change, or, with `--conformance`, is seeded through `X-Conformance: seed`. What the suite does to a named preview is in [Verifying a deployment](../operations/deploy-service.md#verifying-a-deployment). A check whose need is missing is reported as skipped with the reason, and only a failed check fails the run. Someone writing their own deploy service runs the suite against it; implementing the `X-Conformance` modes in a test mode of their own lets it run every check.

The reference implementation is held to it three ways: the unit tests in `deploy-service/test/`; the `deploy-service` workflow, which starts the service with `--conformance` inside the job, runs the suite, and then runs `tests/e2e/deploy-service.test.ts`, which drives the real CLI against the service with real `dsh web` previews and no API key; and the manual `deploy-service-cloud-check` workflow, which provisions the Terraform module on a throwaway server, runs the suite against its public HTTPS endpoint, and destroys it.

## 11. What is deliberately not built

- **Running the migration on the deploy service.** [§2](#2-where-a-migration-session-runs) explains why a session runs only on the runner.
- **Email notification.** The pull request is the notification; a second channel would need an address, delivery handling and a privacy story to duplicate it.
- **A command channel into a running migration.** The run log stream is read-only; a run is unattended, and interaction belongs to the preview, which has a different lifetime.
- **A hosted, multi-tenant deploy service.** The service is the consumer's, for the same reason the report channels' destinations are: it holds their code and decides who may reach it.
- **A scale-to-zero machine provider.** A provider that starts a machine per preview (Fly Machines and similar) would remove the idle cost of a server; it is a possible later `InstanceProvider`, and the interface is shaped so that it is additive.
- **In the reference implementation:** a warning before an expiry or a destroy, a model credential injected into previews, an egress allow-list and a disk quota for previews, and credentials for cloning a private repository. A deployment that needs one of these adds it in front of or around the service.
