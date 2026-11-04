# AGENTS.md

Rules for every agent session in this repository. [README.md](README.md) describes the product; [docs/index.md](docs/index.md) names the document and section that owns each subject; [docs/features.md](docs/features.md) is the feature catalog; [docs/glossary.md](docs/glossary.md) defines the terms; and [docs/engineering.md](docs/engineering.md) holds the full engineering principles. Read this file, then look a subject up there rather than reading the tree.

## Commands

```sh
npm ci                      # Node ^22.19 || >=24
npm test                    # build + unit, integration and mechanical tests
npm run test:e2e            # build + the end-to-end tests: the Action against the built deploy service, installing dsh
npx tsc --noEmit            # type check without emitting
npm run gates               # repository gates
node dist/scripts/references.js --write   # regenerate docs/reference/ after changing its source
npm run bench -- run --subject oracle     # benchmark; docs/operations/benchmark.md
npm run site                # build the benchmark report into .bench/site
npm run deploy-service:build && npm run deploy-service:test   # the reference deploy service in deploy-service/
```

## Engineering principles

Each line is a standing order; [docs/engineering.md](docs/engineering.md) holds the full rule.

1. **Persistent data**: reuse existing fields and files; every new persisted field states its meaning and why it must be stored; no derivable data, reserved fields, or JSON to dodge modelling ([1](docs/engineering.md#1-persistent-data-design)).
2. **CRUD**: state who creates, reads, updates, and deletes each piece of data; implement only needed operations ([2](docs/engineering.md#2-crud-and-consistency)).
3. **Replace, don't accumulate**: delete the old implementation; compatibility only for released clients or written data, with a removal condition; no temporary content left behind ([3](docs/engineering.md#3-replacing-implementations-and-removing-temporary-content)).
4. **Flows are state machines**: one interpreter writes state, handlers and timers emit events, closed state sets, machine-readable error reasons ([4](docs/engineering.md#4-flow-modules-and-state-machines)).
5. **Complexity**: avoid regex chains, special-case stacks, boolean combinations, fallback chains, and nested retries; prefer structured parsers and existing capabilities ([5](docs/engineering.md#5-implementation-complexity)).
6. **Reuse**: search this repository and related projects before building; one definition per shared concept; trace every field from writer to reader; account for every caller ([6](docs/engineering.md#6-reuse-and-cross-project-unity)).
7. **End to end**: follow each flow to the real external effect across first run, interruption, retry, restart, and existing data; release resources symmetrically; effects happen once ([7](docs/engineering.md#7-end-to-end-flows-and-resource-symmetry)).
8. **Scale**: measure or state the magnitude; reason at 10× and 100×; design caps and batching ([8](docs/engineering.md#8-data-scale)).
9. **Decisions**: do not choose alone when options carry real costs; write the question, options, recommendation, and blocked work; implement decided items as decided ([9](docs/engineering.md#9-design-decisions)).
10. **Docs**: update every affected document in the same change, one home per fact, delete stale docs; code, comments, docs, and commits in English; reports to the owner in Chinese ([10](docs/engineering.md#10-documentation-and-language)).
11. **Commits**: atomic Conventional Commits, fixups folded in, Decision paragraph for implemented decisions, each commit passes on its own ([11](docs/engineering.md#11-git-commits)).
12. **Verification**: targeted checks only; tests enter through production entry points; test doubles never looser than the real thing ([12](docs/engineering.md#12-verification)).
13. **Reports** follow the fixed outline ([13](docs/engineering.md#13-reporting)).

## Repository invariants

- **Run `npm run gates` and `npm test` before pushing.** CI runs both. A new gate comes with a test that shows it rejecting an invalid input.
- **One home per fact.** State a fact once, in the document that owns it, and link there from anywhere else ([standard](docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact)).
- **Use the glossary's terms.** A term means what [docs/glossary.md](docs/glossary.md) says; the `terms` gate rejects the words it replaces.
- **Generated text is never hand-edited.** The changelog and `docs/reference/` are generated from their sources; edit the source and run its generator.
- **Change the workflow in the statechart first.** A state, event, guard or activity exists only in `src/workflow/machine.ts`; the reference is generated from it, and the property tests in `tests/unit/workflow-machine.test.ts` must pass ([design](docs/design/workflow.md)). `src/workflow/` and `src/domain/` import nothing with side effects; the `pure-core` gate checks it.
- **Measured numbers live in records.** Rewards, durations and pass rates are computed from the records on `bench/records`; no document restates one.
- **Run the upgrade-skill suite's tasks as they are.** The benchmark changes nothing in their fixtures, verifiers or reference solutions, adding only the agent runtime and access to the model API ([design](docs/design/evaluation.md#8-the-suites)), and `vendor/dsh-plugin-upgrade-skill` stays pinned to one commit.
- **Commit with Commitizen** (`npm run commit`). `feat`, `fix`, `docs`, `refactor` and `perf` reach the changelog. Only `feat`, `fix`, `refactor` and `perf` bump the version, so a documentation-only change is released with the next functional one. [CHANGELOG.j2](CHANGELOG.j2) is the changelog template.
- **Gate code adds no dependencies.** The gates in `scripts/` use the Node standard library, TypeScript and the repository's own modules.
- **Check Docker before acting on it.** A `docker` command acts on the whole daemon, which runs other people's workloads. Run `docker ps` and `docker network ls` before anything that creates, removes or prunes, scope every cleanup to resources this work created, and never run an unfiltered destructive command. A benchmark run is bounded by the daemon's address pool ([procedure](docs/operations/benchmark.md#on-a-shared-machine)).
- **Write English, with generic paths.** Code, comments, documents and commit messages are English; the `english` gate checks every tracked text file except what others wrote (`scripts/verify-english.ts`). No machine-specific absolute paths, hostnames or personal data in committed files.
- **Feature catalog**: every user-facing capability has a row in [docs/features.md](docs/features.md); a change updates the row and its owning document.
- **Design decisions**: a decision that constrains later code lives in the Design decisions section of the owning document; [docs/decisions.md](docs/decisions.md) is the index, and the wiki generates its decisions page from both.
- **Wiki**: the wiki is a projection of the repository documents, generated by `npm run site`; edit the source documents, never generated wiki data.
- **Keep this file short.** Detail belongs in the owning document, linked.
