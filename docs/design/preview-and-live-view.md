# Preview instances and the live view of a run

Reference for the two surfaces this Action can expose to the person whose plugin is being migrated: a read-only view of a run while it happens, and a running dsh instance that has the migrated plugin loaded so it can be tried before the pull request is merged. Both are served by a deploy target the user supplies, behind an identity check, and neither of them can write to the pull request.

## 1. Why these exist

The migrate pipeline already boots the migrated tree headlessly and already knows whether it loads. Everything it learns while doing that is thrown away: the job log belongs to the runner, the reports live in an artifact, and the only durable output is a pull request. The person who has to judge whether the plugin still works therefore pulls the branch, installs it, and starts a harness themselves — which is the slowest possible feedback loop, and the one this document removes.

Two surfaces, one deploy target:

| Surface | Question it answers | Lifecycle |
|---|---|---|
| **Live view** | "What is the run doing right now, and what did it do when it failed?" | One run; the record is retained after the run ends |
| **Preview** | "Does the migrated plugin actually work when I use it?" | One pull request; alive while the request is open |

## 2. Two run paths, one of them shipped

Where a migration session executes is a choice, and the two choices are not variations of each other:

| Path | Session runs on | Status |
|---|---|---|
| `runner` | The GitHub runner, inside this Action's container — headless, as it does today | **Shipped.** The only path that runs a migration |
| `deploy-host` | The user's deploy target, as a dsh web session | **Not implemented.** Declared here so the configuration, the live view, and the preview are built against the right shape |

The `deploy-host` path is what would let a user watch dsh's own panel and interact with the session rather than a transcript. It is deliberately out of scope: it moves the API key and the compute onto the user's machine, and it is a different product surface rather than a bigger version of this one. Everything below works on the `runner` path, and the live view is designed so that a later `deploy-host` path reuses it unchanged.

## 3. The live view

A run streams what it is doing to the deploy target, which serves it as a read-only page. The stream carries what the run logs today — stage lines, the progress summary each session reports, and the warnings that would otherwise only reach the job log — and the deploy target keeps it after the run ends, which is the part that is missing today. The A/B/C reports are not streamed: they are written to disk and reach a human through the artifact and the issue, and repeating them into a viewer would send the same text twice.

Rules:

- **Push, never pull.** The runner never accepts an inbound connection; the target is reached outbound over HTTPS, which is also why the target can sit behind a tunnel with no open ports.
- **Best effort, never fatal.** A deploy target that is missing, unreachable, or rejecting is a logged skip. A migration must not fail because a viewer did not answer, exactly as the feedback channels do not.
- **The view is read-only.** There is no command channel from the viewer into a run. A run is an unattended process, and the only thing a viewer may do is watch it and read its record afterwards.
- **The URL goes where a person already is.** The `live_view_url` output always; the step summary of every run that renders one, and the issue the run opened when it opened one — posted once, after the run, because the target keeps the record and the link stays useful. Posting is best effort: a migration that succeeded is not failed by a comment that did not post. Not by email: an address has to be sourced, a delivery failure has to be handled, and the notification would only duplicate what GitHub already notifies.

## 4. The preview instance

When a migration pull request is opened and the deploy target has previews enabled, the target builds an instance from that pull request's head, installs the plugin into it, and serves it. **The create step is the target's**: this Action calls the preview API for the verbs a user types, and does not create an instance by itself when a pull request appears, so a target that wants one builds it from the pull request event it already receives. The instance is rebuilt from the pushed commit on every update, so what a user sees always corresponds to a commit that exists.

### 4.1 The scratch tree is where iteration happens

The instance holds two trees, and the distinction is the whole design:

| Tree | Who may change it | What it is for |
|---|---|---|
| **Scratch** | The preview's own agent, and the user through it | Iterating: edit, reinstall the plugin into the instance's own home, reload, try again |
| **The pull request branch** | Only this Action's pipeline | Publishing a change, after the gates |

A user iterates in the scratch tree for as long as they like with no gate in the way, because nothing they do there leaves the machine. When they are satisfied, `publish` takes the scratch diff and hands it to the pipeline, which is the same pipeline every other change goes through. There is no second path to the branch, so the gates cannot be bypassed by iterating.

Scratch is **persisted across cold starts and rebuilds**, because losing an hour of iteration to an eviction is the failure mode that would make the whole surface not worth using. Rebuilding from a new commit keeps it — the user's edits are theirs, not the commit's — and only destroying the instance discards it, after a warning.

### 4.2 The safe entry

Every instance answers on two entries:

| Entry | Loads |
|---|---|
| `/` | The plugin under migration |
| `/safe` | No third-party plugin: the same harness, the same configuration, the same home, without the plugin |

The safe entry exists because the failure this surface causes is a plugin that stops the harness from loading, and a user locked out of the only entry cannot even see why. The target may promote a new build only after the same boot probe the pipeline uses passes — the probe is keyless and points the model route at a dead port, so it can run on the target before traffic moves. When it fails, the previous good build keeps serving and the entry says so, with a link to the log; the state is kept as a previous-good directory rather than overwritten in place, so "roll back" has something to roll back to.

### 4.3 Lifetime

| Event | Effect |
|---|---|
| Pull request opened | Create |
| Push to the pull request | Rebuild from the new head |
| No requests for `idleMinutes` | Stop the container, keep the definition and the scratch tree; the next visit cold-starts it |
| Reaches `ttlDays` | Destroy, with a warning first |
| Pull request merged or closed | Destroy |
| `destroy` command | Destroy |
| `extend` command | Push the expiry out by `deploy.preview.extendDays`, with `deploy.preview.ttlDays` as the ceiling — a configuration that asks for more than the ceiling is refused before it is sent; the target is what enforces both numbers, and what it grants is its answer |

Idle stop is the setting that decides what this costs, because an instance nobody is using costs nothing to keep defined and everything to keep running.

### 4.4 What the preview is not allowed to do

- It cannot write to the pull request branch, and it holds no credential that could.
- It cannot reach the deploy target's own control surface: no container runtime socket, no write access to the directory the target's management lives in.
- It does not run with the user's primary API key. The instance's key is scoped and low-quota, or injected by the target so the process never holds the value.
- It is subject to quotas on CPU, memory, disk and time, because "iterate freely" is a promise about freedom inside the instance, not about the instance being unlimited.

## 5. Access control

A URL is not a secret. A pull request comment on a public repository is public, so a preview URL placed in one is public too, and an unguessable path only delays discovery. The access decision therefore belongs to an identity check in front of the target, not to the obscurity of the address.

The supported shape is **Cloudflare Zero Trust**: a tunnel from the target outwards (no inbound port on the machine), one application per entry with a policy naming who may reach it, and a session TTL from the same policy. The URL in a comment is then a pointer to something that authenticates, and its being visible costs nothing.

Rules that hold regardless of the fronting service:

- **No credential in any URL.** Not the API key, not a token, not a signed query parameter that grants access on its own. The Action enforces its half of that: a page URL a target names is linked only when it parses as `http(s)`, carries no credentials, fits the 300 characters a rendered URL is given, and cannot escape the link it is put in — a URL that fails is dropped, so the run is left without a page rather than republishing a secret or linking somewhere nobody named. Cutting one to fit is a failure too, because what a reader would click is then a different URL.
- **The API key never reaches the browser.** It is held by the instance, and the target injects it where possible.
- **The policy is the user's to set.** The deploy target belongs to the user, so the identities allowed to reach a preview are theirs to decide; this Action neither hosts the target nor knows the policy.
- **Every entry is behind the same boundary.** The preview, the safe entry, and the live view of a run are separate applications with separate policies, because watching a run and using a plugin are different privileges.

## 6. Commands

The deploy target and the pull request share one command interface: a fixed set of verbs, one permission check, and one audit line per invocation. It is described in [the migration feedback stage](migration-feedback.md#6-commands), which owns the verb table, because the same interface also carries the feedback channels' manual and dry-run forms.

## 7. Gate policy

The gates are not reimplemented for the preview; they are unavoidable because the preview cannot write.

| Action | Who runs it | Consequence |
|---|---|---|
| Iterating in scratch | The preview's agent | Nothing is published; no gate applies |
| `publish` | This Action's pipeline | The scratch diff is evaluated by the same gates as any other change, in the order the pipeline runs them — mechanical, boot probe, web smoke, end-to-end suite — with only the end-to-end suite advisory unless `e2e.gate` says otherwise. A failure means no push, and the reason is reported where the user is looking |
| A new commit on the branch | The same pipeline | Same gates; a preview rebuild follows only from a commit that exists |
| A pre-check in the preview | The preview's agent | **Advisory only.** It runs the cheap gates locally to tell a user before they spend a migration that a change looks doomed. It is never the authority, and it is labelled as advice wherever it is shown, or the first disagreement between it and the pipeline costs more trust than it saves |

What "passes" means is what it means today and is owned by the pipeline: mechanical and boot must pass, the client-surface web smoke must pass when the plugin declares one, and the end-to-end suite is advisory unless `e2e.gate` says otherwise. A publish runs that same stack — the mechanical suite, the boot probe, the web smoke and the end-to-end suite — and two things about it cannot be silently absent: an invocation that has no way to run a configured `blocking` suite refuses, and a report in which no layer produced a verdict is not a pass. A suite that does not exist yet is a skip rather than a refusal, in a publish and in the pipeline alike, because the first migration of a repository is what authors it.

## 8. The target's API

A user implementing a deploy target has to serve this much. Every call carries `Authorization: Bearer <token>`, where the token is the value of the secret named by `deploy.tokenEnv`, plus `Accept: application/json` and a `User-Agent`; every mutating call that is a *request* also carries `Idempotency-Key`, a stable string for the command that caused it, so the same key twice is one instruction and not two — the `publish-result` report carries none, because repeating a report is harmless; `{repository}` is `owner/name` and `{runId}` is an opaque id, both URL-encoded; the Action gives an event ten seconds and any other call twenty, reads at most 2 MiB of any one answer (8 MiB for a scratch diff, which is legitimately larger), refuses an answer that ran past that or stopped early, and refuses a redirect rather than following it; and every non-2xx answer, timeout, or transport failure is treated the same way — a logged skip that a migration survives. That posture is the run's: a verb a user asked for reports its refusal on the thread, and a `publish` that cannot continue stops rather than pretending. One refusal ends the event stream, because a target that has refused once keeps refusing and each further event would burn its timeout before the run could finish.

| Call | Body | Answer |
|---|---|---|
| `POST /runs` | `{ runId, repository, kind }` | `{ url }`, the page a human watches |
| `POST /runs/{runId}/events` | `{ seq, at, message }`, one logged line | any 2xx |
| `POST /runs/{runId}/finish` | `{ events, attempted, complete }`: how many events were accepted, how many were produced, and whether the record is whole | any 2xx |
| `POST /previews/{repository}/{pullRequest}` | `{ action, days?, maxTtlDays? }` — `extend` carries both numbers, and `publish` carries none | any 2xx; a `publish` also answers `{ revision, baseSha, headSha }` |
| `GET /previews/{repository}/{pullRequest}/scratch?revision={revision}` | — | the frozen scratch diff: either `{ diff }` as JSON or the patch itself as the body, as in [§8.1](#81-the-publish-hand-back) |
| `DELETE /previews/{repository}/{pullRequest}` | — | any 2xx |
| `GET /previews/{repository}/{pullRequest}` | — | the preview's state; `status` reports `state` or `status`, `url`, `safeUrl`, `headSha`, `expiresAt`, `extendedDays` and `revision` when they are present. Unknown fields are ignored and missing ones are simply not reported, so a target may answer with as little as a `state` |
| `POST /previews/{repository}/{pullRequest}/publish-result` | `{ revision, outcome, branch, commit?, alreadyPublished?, stage?, detail?, tag?, gates? }` — `tag` is the harness the gates verified against when one was resolved, and `gates` is one `{ layer, ok, detail? }` per layer that ran (`mechanical`, `boot`, `web`, `e2e`) — how a publish ended, and which stage refused it. `stage` is one of `remote` (the branch could not be read, this checkout is not the repository, or its push would not reach the remote it fetched from), `base` (the branch moved past the frozen revision), `apply` (the revision could not be used or the diff did not apply), `gates`, `push`, or `error` (the hand-back stopped) | any 2xx; a target that does not implement it is a logged skip |

What the target owes beyond the shape of these calls:

- It resolves the pull request's current head itself on a redeploy: a command handler has no checkout of that branch, and a commit guessed from the runner would be the wrong one to rebuild from.
- It answers an `Idempotency-Key` it has already served with the result it gave then, and says so with `Idempotency-Replayed: true` — compared without regard to case — so the Action can report a repeat as already done instead of implying a second rebuild. This is the lock that holds when the Action's own record could not be written: [the Action suppresses a repeat](migration-feedback.md#6-commands) only while it can read the state branch it remembers in, and a crash or a refused push leaves a window in which the same key arrives twice.
- It never treats a repeated key as a conflict: the answer to a replayed publish is the same frozen revision, not an error, because the runner may be retrying a delivery whose reply it never saw.
- It runs the boot probe before promoting a build, and keeps the previous good build serving when the probe fails.
- It never returns its own control surface to the instance it runs, and never lets an instance reach the runtime socket of the machine it is on.

### 8.1 The publish hand-back

`publish` is the one verb whose work does not finish at the target, because the target has no write access to the pull request branch and never will. It asks for the change to be published; the Action is what publishes it. The hand-back is the four steps below, and a target implements the first two.

1. **The target freezes the scratch tree and names the revision.** `POST /previews/{repository}/{pullRequest}` with `{ action: 'publish' }` answers `200 { revision, baseSha, headSha }`. Only `revision` is required for the hand-back to continue: `headSha` is used to check the branch has not moved, and a target that omits it is taken to mean the pull request's current head. `revision` is an opaque id for the tree exactly as it was at that moment; `baseSha` is the commit the scratch tree was built from, and `headSha` is the pull request head when the publish was accepted. Freezing is what makes a publish mean one reviewable change: iteration may continue on top of it, and the frozen revision stays fetchable and unchanged whatever the user does next. A target that cannot freeze answers non-2xx, and the Action reports that nothing was published.
2. **The target serves that revision as a diff.** `GET /previews/{repository}/{pullRequest}/scratch?revision={revision}` answers the frozen tree as a unified diff a `git apply` accepts, together with the base it applies to and the files it touches. A revision id that is unknown or has been pruned is a non-2xx, not an empty diff, because "no changes" and "the changes are gone" must not look the same to the runner.
3. **The Action applies the diff and runs the gates.** It creates a worktree of the pull request branch at `headSha`, applies the diff there, and runs the same stack every other change goes through (mechanical, boot probe, web smoke, and the end-to-end suite under its configured gate, per [§7](#7-gate-policy)). Two things stop it before the gates are spent: a revision already on the branch, which is a retry rather than a republish, and a branch that has moved past `headSha`, which is the case the next sentence is for. A diff that no longer applies to `headSha` is reported as such, and so are the two cases where the base is the problem rather than the patch — a branch that moved, and a scratch tree built from an older base than the frozen head, whose changes conflict with it. In both the target rebuilds scratch onto the current head and freezes a new revision, instead of the Action forcing a merge it was never asked to make.
4. **Only a green run pushes.** A failure means nothing reaches the branch, and the reason is reported on the thread: which stage refused, and the verdict per gate layer. A successful run reports the commit that carries the change — which is this delivery's push, or, when the revision was already on the branch, the commit an earlier delivery pushed, marked as such.

**The gates run the target's code with the runner's credentials, between the last check and the push.** Applying a diff and then running the plugin's own `npm install` and test commands executes code that came from the scratch tree, in a job that holds `GITHUB_TOKEN` with `contents: write` and the deploy token. That is the price of "the gates run before anything reaches the branch", and it is why the publish job's environment should carry nothing the gates do not need. The same reason is why the gates must be the whole stack: a publish that skipped one is a change pushed on the strength of a partial answer. What the Action does about the boundary is small and worth stating: the commit is taken before the gates run, the push names that commit, and the URL the push would use — read with `git remote get-url --push` in the worktree the push runs from, so a `pushurl`, a `pushInsteadOf`, and a worktree-local configuration all count — is compared with what it was before them. A push URL that does not reach the remote the checkout fetched from is refused outright, before the gates are spent, because a publish that reports a commit as landed while it went to a mirror is worse than a refusal. That catches a gate which retargeted the checkout, by accident or on purpose; it is a comparison of configuration and not a sandbox, because the worktree shares the checkout's git config and a gate can still reach the same remote another way.

The outcome goes back to the target too, as `POST …/publish-result`: `published` with the commit that carries the change — plus `alreadyPublished: true` when this delivery pushed nothing because the revision was already there — or `refused` with the stage that refused it and the verdict per gate layer, so a preview can show why a change did not reach the branch instead of showing nothing. Every refusal *after* the freeze is reported, because the target is then holding a revision; a refusal before it is not, because there is no revision to report and the freeze simply never happened. It is a report rather than a request, so it carries no `Idempotency-Key`, it is given five seconds rather than twenty, and a target that does not serve it is a line in the log — the thread already has the answer. What the Action never sends is that the request was accepted before the gates ran, because "accepted" is not an outcome a publish has.

A publish runs the gates and stops there. It has no repair loop and no review stage, because there is nothing to repair: the diff came from a tree a person has been iterating in, and a refusal means they iterate again and publish again. The pipeline's loop exists to fix a migration nobody has looked at yet, which is a different problem.

What this buys is that the pull request branch has exactly one writer, that writer holds the credentials, and the machine running the code a user is trying has none. The price is that publishing is a request rather than an operation: the target has to keep a revision frozen until the runner has fetched it, and the user's next edit does not silently become part of the change under review.

The Action's half is built: `applyHandback` owns the git, takes the gate stack as a port, and refuses rather than pushing when it cannot verify what it applied. A revision already on the branch is not applied twice, which is what makes a retry of a publish whose reply never arrived a no-op.

## 9. What is deliberately not built

- **Running the migration on the deploy host.** Declared in [§2](#2-two-run-paths-one-of-them-shipped) as the unshipped path.
- **Email notification.** Rejected in [§3](#3-the-live-view): the pull request is the notification, and a second channel would need an address, delivery handling, and a privacy story to duplicate it.
- **A command channel into a running migration.** The live view is read-only; a run is unattended, and interactivity belongs to the preview, which is a different lifetime.
- **Self-hosting the deploy target.** The target is the user's, for the same reason the feedback channels' destinations are: it holds their key and serves their code.
