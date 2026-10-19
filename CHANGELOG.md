# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/).
Entries are generated from the commit history by [Commitizen](https://commitizen-tools.github.io/commitizen/); do not edit them by hand.

## v1.0.0-rc.1 (2026-10-19)

### BREAKING CHANGE

- checks.e2e.baseRef, checks.e2e.forceRebase and
checks.e2e.subsetFirst are removed, the suite branch holds only the
suite directory, and the final check scope is gone.
- a consumer replaces its workflow with
examples/workflow.yml and pins @v1.
- The CLI is `run | pull-request-closed | comment | check
| status | self-test | print-config`, and the Action takes one `command`
input instead of refresh_only, feedback_only, comment_command,
mechanical_only and allow_second_pull_request. seen.json is no longer
read; the state branch holds migrations/<version>/events.jsonl. The
comment verb `feedback` is `report`, and report channel tokens are
DSH_MIGRATE_REPORT_*_TOKEN. Proposals use the branch dsh-migrate/proposal.
- issuePr.language and its Chinese issue and pull
request templates are removed; every body is English. watch.enabled is
removed; an unchanged target release is skipped unless the run is
forced. review.policy skip-if-mechanical-pass is replaced by
when-checks-fail, which skips the reviews only when the unmodified tree
passes the boot, web and end-to-end checks too. The pull and issue+pull
report methods are removed; a report channel delivers an issue or a
discussion.

### Feat

- **bench**: add four span tasks from 0.1.2 to 0.2.0
- **config**: let a consumer keep the end-to-end suite off its branch
- **checks**: hold the plugin's sources to the dependency contract
- **e2e**: repair a failure in the plugin's part, report one on the way there
- **checks**: hold a migration to the upgrade skill's change cards
- **bench**: write the report a task asks for in a session of its own
- **workflow**: log what each activity concluded
- **bench**: add a suite of real migrations across release spans
- **skills**: pin the upgrade skill with change cards through dsh 0.2.0
- **e2e**: record an end-to-end baseline on the source release and check it on the target
- **workflow**: migrate every plugin of a repository together
- **config**: load the upgrade skill into migration sessions by default
- **bench**: snapshot the Action with every record and show what changed
- **bench**: publish the benchmark report with a diff viewer and field outcomes
- **bench**: score the pipeline and the session into immutable records
- **deploy-service**: add the reference deploy service and its conformance suite
- **action**: ship a reusable workflow and a prebuilt image
- **checks**: check the plugin's dependency contract with the target release
- **workflow**: run migrations as a statechart over an event log
- **config**: validate the configuration with one declarative schema
- make benchmark records reproducible across migration modes
- package the action, its inputs and the container
- drive the commands, the run and the badge job from the CLI
- the preview verbs, the live view and the publish hand-back
- report a merged migration to configurable feedback channels
- carry out a command once, whoever delivers it twice
- one rule for rendering a value that came from outside

### Fix

- **deploy-service**: run git without detached maintenance
- **git**: run git without detached maintenance
- **bench**: count every usage a pipeline reports, not only its sessions'
- **bench**: say when two compared records had different report judges
- **bench**: let a task whose agent runs offline reach the model API
- **bench**: write a record only when every planned trial has finished
- **bench**: fit the span verifier's steps in Harbor's verifier timeout
- **deploy-service**: bound the data directory in bytes, and fix compose's service address
- **deploy-service**: remove the containers a timeout or a restart left, and stop an exited instance
- **deploy-service**: keep a preview's change to what the person edited, as bytes
- **gates**: check every pure module, a workflow without the Action, and only the authors' patches
- **config**: require the token of a channel that is not built in
- **deploy**: apply a frozen revision's diff as the bytes it was served
- **container**: pass each option as one argument
- **merge-reports**: fail one channel without stopping the others
- **runtime**: hold the end-to-end authoring session to the spend cap
- **e2e**: publish no suite for plugins without a browser half
- **checks**: check an optional peer the release stopped publishing against its range
- **checks**: cut a release's dependencies off before the next release of any line
- **git**: exclude the ignored paths in a linked worktree too
- **checks**: hold the card ledger to the cards as written
- **checks**: run every check without the secrets the Action holds
- **action**: queue only the jobs that can act, and pass the Action's outputs through
- **workflow**: deliver a proposal's merge or close that never reached the Action
- **e2e**: blame the plugin only for a baseline test that failed in a check step
- **bench**: give an agent setup the time several setups at once take
- **checks**: read the card ledger a session writes, not one it might
- **checks**: cut a release's dependencies off before its line moves on
- **bench**: boot a plugin in the span verifier without HMR
- **checks**: identify a mechanical failure by npm's error, not its warning
- **e2e**: report an advisory end-to-end failure without working on it
- **bench**: leave tasks whose agent runs offline out of pipeline runs
- **checks**: pin the plugin's dsh packages as the release was published
- **checks**: let an optional peer the release stopped publishing through
- **checks**: serve the plugins' profile in the web check, and fail a bundle dsh skips
- **bench**: run only the tasks whose verifier the run can serve
- **bench**: keep the pipeline log of a trial that times out
- **checks**: check a release as it was published, and browser plugins on the web
- **runtime**: price every session with the Action's own accounting
- **checks**: load a check profile's patches once at startup
- **runtime**: pin the agent runtime with a lockfile and self-test it
- **github**: pass the environment to the repository lookup explicitly

### Docs

- give installing, releasing and the workflow one home each
- **bench**: describe the two suites, the records and the metrics as they are
- **install**: set the Action and the deploy service up with a coding agent
- **install**: move a v0 consumer to v1
- define the project terms and gate the documents against them
- the index, the open work and the standing orders

### Perf

- **bench**: stop a pipeline at its conclusion and cite cards in its report

## v0.3.4 (2026-09-15)

### Fix

- price each request under the rules that applied when it was made

## v0.3.3 (2026-09-15)

### Feat

- make benchmark records reproducible across migration modes
- report a merged migration to configurable feedback channels

### Docs

- report what the two migration modes measured and what the suite exposed

## v0.3.2 (2026-09-12)

### Feat

- add the documentation constraint system

### Fix

- **changelog**: emit the header only on a full regeneration

### Docs

- **bench**: name both apt failure modes and reject the silent-install fix
- **cz**: make docs a first-class changelog type

## v0.3.1 (2026-09-11)

### Feat

- **verify**: add boot, web and baseline verification gates

### Docs

- **bench**: vendor the community suite and score against it

## v0.3.0 (2026-09-10)

### Feat

- migrate with the shipped standard preset on DeepSeek V4 Flash

### Fix

- authenticate the dsh release lookup and fall back to git ls-remote

## v0.2.3 (2026-08-31)

### Feat

- link draft patch reports to official Ideas discussions

## v0.2.2 (2026-08-31)

### Feat

- split processed and verified dsh badge state

## v0.2.1 (2026-08-28)

### Fix

- stop npx tsc noise and keep documented plugin surfaces

## v0.2.0 (2026-08-27)

### Feat

- pin mechanical tests to the target dsh packages

## v0.1.5 (2026-08-26)

### Fix

- put A/B/C analysis sections back on the Issue

## v0.1.4 (2026-08-26)

### Fix

- keep Issue markdown from being stolen by embedded fences

## v0.1.3 (2026-08-26)

### Feat

- add quota, harness checkout, and patch-report Issue comments

## v0.1.2 (2026-08-26)

### Fix

- rename the Action to DSH Plugin Migrate Bot

### Docs

- add a mermaid diagram of the migrate pipeline

## v0.1.1 (2026-08-26)

### Feat

- rename the default DeepSeek API secret

### Docs

- rewrite README for public readers

## v0.1.0 (2026-08-25)

### Feat

- ship the dsh-migrate GitHub Action
