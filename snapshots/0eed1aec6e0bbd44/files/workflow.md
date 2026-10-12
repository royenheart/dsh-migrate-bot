---
kind: reference
description: The migration statechart: every state, transition, guard, check pass and event.
---

# Workflow reference

The migration workflow of one consumer and one target release, as the statechart in `src/workflow/machine.ts` defines it. This page is generated from `src/workflow/machine.ts` by `scripts/references.ts`; edit the source, not this page. The design is in [the workflow design](../design/workflow.md).

## Overview

Top-level states only; a transition out of a nested state is drawn from its parent. Any state goes to `error` on `activity.error`.

```mermaid
stateDiagram-v2
  [*] --> start
  start --> sourceBoot
  start --> targetBoot
  start --> afterBaseline
  sourceBoot --> targetBoot
  targetBoot --> afterBaseline
  afterBaseline --> checking
  afterBaseline --> reviewing
  reviewing --> failed
  reviewing --> checking
  checking --> checksPassed
  checking --> evaluating
  checksPassed --> concluding
  checksPassed --> checking
  checksPassed --> authoringE2E
  evaluating --> reviewing
  evaluating --> repairing
  evaluating --> authoringE2E
  evaluating --> failed
  repairing --> failed
  repairing --> checking
  authoringE2E --> concluding
  concluding --> publishing
  concluding --> unpublished
  concluding --> compatible
  publishing --> awaitingMerge
  awaitingMerge --> reporting
  awaitingMerge --> rejected
  awaitingMerge --> superseded
  accepted --> reporting
  reporting --> accepted
  reporting --> awaitingMerge
  compatible --> [*]
  unpublished --> [*]
  failed --> [*]
  error --> [*]
  rejected --> [*]
  superseded --> [*]
```

## States

An *activity* state asks the engine for one activity and leaves on its result. A *decision* state leaves immediately on the first guard that holds. A *waiting* state leaves only on an event from outside the job.

| State | Kind | Activity | Description |
| --- | --- | --- | --- |
| `start` | decision |  |  |
| `sourceBoot` | activity | `check` check=boot release=source e2eScope=full | Boot the unmodified tree on the source release, to classify the outcome. |
| `targetBoot` | activity | `check` check=boot release=target e2eScope=full | Boot the unmodified tree on the target release. |
| `afterBaseline` | decision |  |  |
| `reviewing` | group |  | The overlap review and the extension-point review, once per migration. |
| `reviewing.overlap` | activity | `session` kind=overlap attempt=0 | The overlap review session. |
| `reviewing.extensionPoints` | activity | `session` kind=extension-points attempt=0 | The extension-point review session. |
| `checking` | group |  | One pass of checks; which checks run depends on the scope of the pass. |
| `checking.next` | decision |  |  |
| `checking.running` | activity | computed from the context | Run the next check of the current pass. |
| `checksPassed` | decision |  |  |
| `evaluating` | decision |  |  |
| `repairing` | activity | computed from the context | Repair attempt n: one agent session given the reviews and the failing check. |
| `authoringE2E` | activity | `authorE2E` | An agent session writes or extends the end-to-end suite on its own branch. It never blocks. |
| `concluding` | activity | `inspectTree` | Decide between a proposal and a compatible result from the state of the tree. |
| `publishing` | activity | `publishProposal` | Push the proposal branch and open or update the issue and the pull request. |
| `awaitingMerge` | waiting |  | Wait for the maintainer to merge or close the proposal. |
| `accepted` | waiting |  | The proposal was merged and reported; a `report` command can report it again. |
| `reporting` | group |  | Send the merge report to every enabled channel that has not taken it yet. |
| `reporting.next` | decision |  |  |
| `reporting.running` | activity | computed from the context | Send the merge report to the next channel. |
| `compatible` | final |  | The unmodified tree passes every check on the target release. |
| `unpublished` | final |  | The tree changed and passed, and publishing is turned off. |
| `failed` | final |  | The checks still fail; the migration stopped. |
| `error` | final |  | An activity failed for a reason outside the plugin. |
| `rejected` | final |  | The proposal was closed without merging. |
| `superseded` | final |  | A later migration took over the proposal. |

## Transitions

Transitions of one state are tried in order; the first whose guard holds is taken.

| From | On | Guard | To |
| --- | --- | --- | --- |
| any | `activity.error` | — | `error` |
| `start` | immediately | `hasSource` | `sourceBoot` |
| `start` | immediately | `bootEnabled` | `targetBoot` |
| `start` | immediately | — | `afterBaseline` |
| `sourceBoot` | `check.done` | — | `targetBoot` |
| `targetBoot` | `check.done` | — | `afterBaseline` |
| `afterBaseline` | immediately | `initialPassPossible` | `checking` |
| `afterBaseline` | immediately | — | `reviewing` |
| `reviewing.overlap` | `session.done` | `spendCap` | `failed` |
| `reviewing.overlap` | `session.done` | `sessionFailed` | `failed` |
| `reviewing.overlap` | `session.done` | — | `reviewing.extensionPoints` |
| `reviewing.extensionPoints` | `session.done` | `spendCap` | `failed` |
| `reviewing.extensionPoints` | `session.done` | `sessionFailed` | `failed` |
| `reviewing.extensionPoints` | `session.done` | — | `checking` |
| `checking.next` | immediately | `queueEmpty` | `checksPassed` |
| `checking.next` | immediately | — | `checking.running` |
| `checking.running` | `check.done` | `checkFailed` | `evaluating` |
| `checking.running` | `check.done` | — | `checking.next` |
| `checksPassed` | immediately | `scopeIs(initial)` | `concluding` |
| `checksPassed` | immediately | `scopeIs(attempt)` | `checking` |
| `checksPassed` | immediately | `e2eEnabled` | `authoringE2E` |
| `checksPassed` | immediately | — | `concluding` |
| `evaluating` | immediately | `notReviewed` | `reviewing` |
| `evaluating` | immediately | `canRepair` | `repairing` |
| `evaluating` | immediately | `advisoryE2EFailure` | `authoringE2E` |
| `evaluating` | immediately | — | `failed` |
| `repairing` | `session.done` | `spendCap` | `failed` |
| `repairing` | `session.done` | `sessionFailed` | `failed` |
| `repairing` | `session.done` | `blockerValid` | `failed` |
| `repairing` | `session.done` | — | `checking` |
| `authoringE2E` | `e2e.authored` | — | `concluding` |
| `concluding` | `tree.inspected` | `changedAndPublish` | `publishing` |
| `concluding` | `tree.inspected` | `changed` | `unpublished` |
| `concluding` | `tree.inspected` | — | `compatible` |
| `publishing` | `proposal.published` | — | `awaitingMerge` |
| `awaitingMerge` | `pull-request.closed` | `proposalMerged` | `reporting` |
| `awaitingMerge` | `pull-request.closed` | `proposalClosed` | `rejected` |
| `awaitingMerge` | `proposal.superseded` | — | `superseded` |
| `awaitingMerge` | `command.report` | `newComment` | `reporting` |
| `accepted` | `command.report` | `newComment` | `reporting` |
| `reporting.next` | immediately | `pendingEmptyAndMerged` | `accepted` |
| `reporting.next` | immediately | `pendingEmpty` | `awaitingMerge` |
| `reporting.next` | immediately | — | `reporting.running` |
| `reporting.running` | `report.done` | — | `reporting.next` |

## Guards

| Guard | Holds when |
| --- | --- |
| `bootEnabled` | The boot check is enabled. |
| `hasSource` | A source release is known and the boot check is enabled. |
| `initialPassPossible` | The review policy is `when-checks-fail` and the unmodified tree did not fail the boot check on the target release. |
| `queueEmpty` | Every check of the current pass has run. |
| `checkFailed` | The check failed. |
| `spendCap` | The session was not run, or was stopped, because the spend cap was reached. |
| `sessionFailed` | The session crashed or exceeded its watchdog. |
| `blockerValid` | The repair report declared an upstream blocker with every evidence field. |
| `scopeIs` | The current pass has the given scope. |
| `notReviewed` | The overlap and extension-point reviews have not run. |
| `canRepair` | Repair attempts are left, and the failure fingerprint differs from the one the last repair attempt was given. |
| `advisoryE2EFailure` | The failing check is the end-to-end check and its failure policy is `advisory`. |
| `e2eEnabled` | The end-to-end check is enabled. |
| `changedAndPublish` | The tree changed and publishing is on. |
| `changed` | The tree changed. |
| `proposalMerged` | The closed pull request is this proposal, and it was merged. |
| `proposalClosed` | The closed pull request is this proposal. |
| `pendingEmpty` | Every channel of the reporting pass has been tried. |
| `pendingEmptyAndMerged` | Every channel of the reporting pass has been tried, and the proposal was merged. |
| `newComment` | The `report` command comes from a comment not handled before. |

## Check passes

The checks of a pass run in this order and stop at the first failure. A disabled check is left out.

| Scope | Checks | When |
| --- | --- | --- |
| `initial` | mechanical, boot, web, e2e | The unmodified tree, under the `when-checks-fail` review policy. |
| `attempt` | mechanical, boot, web, e2e | After the reviews and after each repair attempt; the end-to-end check runs the subset of failing and smoke tests. |
| `final` | e2e | After an attempt pass whose end-to-end check ran a subset: the whole suite. |

## Events

Every activity result and every event from outside the job, as the event log stores it.

| Event | Fields |
| --- | --- |
| `check.done` | `result` |
| `session.done` | `kind`, `outcome`, `blocker`, `detail`, `usage`, `report` |
| `e2e.authored` | `outcome`, `detail`, `usage` |
| `tree.inspected` | `changed`, `files` |
| `proposal.published` | `proposal` |
| `report.done` | `channel`, `outcome`, `detail`, `url`, `usage` |
| `activity.error` | `activity`, `detail` |
| `pull-request.closed` | `number`, `merged`, `mergeSha` |
| `proposal.superseded` | `by` |
| `command.report` | `resend`, `comment` |
