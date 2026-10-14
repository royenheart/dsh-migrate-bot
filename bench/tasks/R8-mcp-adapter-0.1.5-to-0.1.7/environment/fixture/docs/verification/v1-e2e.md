# v1 end-to-end verification

Date: 2026-08-30

## Environment

- Package commit: `69f6b16` plus this verification record.
- Install: `link:/Users/augustine/projects/dsh-mcp-adapter` in the `web` profile.
- DSH profile: `/Users/augustine/.dsh/profiles/web`.
- Managed verification server: a fresh `dsh web --no-open --port 0` process.
- Browser: headless Google Chrome through the Chrome DevTools Protocol.
- Fixture: `test/fixtures/mcp-stdio-server.mjs`.

This run did not use a clean `$DSH_HOME`. The profile already contained unrelated model and UI settings. The `mcp` namespace was absent before the test. A separate managed web process loaded the current Host code without interrupting the active development session.

## Build checks

- `pnpm install --frozen-lockfile`: passed.
- `pnpm build`: passed.
- `pnpm test`: 28 of 28 tests passed.
- `git diff --check`: passed.
- `npm pack --dry-run`: passed with a temporary npm cache. The user cache contains unrelated root-owned files.

## Browser checks

1. Opened **Settings > MCP** and confirmed the empty state.
2. Added `e2e-fixture` as a stdio Server through the form.
3. Confirmed `$DSH_HOME/settings.yaml` contained the command, args, defaults, and empty Promotion list.
4. Confirmed the initial Server state was `disconnected` with zero cached tools.
5. Used **Reconnect** and confirmed `connected`, `stdio`, and one cached `ping` tool.
6. Promoted `ping` and confirmed `promotedTools: [ping]` in `settings.yaml`.
7. Started an Agent session and used the Proxy Tool to search, describe, and call `e2e-fixture__ping`.
8. Confirmed the call showed an approval request with the redacted argument preview.
9. Selected **Allow once** and received the exact result `pong`.
10. Enabled Auto-allow through Settings and confirmed `autoAllow: true` in `settings.yaml`.
11. Called the Proxy Tool again and received `pong` without an approval request.
12. Called the promoted native `e2e-fixture__ping` tool and received `pong`.
13. Set `idleTimeoutMinutes` to `0.1` and confirmed an idle disconnect with the tool cache retained.
14. Disabled the Server and confirmed state `disabled` with its cache cleared.
15. Re-enabled the Server and confirmed it became available again.
16. Deleted the Server and confirmed the empty state and `mcpServers: {}` in `settings.yaml`.

## Rough edge

A persisted Promotion needs its MCP input schema after Host startup or Server re-enable. The Promotion registry currently connects that Server to rebuild metadata, then the normal idle timeout closes it. GitHub issue #14 tracks the lifecycle decision and documentation correction.
