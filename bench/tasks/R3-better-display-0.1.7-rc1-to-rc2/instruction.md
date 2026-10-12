The DeepSeek Harness plugin in `/app/fixture` was written for dsh 0.1.7-rc.1. dsh 0.1.7-rc.2 is installed globally (`dsh`, `npm root -g`), and the Harness source of that release (tag `dsh-v0.1.7-rc.2`) is at `/opt/deepseek-harness`, which `DSHX_HARNESS` names.

Migrate the plugin to dsh 0.1.7-rc.2 in place: its `@deepseek-ai/dsh-*` dependency ranges must admit 0.1.7-rc.2, and with those packages at 0.1.7-rc.2 its `typecheck`, `test` and `build` scripts must pass and dsh 0.1.7-rc.2 must load the built plugin. Keep the plugin's behaviour; do not commit.
