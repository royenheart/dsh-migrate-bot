# AGENTS.md

Standing orders for any agent working in this repository. [README.md](README.md) describes the product; [docs/index.md](docs/index.md) indexes every document and names the section that owns each subject. Read this file, then look subjects up there rather than reading the tree.

## Commands

```sh
npm ci                      # Node ^22.19 || >=24
npm test                    # build + unit, integration and mechanical tests
npx tsc --noEmit            # type check without emitting
npm run gates               # repository gates: index, links, generated references
node dist/scripts/references.js --write   # regenerate docs/reference/ after changing its source
npm run bench -- run --subject oracle     # benchmark; docs/operations/benchmark.md
npm run deploy-service:build && npm run deploy-service:test   # the reference deploy service in deploy-service/
```

## Rules

- **Run `npm run gates` and `npm test` before pushing.** CI runs both; a documentation defect fails in seconds rather than after the slower suite. A new gate proves it rejects an invalid case before it is trusted.
- **One home per fact.** State a fact once, in the document that owns it, and link there from anywhere else. [docs/index.md](docs/index.md) is how a reader finds that home ([standard](docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact)).
- **Generated text is never hand-edited.** The changelog and `docs/reference/` are reproducible from their sources; edit the source and re-run its generator.
- **The workflow is changed in the statechart first.** A state, event, guard or activity exists only in `src/workflow/machine.ts`; the reference is generated from it and the property tests in `tests/unit/workflow-machine.test.ts` must keep passing ([design](docs/design/workflow.md)).
- **Measured numbers live in records, not prose.** Rewards, durations, and pass rates are computed from the records on `bench/records`. Never restate a figure in a document by hand.
- **Run the suite's tasks as they are.** The benchmark changes nothing in a task, its environment or its verifier; what a subject brings into the container is the subject's ([design](docs/design/evaluation.md#2-subjects)).
- **Pin the benchmark suite to a commit.** `vendor/dsh-plugin-upgrade-skill` is a submodule pinned to a single SHA, never to `main`, because the upstream comparability rules require a frozen snapshot.
- **Commit with Commitizen** (`npm run commit`). `feat`, `fix`, `docs`, `refactor`, and `perf` reach the changelog; the rest stay out. Only `feat`, `fix`, `refactor`, and `perf` are eligible to bump the version, so a documentation-only change is released alongside the next functional one instead of on its own. The changelog template is [CHANGELOG.j2](CHANGELOG.j2), and it exists so a full regeneration reproduces the header.
- **Gate code adds no dependencies.** The gates in `scripts/` use the Node standard library and the repository's own modules, so CI never fails for a reason unrelated to the change.
- **Look before touching Docker.** A `docker` command acts on the whole daemon, not on this repository, so check what is already running (`docker ps`, `docker network ls`) before anything that creates, removes, or prunes, and read the result before acting on it: the baseline is other people's workloads, and a command is scoped correctly only when it cannot reach them.
- **A benchmark run is a guest on the machine.** Its trials hold whole subnets, so the limit on running them at once is the daemon's address pool, not CPU. When a run exhausts that pool, lower its concurrency ([what the failure looks like](docs/operations/benchmark.md#on-a-shared-machine)). Never reclaim a resource the run does not own, and never run an unfiltered destructive command against containers, networks, or volumes: scope every cleanup to this run's own resources.
- **Write English code and comments, and generic paths.** No machine-specific absolute paths, hostnames, or personal data in committed files.
- **Keep this file short.** It carries the orders an agent needs in context every session; detail belongs in the owning document, linked.

