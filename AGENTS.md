# AGENTS.md

Standing orders for any agent working in this repository. [README.md](README.md) describes the product; [docs/index.md](docs/index.md) indexes every document and names the section that owns each subject. Read this file, then look subjects up there rather than reading the tree.

## Commands

```sh
npm install                 # Node ^22.19 || >=24
npm test                    # build + unit and mechanical tests
npx tsc --noEmit            # type check without emitting
npm run gates               # documentation gates: index, links, generated README block
npm run sync:readme         # regenerate the README benchmark block from reports/
npm run check:upstream      # benchmark oracle self-check; no API key, no Harbor
npm run bench:upstream      # score this repository's agent on the upstream suite
```

## Rules

- **Run `npm run gates` and `npm test` before pushing.** CI runs both; a documentation defect fails in seconds rather than after the slower suite. A new gate proves it rejects an invalid case before it is trusted.
- **One home per fact.** State a fact once, in the document that owns it, and link there from anywhere else. [docs/index.md](docs/index.md) is how a reader finds that home ([standard](docs/AGENTS.md#the-tier-taxonomy-one-home-per-fact)).
- **Generated text is never hand-edited.** The changelog, the README benchmark block, and the index are all reproducible from their sources; edit the source and re-run its generator.
- **Measured numbers live in records, not prose.** Rewards, durations, and pass rates come from `reports/` through `npm run sync:readme`. Never restate a figure in a document by hand.
- **Declare deviations where they are made.** Anything that changes an upstream artifact or a task environment is a declared deviation in the script that applies it and in [docs/upstream-benchmark.md](docs/upstream-benchmark.md#preparations), never a silent edit.
- **Pin the benchmark suite to a commit.** `vendor/dsh-plugin-upgrade-skill` is a submodule pinned to a single SHA, never to `main`, because the upstream comparability rules require a frozen snapshot.
- **Commit with Commitizen** (`npm run commit`). `feat`, `fix`, `docs`, `refactor`, and `perf` reach the changelog; the rest stay out. Only `feat`, `fix`, `refactor`, and `perf` are eligible to bump the version, so a documentation-only change is released alongside the next functional one instead of on its own. The changelog template is [CHANGELOG.j2](CHANGELOG.j2), and it exists so a full regeneration reproduces the header.
- **Gate code adds no dependencies.** The gates in `scripts/` run on the Node standard library, so CI never fails for a reason unrelated to the change.
- **Look before touching Docker.** A `docker` command acts on the whole daemon, not on this repository, so check what is already running (`docker ps`, `docker network ls`) before anything that creates, removes, or prunes, and read the result before acting on it: the baseline is other people's workloads, and a command is scoped correctly only when it cannot reach them.
- **A benchmark run is a guest on the machine.** Its trials hold whole subnets, so the limit on running them at once is the daemon's address pool, not CPU. When a run exhausts that pool, lower its concurrency ([what the failure looks like](docs/upstream-benchmark.md#running-the-suite-on-a-shared-machine)). Never reclaim a resource the run does not own, and never run an unfiltered destructive command against containers, networks, or volumes: scope every cleanup to this run's own resources.
- **Write English code and comments, and generic paths.** No machine-specific absolute paths, hostnames, or personal data in committed files.
- **Keep this file short.** It carries the orders an agent needs in context every session; detail belongs in the owning document, linked.

## Open work

Planned work and explicit non-goals live in [docs/plans/README.md](docs/plans/README.md). Check it before starting something that looks missing.
