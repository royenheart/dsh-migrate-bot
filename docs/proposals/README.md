# Proposals

A design proposal records one decision that needs the owner ([principle 9](../engineering.md#9-design-decisions)). It exists while the question is open or parked; a decided design moves into the Design decisions section of the document that owns its topic, and [the decisions index](../decisions.md) links to it.

## Lifecycle

1. Write `docs/proposals/<topic>.md` with the skeleton below, add a row to [docs/index.md](../index.md), and link it from the discussion or report that raises it.
2. The owner decides each item in review or by reply, or parks the proposal. A parked proposal states when to resume. Parked work is not implemented, not even partially.
3. The implementing change moves each decision into the owning document's Design decisions section, adds the Decision paragraph to the commit, updates [docs/decisions.md](../decisions.md), and deletes the proposal. Rejected options that still inform later work stay in the decision's Options paragraph, not in a separate file.
4. A partly decided proposal keeps only its open items and remains a proposal until those items close.

## Skeleton

Each proposal states `Status: open` or `Status: parked` as its first metadata line and keeps these sections in order:

```markdown
# Proposal: <title>

Status: open

## Problem
## Proposal
## Decisions needed
## Acceptance criteria
## Risks
```

Under **Decisions needed**, each item states the question, the options and their costs, the recommendation and why, and what it blocks. The proposal links evidence and related designs rather than restating them.
