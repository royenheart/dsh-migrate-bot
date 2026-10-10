# AGENTS.md

Rules for every agent session in this repository. [README.md](README.md) describes the product; [docs/index.md](docs/index.md) names the document and section that owns each subject, and [docs/glossary.md](docs/glossary.md) defines the terms. Read this file, then look a subject up there rather than reading the tree.

## Commands

```sh
npm ci                      # Node ^22.19 || >=24
npm test                    # build + unit, integration and mechanical tests
npx tsc --noEmit            # type check without emitting
npm run gates               # repository gates
node dist/scripts/references.js --write   # regenerate docs/reference/ after changing its source
npm run bench -- run --subject oracle     # benchmark; docs/operations/benchmark.md
npm run site                # build the benchmark report into .bench/site
npm run deploy-service:build && npm run deploy-service:test   # the reference deploy service in deploy-service/
```

## Rules

- **Run `npm run gates` and `npm test` before pushing.** CI runs both. A new gate comes with a test that shows it rejecting an invalid input.
- **One home per fact.** State a fact once, in the document that owns it, and link there from anywhere else ([standard](docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact)).
- **Use the glossary's terms.** A term means what [docs/glossary.md](docs/glossary.md) says; the `terms` gate rejects the words it replaces.
- **Generated text is never hand-edited.** The changelog and `docs/reference/` are generated from their sources; edit the source and run its generator.
- **Change the workflow in the statechart first.** A state, event, guard or activity exists only in `src/workflow/machine.ts`; the reference is generated from it, and the property tests in `tests/unit/workflow-machine.test.ts` must pass ([design](docs/design/workflow.md)). `src/workflow/` and `src/domain/` import nothing with side effects; the `pure-core` gate checks it.
- **Measured numbers live in records.** Rewards, durations and pass rates are computed from the records on `bench/records`; no document restates one.
- **Run the suite's tasks as they are.** The benchmark changes nothing in a task, its environment or its verifier ([design](docs/design/evaluation.md#2-subjects)), and `vendor/dsh-plugin-upgrade-skill` stays pinned to one commit.
- **Commit with Commitizen** (`npm run commit`). `feat`, `fix`, `docs`, `refactor` and `perf` reach the changelog. Only `feat`, `fix`, `refactor` and `perf` bump the version, so a documentation-only change is released with the next functional one. [CHANGELOG.j2](CHANGELOG.j2) is the changelog template.
- **Gate code adds no dependencies.** The gates in `scripts/` use the Node standard library, TypeScript and the repository's own modules.
- **Check Docker before acting on it.** A `docker` command acts on the whole daemon, which runs other people's workloads. Run `docker ps` and `docker network ls` before anything that creates, removes or prunes, scope every cleanup to resources this work created, and never run an unfiltered destructive command. A benchmark run is bounded by the daemon's address pool ([procedure](docs/operations/benchmark.md#on-a-shared-machine)).
- **Write English, with generic paths.** Code, comments, documents and commit messages are English; the `english` gate checks every tracked file. No machine-specific absolute paths, hostnames or personal data in committed files.
- **Keep this file short.** Detail belongs in the owning document, linked.
