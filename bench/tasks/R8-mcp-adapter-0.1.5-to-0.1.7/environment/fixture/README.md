# dsh-mcp-adapter

[![npm version](https://img.shields.io/npm/v/@auggieteo/dsh-mcp-adapter)](https://www.npmjs.com/package/@auggieteo/dsh-mcp-adapter)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

DSH plugin connecting the agent to MCP servers through one mcp proxy tool and a Settings > MCP page.

A [Deepseek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that mirrors the major features of [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter): one token-efficient `mcp` proxy tool over every configured server, optional per-tool promotion to native DSH tools, and configurable Server lifecycles (`lazy` by default). Servers are added and configured in the DSH web UI under **Settings > MCP**; configuration persists in the DSH settings document (`$DSH_HOME/settings.yaml`, namespace `mcp`).

Vocabulary lives in [CONTEXT.md](./CONTEXT.md). Design decisions live in [docs/adr/](./docs/adr/). Work is tracked as [GitHub issues](https://github.com/auggie246/dsh-mcp-adapter/issues), and released changes are listed in [CHANGELOG.md](./CHANGELOG.md).

## Table of Contents

- [Security](#security)
- [Background](#background)
- [Install](#install)
  - [Compatibility](#compatibility)
  - [Local development](#local-development)
  - [Uninstall](#uninstall)
- [Usage](#usage)
  - [CLI](#cli)
  - [Config](#config)
    - [Workspace Config layer](#workspace-config-layer)
  - [Settings page](#settings-page)
  - [Server lifecycle](#server-lifecycle)
  - [Proxy Tool](#proxy-tool)
  - [Resources and prompts](#resources-and-prompts)
  - [Promotion](#promotion)
  - [OAuth](#oauth)
  - [Agent skill](#agent-skill)
- [Architecture](#architecture)
- [Release](#release)
- [Layout](#layout)
- [Maintainers](#maintainers)
- [Thanks](#thanks)
- [Contributing](#contributing)
- [License](#license)

## Security

- Secret values — every `env` and `headers` entry carries the DSH `secret` schema role — are redacted in every wire view: the Settings page and the `/mcp-adapter` RPC channel see keys and `set` state, never values. Existing secret values stay saved when their value inputs are left blank.
- The `/mcp-adapter` RPC endpoints never expose Config secrets or SDK objects.
- OAuth tokens live in `${DSH_HOME:-~/.dsh}/mcp-auth/tokens.json` (directory `0700`, file `0600`, atomic writes), one record per Server, bound to the Server URL they were issued for. The callback listener runs on a local loopback address and validates the OAuth `state` parameter; token material never travels through the RPC channel.
- Proxy tool output is limited to 50 KiB and 2,000 lines; larger text uses `spillStore` for a full-result reference, and raw structured details over 16 KiB become a compact summary with their own spill reference.
- Binary resource content is never inlined as base64. It is base64-decoded and written to a sanitized `mcp-resource-` path under the system temp folder.
- Tool calls ask for DSH approval unless the Server sets `autoAllow: true`.

## Background

[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) established a workflow for driving many MCP servers from one agent: a single token-efficient proxy tool, lazy connections, and per-tool promotion. This plugin brings that workflow to [Deepseek Harness](https://github.com/deepseek-ai/deepseek-harness) natively.

Server Config is stored in the Adapter's `mcp` namespace of the DSH settings service (persisted to `$DSH_HOME/settings.yaml`, hot-reloaded, revision-fenced) rather than pi-mcp-adapter's layered `.mcp.json` files, while still adopting the standard `mcpServers`-shaped JSON so configs paste over from pi, Claude Desktop, Cursor, or VS Code. See [ADR 0002](./docs/adr/0002-config-in-dsh-settings-namespace.md) for the reasoning. The v1 end-to-end verification lives in [docs/verification/v1-e2e.md](./docs/verification/v1-e2e.md).

## Install

Requires the `dsh` CLI and a web profile (the browser GUI you run DSH with).

```sh
dsh plugin --profile web add @auggieteo/dsh-mcp-adapter
```

Then restart DSH. The Settings panel (`⌘,` / sidebar foot) gains an **MCP** section.

### Compatibility

| DSH release | Support |
| --- | --- |
| 0.1.2-rc.1 and newer 0.1.x | Supported. Settings writes go through the typed `remote.settings` face mounted by the `@deepseek-ai/dsh-api-remotes` client bundle. |
| 0.1.1-rc.2 | Supported. The client falls back to the legacy `connection.api.settings` face when its module applies. |
| Anything else | Unsupported. The client fails with an explicit "No DSH settings write API" error instead of a crash. |

Both generations run the same host seam: the peer dependency accepts `@deepseek-ai/dsh-settings` `^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.5-rc.1`, and the Settings page, commands, and tools behave identically on either. The Adapter picks the right face when its client module applies. See [ADR 0009](./docs/adr/0009-dual-generation-settings-api.md).

### Local development

```sh
pnpm install
pnpm build          # produces lib/client.js (required before install)
dsh plugin --profile web add /absolute/path/to/dsh-mcp-adapter
```

During client development, run `pnpm dev` alongside DSH. `dsh-client-hmr` reloads each rebuilt client bundle without a manual refresh.

Host changes need a DSH restart. The web profile disables host HMR for plugin rows.

### Uninstall

```sh
dsh plugin --profile web remove @auggieteo/dsh-mcp-adapter
```

## Usage

### CLI

The Host registers three human commands. A bare `/mcp` or `/mcp status` prints one line per Server: name, live state, cached tool count, and the last message when one is present.

```text
/mcp                        # status of every Server
/mcp status filesystem      # status of one Server
/mcp reconnect filesystem   # close and relist one Server now
/mcp disable hosted         # keep the Config, stop the Server
/mcp enable hosted          # restore the lazy lifecycle
/mcp-auth                   # list every OAuth Server
/mcp-auth hosted login      # start (or print) one OAuth sign-in flow
/mcp-prompt docs review {"path": "src/index.js"}
```

`/mcp reconnect` mirrors the `/mcp-adapter` RPC endpoint: it closes the Server's current connection and lists tools so it reconnects. `enable` and `disable` write the global Config's `disabled` flag — the same write as **Settings > MCP** — say so in their answer, and leave the Server entry otherwise untouched. A Server defined by the workspace `.dsh/mcp.json` is refused, because the workspace entry would shadow a global write ([ADR 0005](./docs/adr/0005-per-workspace-config.md)). An unknown subcommand or wrong argument count answers with `Usage: /mcp [status|reconnect|enable|disable] [server]`; an unknown Server answers with its unknown-server error.

`/mcp-auth [server] [login|logout|status]` drives the OAuth flow described in [OAuth](#oauth). `/mcp-prompt <server> <prompt> [json-args]` fetches one MCP prompt as described in [Resources and prompts](#resources-and-prompts); empty input, invalid JSON arguments, unknown Servers, and failed fetches answer with error text.

### Config

The Host registers one live DSH settings namespace, `mcp`. Its user layer lives under `mcp:` in `$DSH_HOME/settings.yaml`; the Settings > MCP page owns normal edits.

```yaml
mcp:
  mcpServers:
    filesystem:
      command: npx
      args: [-y, "@modelcontextprotocol/server-filesystem", /workspace]
      autoAllow: false
    hosted:
      url: https://mcp.example.com/api
      headers:
        Authorization: Bearer example-token
    github:
      url: https://mcp.example.com/other
      auth: oauth
      scopes: [repo, read:org]
  skillInstall: file
```

Each Server configures exactly one Transport: `command` for stdio, or `url` for streamable HTTP with SSE fallback. Adapter extension fields are `auth` (`headers` by default, or `oauth` for HTTP Servers), `scopes` (OAuth scopes, requires `auth: oauth`), `disabled`, `autoAllow`, `lifecycle` (`lazy`, `eager`, `keep-alive`, or `lazy-keep-alive`; default `lazy`), `idleTimeoutMinutes` (default `10`), and `promotedTools`.

The one top-level Adapter field is `skillInstall` (`file` by default, `runtime`, or `off`); see [Agent skill](#agent-skill).

The schema rejects unknown fields and invalid transport combinations before they reach `$DSH_HOME/settings.yaml`. Each `env` and `headers` value has the DSH `secret` schema role. Wire views retain each key and redact its value.

#### Workspace Config layer

The Host also reads `.dsh/mcp.json` under its workspace root and merges it over the global namespace at resolve time. A workspace Server entry with the same name replaces the global entry wholesale; workspace-only names are added; global-only names pass through. Disable or override a Server from the workspace by defining it there with `disabled: true`.

The workspace file uses the same `mcpServers` shape and validation as the global Config. Unknown top-level keys (only `mcpServers` is allowed) or an invalid Server entry reject the whole layer, which fails closed to the global-only Config with a Host warning; a missing file is an empty layer. Values are never environment-variable-interpolated. The Adapter never writes the workspace file: page edits, imports, and API writes all stay on the global namespace, which the workspace file overrides. See [ADR 0005](./docs/adr/0005-per-workspace-config.md).

### Settings page

Open **Settings > MCP** to add, import, edit, reconnect, disable, or delete a Server. The Server list shows live connection state and cached tool counts. The detail panel manages Transport fields, secret values, Auto-allow, the idle timeout, and Promotions. HTTP Servers pick their HTTP authentication mode (static headers or OAuth 2.0 with PKCE) and, for OAuth, enter the scopes to request.

Servers whose Config comes from the workspace `.dsh/mcp.json` show a `workspace` badge in the Server list. Their detail panel explains that the workspace file defines or overrides the Server and disables the save control: edits there write the global layer, which the workspace file overrides. A Server defined only in the workspace file gets a read-only detail panel showing its non-secret Config; for an OAuth Server it offers Sign in / Sign out, because sign-in needs no global Config entry.

JSON import accepts the standard `{ "mcpServers": { ... } }` shape. Import replaces matching Server entries and preserves Servers absent from the import.

Every page write carries the latest namespace revision. Field edits use path mutations.

### Server lifecycle

Each Server's `lifecycle` setting controls when it connects and whether it idles out. `lazy` remains the default.

- `lazy` (default): connects on the first tool-list or tool-call request and disconnects after the idle timeout; the next request reconnects it.
- `eager`: connects when the Adapter starts, when the Server is added or re-enabled, or when its connection Config changes, and still disconnects after the idle timeout.
- `keep-alive`: connects like `eager` but never idles out. When the connection closes unexpectedly, it reconnects after 30 seconds and keeps retrying every 30 seconds until it succeeds.
- `lazy-keep-alive`: connects on first use like `lazy`, but never idles out and auto-reconnects like `keep-alive`.

A `lazy` or `lazy-keep-alive` Server creates no connection at startup. The first tool-list or tool-call request connects the Server and fills an in-memory metadata cache. Promotion discovery is the single documented exception to this startup laziness ([ADR 0003](./docs/adr/0003-promotion-discovery-lazy-exception.md)): when the Adapter starts up or re-enables a Server whose Config lists Promotions, the registry performs exactly one connect to rebuild the native input schema, then the connection follows the normal idle behavior. MCP `tools/list_changed` notifications refresh the cache. The default idle timeout closes the connection after 10 minutes without a request; the next request reconnects it.

Changing, disabling, or removing a Server closes its connection, clears its cache, and cancels any pending keep-alive reconnect; a disabled Server never reconnects. Re-enabling a Server restores the configured lifecycle, so `eager` and `keep-alive` Servers connect again.

### Proxy Tool

The Host registers one global `mcp` tool with seven actions:

```text
mcp({ action: "search", query: "screenshot" })
mcp({ action: "describe", server: "browser", tool: "take_screenshot" })
mcp({ action: "call", server: "browser", tool: "take_screenshot", args: {} })
mcp({ action: "resources", server: "browser" })
mcp({ action: "read", server: "browser", uri: "file:///docs/readme.md" })
mcp({ action: "prompts", server: "browser" })
mcp({ action: "prompt", server: "browser", name: "review", args: { path: "src/index.js" } })
```

Search results use `<server>__<tool>` names to avoid collisions. The first search fills empty metadata caches; later search and describe operations use the cache. Call requests ask for DSH approval unless that Server has `autoAllow: true`.

### Resources and prompts

Servers that expose MCP resources and prompts surface through the `mcp` Proxy Tool. There are no per-resource native tools and no browse UI.

`mcp({ action: "resources", server: "docs" })` lists one Server's resources as `uri`, `name`, `description`, and `mimeType`, plus its resource templates when the Server exposes them. `mcp({ action: "read", server: "docs", uri: "..." })` reads one resource. Text content flows inline through the same output guard as tool calls.

Binary (`blob`) resource content is never inlined as base64; see [Security](#security).

`mcp({ action: "prompts", server: "docs" })` lists one Server's prompts as `name`, `description`, and `arguments`. `mcp({ action: "prompt", server: "docs", name: "review", args: {} })` fetches one prompt and formats its messages as `role: text` lines. The same prompts surface to humans through `/mcp-prompt`.

Resource and prompt metadata is never cached: every action connects lazily and hits the live Server, so results reflect the Server's current state and an offline Server fails with a setup hint.

### Promotion

Add a raw MCP tool name to a Server's `promotedTools` list to register `<server>__<tool>` as a native DSH tool. The native tool uses the MCP input schema and the same approval, call, and output-guard path as `mcp({ action: "call" })`.

Promotion changes apply through `settings/updated`. They do not restart a connected Server. Removing a Promotion unregisters its native tool. Non-promoted tools remain available only through the `mcp` Proxy Tool.

DSH native tool names must match `[A-Za-z0-9_-]` and contain at most 64 characters. The Adapter logs a warning and skips an invalid or colliding Promotion name.

### OAuth

Remote HTTP Servers can authenticate with OAuth 2.0 authorization code flow and PKCE instead of static headers. Set `auth: oauth` on the Server (and optionally `scopes`), then sign in from **Settings > MCP** — the detail panel shows the sign-in state and Sign in / Sign out buttons — or with `/mcp-auth [server] [login|logout|status]`. Selecting `auth: oauth` does not connect by itself: until you sign in, a connect attempt fails fast with a sign-in hint instead of sending an unauthenticated request. Scopes are optional; a provider that defines none accepts an empty list — Context7, for example, serves OAuth at `https://mcp.context7.com/mcp/oauth` and works with no scope requested.

Sign in opens the provider's authorization page in your browser through the DSH web session. The Adapter listens on a local loopback callback, validates the state parameter, exchanges the code, and finishes the flow in the background; the Server then reconnects with the fresh tokens. If the browser blocks the pop-up tab, allow pop-ups for the DSH page, or run `/mcp-auth <server> login`, which prints the authorization URL to open by hand.

The SDK transports refresh expired access tokens through the stored refresh token on the next 401; when no refresh token remains, the Server reports that it needs re-authorization instead of starting a browser flow on its own. Sign out deletes the record and disconnects the Server. Exactly one sign-in flow may run per Server at a time. Token storage and transport details are covered under [Security](#security). See [ADR 0008](./docs/adr/0008-oauth-for-http-servers.md).

### Agent skill

The package bundles a model-facing skill in `skills/mcp-adapter/SKILL.md`, so agents learn the search → describe → call workflow, how to read failure messages (including the OAuth sign-in hint), and which commands belong to the human. The top-level `skillInstall` Config field controls how the Adapter installs it; the mode is read once at Adapter startup, so a change takes effect on the next DSH restart.

- `file` (default): on startup the Adapter copies the bundled `SKILL.md` verbatim to `$DSH_HOME/skills/mcp-adapter/SKILL.md` (an atomic temp-file-then-rename write, never a symlink). The DSH filesystem skill provider discovers the file, so the skill shows under **Settings > Skills > DSH skills** and joins the session catalog without a restart of an already-running session. When the file install fails, the Adapter falls back to the runtime registration below and logs one warning.
- `runtime`: the Adapter registers the skill in memory on the DSH `skills` service only. It reaches agents but never appears on the Settings > Skills page.
- `off`: the Adapter installs no skill.

The installed file is never overwritten. If `$DSH_HOME/skills/mcp-adapter/SKILL.md` already exists, your edit wins: an identical file is left untouched, and a differing file gets one Host warning naming the installed path and the package version. To refresh the installed copy from the package, delete `$DSH_HOME/skills/mcp-adapter/` and restart DSH. Editing the installed file changes what the session catalog serves; the edit survives plugin restarts.

## Architecture

The package ships two faces. The host half (`src/host/`) is plain ESM with no build step; it registers the settings namespace, the manager, the proxy tool, promotions, commands, OAuth services, and the bundled skill. The client half (`src/client/`) is JSX bundled by esbuild (`build.mjs`) into `lib/client.js`, a loader-compatible bundle shaped for `window.__ModuleLoader__.load`. The client declares its service dependencies through `package.json`'s `dsh.client.inject`; `cordis.patch.yml` inserts the host composition row on install.

The host exposes one Connection RPC channel, `/mcp-adapter`, with endpoints `status`, `catalog`, `overview`, `layers`, `reconnect`, `oauth-status`, `oauth-login`, and `oauth-logout`. The Settings page polls `overview` and `layers` for detached snapshots (a `layers` refresh also re-reads the workspace layer); `reconnect` restarts one named Server; the OAuth endpoints drive and report the per-Server sign-in state.

## Release

The package uses Semantic Versioning. Update `package.json` before each release, and list user-facing changes in [CHANGELOG.md](./CHANGELOG.md).

```sh
pnpm version patch --no-git-tag-version  # or minor, major, or an explicit version
pnpm test
```

Merge the version change. Then publish a GitHub Release whose tag is exactly `v<package version>`.

The `Publish to npm` workflow rejects any different tag. It tests and builds the package before publishing with npm provenance.

A prerelease GitHub Release publishes with the npm `next` tag. A regular GitHub Release publishes with the npm `latest` tag.

## Layout

```
cordis.patch.yml   bundle patch: inserts the host composition row on install
src/host/          host half: plain ESM, no build step
src/client/        client half: JSX, bundled to lib/client.js
build.mjs          esbuild wrapper producing the loader-compatible bundle
lib/client.js      build artifact (gitignored), required at runtime
docs/adr/          architecture decisions
docs/verification/ end-to-end verification records
CONTEXT.md         project vocabulary
CHANGELOG.md       released changes
```

## Maintainers

[@auggieteo](https://github.com/auggie246).

## Thanks

[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) by [@nicobailon](https://github.com/nicobailon) — the workflow this project mirrors. The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) team for the plugin surface this builds on.

## Contributing

Feel free to dive in! [Open an issue](https://github.com/auggie246/dsh-mcp-adapter/issues/new) or submit PRs; questions go through the issue tracker.

- Run `pnpm test` before submitting. The suite covers the host, the client settings controller, and the dual-generation settings faces (`test/client-apply.test.js`).
- New project vocabulary belongs in [CONTEXT.md](./CONTEXT.md); design decisions get an [ADR](./docs/adr/) before or with the change.

## License

[MIT](./LICENSE) © The dsh-mcp-adapter authors
