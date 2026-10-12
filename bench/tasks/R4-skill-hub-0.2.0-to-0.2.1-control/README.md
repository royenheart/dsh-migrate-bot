# R4: dsh-skill-hub, 0.2.0-rc.2 → 0.2.1-alpha.2 (control)

| | |
|---|---|
| Plugin | `dsh-skill-hub`, a skill catalog and market with a browser panel |
| Repository | https://github.com/cheshireez/dsh-skill-hub (MIT; `environment/fixture/LICENSE`) |
| Fixture | `f34b0850b831`, the parent of the migration |
| Reference solution | `d180fa0ef65f` plus `peer-ranges.patch` |
| Span | dev ranges `^0.2.0-rc.2`, peer ranges `>=0.1.7-alpha.1 <0.3.0-0` → 0.2.1-alpha.2 |
| `--before` | `2026-10-10T03:55:12Z`, the migration commit |

This is a control task. The author's migration changes only `package.json` and `package-lock.json`: the dev ranges of the dsh packages, `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` move to the 0.2.1-alpha.2 line, and no source file changes. The task therefore scores a migration that raises the ranges and leaves the code alone. `unchanged` lists `src`, which holds both the host half and the browser half (`src/client`), and the `unchanged` check fails if anything under it differs from the fixture. Configuration files, `package.json` and the lockfile are free to change. A migration must raise more than the dsh ranges: every 0.2.1-alpha.2 package has a peer on `@deepseek-ai/cordis ~4.0.5-alpha.1`, so with the fixture's `@deepseek-ai/cordis` dev range `^4.0.2` the install fails with ERESOLVE.

The reference solution is two patches, which `solution/solve.sh` applies in order:

- `solution/migration.patch`: the author's commit `d180fa0ef65f`, unchanged.
- `solution/peer-ranges.patch`: appends `|| ^0.2.1-alpha.2` to each of the 13 `@deepseek-ai/dsh-*` peer ranges. It is generated with `git diff` against the fixture after `migration.patch` has been applied. The author kept those ranges at `>=0.1.7-alpha.1 <0.3.0-0`. Under semver, a prerelease satisfies a range only if one of its comparators has a prerelease on the same `major.minor.patch`, so 0.2.1-alpha.2 is outside that range. npm applies that rule when it installs the plugin next to the 0.2.1-alpha.2 packages, and fails with ERESOLVE. dsh's own runtime check uses `includePrerelease`, so it loads the plugin either way. Without this edit the author's commit fails the `contract` check.
