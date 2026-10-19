# R3: dsh-better-display, 0.1.7-rc.1 → 0.1.7-rc.2

| | |
|---|---|
| Plugin | `dsh-better-display`, a reading view for the dsh web client |
| Repository | https://github.com/aa2246740/dsh-better-display (MIT; `environment/fixture/LICENSE`) |
| Fixture | `91048c1de787`, the parent of the migration, without `.cursor/` and `tests/cloud-gate.test.ts` |
| Reference solution | `1b63e95e52ef`, "fix: accept Harness 0.1.7-rc.2 reading contracts", as `solution/migration.patch` |
| Span | devDependencies pinned to `0.1.7-rc.1`, peer ranges `>=0.1.7-rc.1 <0.1.8` → 0.1.7-rc.2 |
| `--before` | `2026-09-24T18:45:44Z`, the migration commit |

The plugin's peer ranges already admit 0.1.7-rc.2, but its devDependencies pin 0.1.7-rc.1. Its code still typechecks and its tests pass on 0.1.7-rc.2; what breaks is `build`, which starts with `scripts/check-harness-compat.mjs`: it hashes the Harness sources the plugin mirrors or forks and lists the official slot registrations, and refuses to build while they differ from the baseline in `compat/harness-rc2.json`. On 0.1.7-rc.2 five sources changed and two registrations were added (`schedule-created`, `schedule_update`). The image therefore carries the Harness source at `dsh-v0.1.7-rc.2` (`477b4f42`) in `/opt/deepseek-harness`, named by `DSHX_HARNESS`, plus `ripgrep`, which the gate uses. The author reviewed the differences, recorded the new baseline, raised the devDependencies, added type-only imports of `dsh-api-remotes` and `dsh-client-connection`, mirrored the host's new presentation of tool-change context rows and of Desktop file images (`dsh-app://app/api/file`), and committed the rebuilt `lib/`.

`lib/` stays in the fixture and in the patch: the plugin is installed from GitHub with its committed build output, its tests read `lib/client.js` and `lib/types/client/Reader.js`, and the verifier runs `test` before `build`. `.cursor/` (agent rules) is left out, and with it `tests/cloud-gate.test.ts`, which only checks those files. The task has no hidden tests: the two tests the author added or extended (`tests/context-tool-update.test.ts`, `tests/platform-media.test.ts`) check the new tool-change row helper and the Desktop image route, features that mirror the host rather than changes 0.1.7-rc.2 requires, and the old code passes on the target without them.
