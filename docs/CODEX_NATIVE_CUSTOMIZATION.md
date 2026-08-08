# Codex-native customization

Cantrip delegates agent-loop customization semantics to Codex App Server. The
server and app never read a worker's configuration filesystem directly. A
worker starts each runtime profile with a Cantrip-owned `CODEX_HOME`, then
normalizes supported App Server responses into the shared protocol.

## Read-only inventory

`GET /api/chats/:chatId/customizations` returns the selected chat runtime's:

- independently gated read and mutation capabilities;
- enabled and disabled skills, scope, source path, and discovery errors;
- the extra skill roots currently set on the isolated runtime process;
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
selected imports uses the separate mutation boundary below.

## Guarded mutation boundary

Cantrip exposes native mutation methods only through chat-scoped server routes.
Every request resolves the chat's worker checkout and isolated runtime profile;
the app never supplies a worker or runtime identifier directly.

- `PATCH /api/chats/:chatId/customizations/skill` accepts an advertised skill
  path and desired enabled state. The worker force-refreshes `skills/list` and
  requires an exact normalized path match before calling
  `skills/config/write`. The native response reports the effective state, so a
  policy override cannot be mistaken for success.
- `PUT /api/chats/:chatId/customizations/skill-roots` replaces the process-wide
  extra-root set. Relative and absolute inputs are canonicalized on the worker;
  every real directory must remain inside the selected project checkout. An
  empty list reverses the change. The setting is confined to the isolated App
  Server process and is cleared when that runtime stops.
- `POST /api/chats/:chatId/customizations/mcp-oauth` starts native MCP OAuth and
  returns its HTTPS authorization URL (or loopback HTTP for a local provider).
  The worker records
  `mcpServer/oauthLogin/completed`; the matching `/mcp-oauth/status` route
  exposes pending, success, failure, or unknown without credentials.
- `POST /api/chats/:chatId/customizations/mcp-reload` calls the native MCP
  configuration reload. Clients should refresh the inventory after completion.
- `POST /api/chats/:chatId/customizations/external-import` accepts only opaque
  ids from a reviewed project preview. The worker runs detection again with
  `includeHome: false`, rejects stale ids, and passes only the newly matched raw
  migration items to Codex. The matching `/external-import/status` route
  normalizes progress/completion notifications to success counts and bounded
  failure summaries; native source and target paths never cross the worker
  bridge.

External plugin candidates are rejected even when selected. This preserves the
production plugin stability policy instead of reaching the same unstable
surface indirectly through import.

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
  remain inspectable when `skills/config/write` is unavailable. Validated skill
  writes require both list and write methods, while reviewed imports require
  both detect and import methods.

The raw method support remains visible in the worker runtime compatibility
report for diagnostics; the customization capability response adds the stricter
product-stability policy.
