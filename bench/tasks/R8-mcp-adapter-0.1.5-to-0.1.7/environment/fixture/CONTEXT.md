# DSH MCP Adapter

A Deepseek Harness (DSH) plugin that connects the DSH agent to MCP servers, mirroring the major features of pi-mcp-adapter. Configuration lives in the DSH web UI under Settings > MCP.

## Language

**Adapter**:
The DSH plugin this repo builds. It owns MCP client connections and exposes their tools to the DSH agent.
_Avoid_: extension, bridge, wrapper

**Server**:
One configured MCP server entry, identified by its name. A server has one transport and produces zero or more tools.
_Avoid_: endpoint, backend, service

**Transport**:
How the adapter talks to a server: stdio subprocess, or remote streamable HTTP with SSE fallback.
_Avoid_: channel, protocol, connection type

**Proxy Tool**:
The single DSH tool named `mcp` that the model uses to search, describe, and call any server's tools. It is the token-efficient default surface, mirroring pi-mcp-adapter.
_Avoid_: bridge tool, gateway tool, dispatcher

**Promotion**:
Turning one MCP tool into a native DSH tool registered in the DSH tool registry, with its own tool card and approval behavior. Controlled per tool in Settings > MCP. Mirrored from pi-mcp-adapter's `directTools`.
_Avoid_: direct tool, native tool, registration

**Auto-allow**:
A per-server toggle that lets that server's tool calls run without asking the user. All other calls ask per call through the DSH approval system.
_Avoid_: trust, bypass, whitelist

**Config**:
The standard `mcpServers`-shaped JSON stored in the adapter's DSH settings namespace, editable in Settings > MCP. Global: one list for every DSH session.
_Avoid_: manifest, registry file

**Lazy Lifecycle**:
The connection policy: a server connects on first use and disconnects after an idle timeout. Opposite of eager connect at startup.
_Avoid_: on-demand boot, cold start
