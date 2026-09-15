# AGENTS.md — the documentation standard

Rules for the documents in this repository. [docs/index.md](index.md) is the index they are looked up through; [../AGENTS.md](../AGENTS.md) carries the standing orders for code and commits.

## The tier taxonomy: one home per fact

Each fact has exactly one home — the tier whose job it is. Everywhere else, link there.

| Tier | Job | Does not belong there |
|---|---|---|
| [../README.md](../README.md) | The product: what the Action does, and how to consume it | Design rationale, benchmark methodology, open work, and the exhaustive configuration table, which [installation.md](installation.md) owns |
| [../AGENTS.md](../AGENTS.md) | Standing orders an agent needs in context every session, one to three lines each | Worked examples, war stories, anything restated from a linked home |
| [index.md](index.md) | The lookup table: subject → owning document → owning section | Any fact of its own; every row points somewhere else |
| [installation.md](installation.md) | Installing the Action, every configuration key and its default, the feedback channels, the deploy target and the commands a comment can drive, and the checklist an agent follows when configuring it | Design rationale, which belongs in `design/`; a contract a third party must implement, which belongs in the design document that describes it |
| [design/](design/e2e-migration-pipeline.md) | Reference for a designed mechanism: how it works, why it is ordered that way, what it guarantees | Measured results, procedures, current task state |
| [upstream-benchmark.md](upstream-benchmark.md) | What a benchmark run applies, what it measures, and what the exercise found | The numbers themselves — those live in `reports/` |
| [plans/README.md](plans/README.md) | Open work and deliberate non-goals, each with its owning document | Design of the work itself, which belongs in `design/` |
| [../reports/README.md](../reports/README.md) | The record format every run writes, and what consumes it | Analysis of what the numbers mean |
| [official-discussion-auto-post.md](official-discussion-auto-post.md) | A designed-but-not-shipped capability and the conditions for revisiting it | Procedures that ship today |
| [../CHANGELOG.md](../CHANGELOG.md) | Generated release history | Hand-written entries |

Placement in one line: current behaviour → README; installation and configuration → `installation.md`; a rule → AGENTS.md; how a mechanism works → `design/`; how it is measured → the benchmark document; what it scored → `reports/`; what is next → `plans/`.

## The index is computed, not trusted

[index.md](index.md) is the progressive-disclosure entry point, and `scripts/verify-doc-index.ts` holds it to that: each row's home must exist, its entry-point anchor must match a heading the gate computes from the target document, and every Markdown file under `docs/` plus `../README.md` and `../AGENTS.md` must appear as some row's home. A renamed heading or an unindexed new document fails CI.

Rows keep a fixed shape because the gate reads them: one topic, one backticked repository-root-relative home path, and exactly one link whose path resolves to that home and whose fragment names a real section. Link paths are written relative to the index, because that is what renders.

## Writing rules

- **Present tense, current state.** Describe the mechanism as it is now. A change story belongs in a commit, a release entry, or the relevant design document's rationale — never in a rule.
- **One physical line per paragraph.** Use the editor's soft wrap. Tables, lists, and code blocks keep their formatting.
- **Link with relative Markdown paths, never bare filenames.** `scripts/verify-md-links.ts` rejects a missing target and a `#fragment` that names no heading in the target, so a cross-reference cannot rot silently.
- **State a rule, not the incident that produced it.** A rule is short and self-contained, and links the document that owns the reasoning; the reasoning is not restated beside it.
- **Say what is, not what should be.** Proposals live in `plans/` or `design/`, marked as such. A reference document that hedges with "should" is either a plan that has not moved yet or a rule nobody enforces.
- **Prefer an exact noun to a metaphor.** Name the file, the script, the gate, or the field. A word like "gate" or "surface" that could mean three things is not a name.
- **Every generated region says so.** A region produced by a script is marked and its generator is named in the surrounding text, so the next reader edits the source rather than the output.
- **Budget attention.** A document states its own subject at the detail its position warrants and describes its children only by purpose, linking down for depth. If a section restates a linked document, delete the section.
