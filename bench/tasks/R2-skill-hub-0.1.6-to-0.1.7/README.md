# R2: dsh-skill-hub, 0.1.6-alpha.2 → 0.1.7-alpha.1

| | |
|---|---|
| Plugin | `dsh-skill-hub`, a skill catalog and market with a browser panel |
| Repository | https://github.com/cheshireez/dsh-skill-hub (MIT; `environment/fixture/LICENSE`) |
| Fixture | `578c81d05e49`, the parent of the migration |
| Reference solution | `e5988378c35d` to `ecec0731529b`, the migration and its same-day follow-ups, as `solution/migration.patch` |
| Span | dev ranges `^0.1.6-alpha.2`, peer ranges `>=0.1.6-alpha.2 <0.2.0-0` → 0.1.7-alpha.1 |
| `--before` | `2026-09-22T14:21:40Z`, the last commit of the reference solution |

dsh 0.1.7-alpha.1 replaces the settings model: a plugin no longer registers a settings namespace (`ctx.settings.register` is gone; the Loader entry's config is the namespace, written through `ctx.settings.mutate` and `.volatile()` fields of `@deepseek-ai/schemastery`), and the browser half reads its form through `ctx.configForms` instead of `ctx.settingsScope`. The plugin's peer ranges refuse 0.1.7-alpha.1, and with the dsh packages at 0.1.7-alpha.1 its install fails on peer conflicts (`ERESOLVE`); its code is written against the removed settings API. The author's migration commit `e5988378c35d` rewrote the host's config integration, but also deleted the plugin's settings card on the mistaken belief that 0.1.7 generates one; the following commits restore the card on `ctx.configForms` (`500ce76`), fix comments, the READMEs and the system-prompt guidance (`717202a`, `7fdd1ee`, `ecec073`), drop the unused `schemastery` dependency (`840002e`), and re-apply the plugin's surfaces after a config write, which the removed settings watcher used to do (`ecec073`). The reference solution is that whole range, so that it keeps the plugin's behaviour; the range's re-taken screenshots under `promo/` are left out of the patch.

The hidden test is `src/client/slash-dots.test.ts` as of `ecec073`: the fixture's version imports the type `SettingsScope` from `@deepseek-ai/dsh-client-ui-settings/client`, which 0.1.7-alpha.1 no longer exports, so the migration had to change it; the new version types the fake form as `ConfigForm`. No other test changed.
