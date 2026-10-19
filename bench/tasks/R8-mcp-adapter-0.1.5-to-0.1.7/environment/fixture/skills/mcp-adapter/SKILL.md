---
name: mcp-adapter
description: Drive the user's MCP Servers through the dsh-mcp-adapter Proxy Tool (`mcp`) — search Server tools, describe their schemas, call them, read Server resources, and render Server prompts. Use when a task needs a tool from an MCP Server (for example Context7 docs lookups), when the user mentions MCP Servers, or when an `mcp` tool call fails.
whenToUse: Any time a needed tool must come from an MCP Server, or an `mcp` call returns an error that needs interpretation.
---

# Using the MCP Adapter

The Adapter connects the user's MCP Servers. Each Server is configured by the
human in Settings > MCP (or the `mcpServers` Config) with one Transport: a
stdio command, or an HTTP URL. The Adapter exposes ONE Proxy Tool named
`mcp`; every Server interaction goes through its actions. A Server tool never
appears as a native tool unless the human promoted it — Promotion names look
like `server__tool`.

## Tool workflow — always in this order

1. Search before you call:

   ```json
   mcp({ action: "search", query: "library documentation lookup" })
   ```

   Results come from every connected Server with prefixed names like
   `context7__query-docs`.

2. Describe before the first call of any tool:

   ```json
   mcp({ action: "describe", server: "context7", tool: "query-docs" })
   ```

   The schema is the contract. Never guess argument names or types; re-describe
   when a call fails validation. `tool` accepts the prefixed or the bare name.

3. Call with arguments that match the schema:

   ```json
   mcp({ action: "call", server: "context7", tool: "query-docs", args: { "libraryId": "/org/project", "query": "one focused topic" } })
   ```

   Omit `args` entirely when the schema has no properties. Pass only the
   properties the schema declares.

## Resources and prompts

- `mcp({ action: "resources", server: "<name>" })` lists a Server's
  resources and URI templates.
- `mcp({ action: "read", server: "<name>", uri: "<uri>" })` reads one
  resource. Binary content is materialized to a temporary file and returned
  as a path; text content arrives inline.
- `mcp({ action: "prompts", server: "<name>" })` lists prompt templates.
- `mcp({ action: "prompt", server: "<name>", name: "<prompt>", args: { ... } })`
  renders one template into messages.

## Reading failures

- The first call to a lazy Server connects it on demand; allow a few seconds
  before concluding anything.
- `OAuth authorization required for <server> — sign in via Settings > MCP or
  /mcp-auth`: the Server needs a human sign-in. Tell the human; you cannot
  sign in yourself. Do not retry the call until sign-in completes.
- Transport errors carry the real cause (HTTP status, Server stderr). Report
  the message verbatim to the human; never retry with invented arguments.
- `Unknown mcp action` or a schema rejection means your call shape was wrong:
  re-run `describe` and rebuild the call.

## Boundaries

- A call asks the human for approval unless the Server has Auto-allow enabled.
  Expect the prompt; do not treat it as a failure.
- Server management is the human's job: `/mcp status [server]`,
  `/mcp reconnect <server>`, `/mcp enable|disable <server>`,
  `/mcp-auth [server] login|logout|status`, and the Settings > MCP page.
- A Server absent from `search` results is disconnected, disabled, or not
  configured. Say so and suggest the human reconnect or add it; do not guess
  tool names.
