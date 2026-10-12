# R1: dsh-router, 0.1.5-rc.2 → 0.2.0-rc.1

| | |
|---|---|
| Plugin | `dsh-router-core`, a model routing gateway with a browser panel |
| Repository | https://github.com/CARVIN94/dsh-router (MIT; `environment/fixture/LICENSE`) |
| Fixture | `230f1a59d2de`, the parent of the migration |
| Reference solution | `4ab5dc993de0`, "migrate(host)" to 0.2.0 only, as `solution/migration.patch` |
| Span | peer ranges `^0.1.5-rc.2`, code that also ran on 0.1.7-rc.2 → 0.2.0-rc.1 |
| `--before` | `2026-09-29T01:16:54Z`, the migration commit |

The plugin's peer ranges do not admit 0.2.0-rc.1, and with the dsh packages at 0.2.0-rc.1 its typecheck fails. The author also removed the 0.1.5 and 0.1.7 compatibility branches and rewrote `src/host-version.test.ts` and `src/llm/adapter.test.ts` around that choice; a migration may keep those branches, so the task has no hidden tests.
