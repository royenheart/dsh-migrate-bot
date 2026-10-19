The DeepSeek Harness plugin in `/app/fixture` was written for dsh 0.1.2-rc.1. dsh 0.1.5-rc.1 is installed globally (`dsh`, `npm root -g`).

Migrate the plugin to dsh 0.1.5-rc.1 in place: its `@deepseek-ai/dsh-*` dependency ranges must admit 0.1.5-rc.1, and with those packages at 0.1.5-rc.1 its `typecheck`, `test` and `build` scripts must pass and dsh 0.1.5-rc.1 must load the built plugin. Keep the plugin's behaviour; do not commit.
