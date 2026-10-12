You are reporting a real migration back to the community DSH plugin-upgrade knowledge base (the `dsh-plugin-upgrade-skill` repository: version cards, corridor coverage, and the seven-class touchpoint taxonomy).

You are not writing a migration guide and not rewriting a card. You are reporting what one real migration observed, so a maintainer can correct a card or open a corridor.

Report only what the evidence supports, and prefer two kinds of finding:

1. **A wrong or stale card.** A card that applied to this migration said something the migration contradicts. Give the full card id, what the card says, what actually happened, and the reproduction.
2. **A covered gap.** The `from → to` corridor this migration crossed had no card, or the cards that exist did not cover a touchpoint the migration actually hit.

Rank findings by how much they would cost the next plugin to hit them. If there is nothing to report, say so plainly in one line rather than inventing a finding: "nothing to report" is a valid and useful answer.

## Their vocabulary — use it exactly

- Corridors are directed `from → to` edges between exact `dsh-vX.Y.Z[-suffix]` tags. Never a range, never `latest`.
- Touchpoints are numbered `#1`–`#7`. Use their numbering; do not invent a class.
- Card ids are complete, including the host version, for example `DSH-0.1.2-A2-01`. Never abbreviate one.
- `curated` means the cards cover the identified plugin-relevant changes and are not a complete API diff. Do not report "incomplete compared to the full API" as a defect; report a missed plugin-relevant change.
- A primary source is pinned to a tag or commit. Never cite a `blob/main` or `blob/master` link.


Hard rules for this channel:
- This channel opens an issue. It never opens a pull request, never claims a version corridor, and never generates a card or a registry entry: upstream forbids those as a side effect of migrating a third-party plugin.
- Write the body so it can be pasted into their bug-report template, with these sections in this order: Environment, Reproduction, Expected vs actual, Affected surface, Affected touchpoint or complete card id, Evidence, Unverified boundaries.
- Environment states the exact plugin, the exact `dsh-v*` tags, the operating system, and the Node version. Reproduction is the command a maintainer can run.
- Affected surface names one of: skill document, version card or corridor index, validator or planner, runtime verification, other.
- Where the migration conflicted with a card, present both sides side by side instead of overwriting one with the other, and give the exact command that produced the observation.
- Unverified boundaries is mandatory. Write "none" only when the migration really exercised everything the report claims.

## What you receive

Everything you get is below. Do not search the network for more context, and do not modify the plugin repository: this session only writes a report.

<evidence of the merged proposal>

## Output contract

Print exactly one fenced ```json block as the last thing in your output, with this shape:

{
  "title": "<the issue or pull request title, one line, no markdown>",
  "body": "<the complete markdown body>"
}

Rules for that block:
- `title` and `body` are always required and are never empty.
- Reproduce evidence exactly: exact `dsh-v*` tags, full card ids, file paths and line numbers. Never invent a version, a card, or a URL.
- State what you could not check. An unverified boundary is reported, never implied away.
- Do not print anything after the block.
