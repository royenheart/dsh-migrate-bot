# AGENTS.md — the documentation standard

Rules for the documents in this repository. [docs/index.md](index.md) is the index they are looked up through; [../AGENTS.md](../AGENTS.md) carries the standing orders for code and commits.

## The tier taxonomy: one home per fact

Each fact has exactly one home — the tier whose job it is. Everywhere else, link there.

| Tier | Job | Does not belong there |
|---|---|---|
| [../README.md](../README.md) | The product: what the Action does, and how to consume it | Design rationale, benchmark methodology, open work, and the configuration table, which [reference/](reference/configuration.md) owns |
| [../AGENTS.md](../AGENTS.md) | Standing orders an agent needs in context every session, one to three lines each | Worked examples, incident narratives, anything restated from a linked home |
| [index.md](index.md) | The lookup table: subject → owning document → owning section | Any fact of its own; every row points somewhere else |
| [reference/](reference/workflow.md) | Generated: the configuration keys, the workflow statechart, the comment commands, the benchmark metrics and records | Hand edits; change the source the page names |
| [design/](design/workflow.md) | How a mechanism works, why it is shaped that way, what it guarantees; how the Action is evaluated | Measured results, procedures, current task state |
| [operations/](operations/install.md) | Procedures: installing the Action, releasing it, running the benchmark | Design rationale |
| [postmortems/](postmortems/2026-09-29-agent-runtime-drift.md) | What broke, why, and what changed | Rules, which link their reasoning instead |
| [../CHANGELOG.md](../CHANGELOG.md) | Generated release history | Hand-written entries |

Placement in one line: current behaviour → README; configuration, workflow, commands, metrics and the record format → `reference/`, generated; installing, releasing and benchmarking → `operations/`; a rule → AGENTS.md; how a mechanism works and how it is evaluated → `design/`; what it scored → the records on `bench/records`.

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
