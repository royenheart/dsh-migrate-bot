---
kind: reference
description: The /dsh-migrate comment commands and their flags.
---

# Comment commands reference

A commenter the Action admits ([who](../design/workflow.md#9-comment-commands)) runs a command by commenting `/dsh-migrate <verb>` on a proposal's issue or pull request. This page is generated from `src/commands/table.ts` by `scripts/references.ts`; edit the source, not this page.

| Command | Needs a deploy service | Description |
| --- | --- | --- |
| `/dsh-migrate status` | no | Report the processed and verified releases, the open proposal, every report channel, and the preview deployment. |
| `/dsh-migrate report [--dry-run] [--resend]` | no | Send the merge report to the enabled channels that have not taken it; `--resend` sends it to every enabled channel again; `--dry-run` shows what each channel would send. |
| `/dsh-migrate redeploy` | yes | Rebuild the preview deployment of this pull request from its current head. |
| `/dsh-migrate destroy` | yes | Remove the preview deployment and its working copy. |
| `/dsh-migrate extend` | yes | Ask the deploy service to extend the preview deployment by `deploy.preview.extendDays`, at most to `deploy.preview.ttlDays`. |
| `/dsh-migrate publish` | yes | Apply the preview working copy to the pull request branch after the checks pass. |
