# Feature catalog

The user-facing capabilities of the Action, the benchmark report, and the deploy service. This table is the catalogue of record: each row names the entry point that exercises the feature, the code that implements it, and the document that owns its contract. A change to a feature updates its row and the owning document together.

| ID | Feature | Entry point | Implementation | Owning document |
|---|---|---|---|---|
| F1 | Run one migration between harness releases | `dsh-migrate run` / the Action | `src/cli.ts`, `src/workflow/machine.ts` | [Workflow](design/workflow.md#1-decisions) |
| F2 | Run the configured tree checks without an API key | `dsh-migrate check` | `src/activities/check-tree.ts` | [Checks](design/checks.md#the-five-checks) |
| F3 | Read live run evidence from the state branch | `dsh-migrate inspect [--json]` | `src/inspect/html.ts`, `src/observability/evidence.ts` | [Run evidence](design/evaluation.md#7-the-report) |
| F4 | Run the Harbor benchmark and compare records | `npm run bench -- run` | `scripts/bench.ts`, `src/evaluation/` | [Benchmark](operations/benchmark.md#a-run) |
| F5 | Read the benchmark report | `npm run site` / GitHub Pages | `scripts/site.ts`, `site/` | [The report](design/evaluation.md#7-the-report) |
| F6 | Read the documentation wiki | `npm run site`, then **Wiki** | `scripts/wiki.ts`, `site/wiki.html` | [Documentation standard](AGENTS.md#the-wiki-is-a-projection) |
| F7 | Stream a run log and publish a preview | deploy service `/runs`, `/view`, `/p`, `/previews` | `deploy-service/src/` | [The HTTP contract](design/deploy-service.md#8-the-http-contract) |
| F8 | Ask for status, a report, or a preview action by comment | `/dsh-migrate …` comment | `src/cli.ts`, `src/commands/` | [Comment commands](design/workflow.md#9-comment-commands) |
| F9 | Deliver merge reports to configured channels | `reports.channels` | `src/merge-reports/` | [Merge reports](design/workflow.md#8-merge-reports) |

The catalogue names capabilities, not every function. A new feature adds a row and an entry in [the index](index.md); a removed feature deletes its row.

