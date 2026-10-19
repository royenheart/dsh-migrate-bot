# Proxy-first tool surface

The Adapter exposes every Server's tools to the DSH agent through one Proxy Tool named `mcp` (search / describe / call) instead of registering every MCP tool natively, mirroring pi-mcp-adapter's headline design. The reason is token economy: registering every MCP tool natively would put hundreds of tool schemas into every model step of every session, whether or not they are used. Native registration stays available through Promotion, a per-tool toggle in Settings > MCP, for tools whose DSH-native card and approval UX justify the context cost.

Considered options: native registration for every server (best per-tool UX, unbounded context cost, rejected); proxy only (strictest pi mirror, no native path at all, rejected to keep the Promotion escape hatch).

Consequences: approval gating for proxy calls must live inside the Proxy Tool's `execute` (DSH does not gate new tools by default), keyed on the server name inside the call arguments, with the per-server Auto-allow toggle consulted there. Promoted tools rely on DSH's native surface instead.
