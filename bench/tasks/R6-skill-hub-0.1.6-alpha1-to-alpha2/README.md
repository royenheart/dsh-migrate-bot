# R6: dsh-skill-hub, 0.1.6-alpha.1 → 0.1.6-alpha.2

| | |
|---|---|
| Plugin | `dsh-skill-hub`, a skill catalog and market with a browser panel |
| Repository | https://github.com/cheshireez/dsh-skill-hub (MIT; `environment/fixture/LICENSE`) |
| Fixture | `60b7259f626c`, the parent of the migration |
| Reference solution | `5e71e2a8d348`, the migration, and `c6e9e5cb5197`, its next-day follow-up, without the release commit `3bfb8e994acf` between them, as `solution/migration.patch` |
| Span | dev ranges `^0.1.6-alpha.1`, peer ranges `>=0.1.6-alpha.1 <0.2.0-0` (with older alternatives back to 0.1.0-rc.7) → 0.1.6-alpha.2 |
| `--before` | `2026-09-20T09:07:50Z`, the last commit of the reference solution |

dsh 0.1.6-alpha.2 removes the `settings.plugin.item` slot (Settings → Plugins list) from `@deepseek-ai/dsh-client-ui-settings-plugins`; a plugin's configuration card now goes into the `plugins.bundle.config` slot of the new `@deepseek-ai/dsh-client-ui-plugin-manager`, keyed by the bundle's package name and rendered on the plugin's own page in the Plugins manager. The plugin's ranges already admit 0.1.6-alpha.2, but its browser half registers its settings card into the removed slot and types the card's props as `PropsRuntime<'settings.plugin.item'>`, so its typecheck fails against the target packages. The author's migration commit `5e71e2a8d348` moves the card to `plugins.bundle.config` (adding `dsh-client-ui-plugin-manager` as a dev dependency), raises the ranges to 0.1.6-alpha.2, and also drops the plugin's compatibility with hosts older than 0.1.2-alpha.2 (the icon path of the slash-menu dots, the old `dshVersions` and peer alternatives, a `tsdown` comment). Its system-prompt guidance and comments still sent the user to the old Settings → Plugins list; the follow-up `c6e9e5cb5197` corrects that guidance in `src/index.ts`, the comments and the READMEs. The reference solution is both commits, so that the guidance the plugin gives the model matches where the card now is; the release commit `3bfb8e994acf` between them only bumps the plugin's own version and is left out. Nothing was excluded from the fixture, which is `git archive 60b7259f626c` (no build output, agent notes or changelog in the tree; the `promo/` screenshots are unchanged in the range).

The task has no hidden tests. The only test the migration changed is `src/client/slash-dots.test.ts`, which the author rewrote because they removed the old-host icon path of the slash-menu dots; that path is never taken on 0.1.6-alpha.2 (it runs only when a candidate request lacks `drilled`, which every host since 0.1.2-alpha.2 sends) and still typechecks, so a migration may keep it and the fixture's test with it.
