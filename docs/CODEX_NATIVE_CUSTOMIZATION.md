# Codex-native customization

Cantrip delegates agent-loop customization semantics to Codex App Server. The
server and app never read a worker's configuration filesystem directly. A
worker starts each runtime profile with a Cantrip-owned `CODEX_HOME`, then
normalizes supported App Server responses into the shared protocol.

## Read-only inventory

`GET /api/chats/:chatId/customizations` returns the selected chat runtime's:

- independently gated read and mutation capabilities;
- enabled and disabled skills, scope, source path, and discovery errors;
- configured hooks, trust state, source, warnings, and errors; trusted or
  managed hook commands are visible, while modified/untrusted commands are
  redacted; and
- paged MCP server status, authentication state, tools, resources, and resource
  templates.

Use `?refresh=true` to ask Codex to bypass its skill cache. This refreshes
discovery only; it does not edit a skill or configuration.

`POST /api/chats/:chatId/customizations/mcp-resource` reads one advertised MCP
resource through Codex. Cantrip limits the normalized response to 5 MB before
it crosses the worker bridge.

## External configuration preview

`GET /api/chats/:chatId/customizations/external-preview` calls
`externalAgentConfig/detect` with `includeHome: false` and only the chat's
resolved project checkout. Home-scoped and other-project results are discarded
again during normalization. The response contains opaque item identifiers and
review summaries, not session paths or arbitrary source payloads.

This endpoint is only a preview. It cannot import or mutate anything. Applying
selected imports is a separate, explicit control added behind the mutation
boundary.

## Deliberate degradation

- Native multi-agent activity uses Codex's `multi_agent` feature and App Server
  events. Cantrip does not synthesize custom subagent semantics.
- Codex 0.146.1 does not expose a project/personal custom-agent discovery
  method. Cantrip reports that control as unsupported while keeping native
  subagents available.
- Although 0.146.1 advertises plugin methods, the official App Server contract
  marks plugin list/read/install/uninstall as under development and says
  production clients must not call them. Cantrip therefore reports every
  plugin operation as unavailable instead of invoking an unstable surface.
- Read and mutation methods are gated separately. For example, skills can
  remain inspectable when `skills/config/write` is unavailable.

The raw method support remains visible in the worker runtime compatibility
report for diagnostics; the customization capability response adds the stricter
product-stability policy.
