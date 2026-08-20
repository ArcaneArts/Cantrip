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

## Managed MCP configuration

Cantrip owns MCP server configuration independently from the worker's
`CODEX_HOME`:

- Settings → MCP stores global servers that are inherited by every project.
- Project Settings → MCP servers stores project-local servers. A local server
  with the same name replaces the inherited definition for that project.
- Project settings can copy a server from another project. The copy receives a
  new id and can be edited or removed without changing its source.

Both stdio commands and streamable HTTP endpoints are validated by the shared
protocol before persistence. Stdio configuration supports argument arrays and
an isolated environment map. HTTP configuration supports static headers,
headers sourced from worker environment variables, and an optional bearer-token
environment variable. Secret values are not shown in server list rows.

The server resolves the effective name-keyed set before dispatching chats,
Codex consoles, workflow execution or generation, and Git agent generation.
The worker translates that set to Codex's native `mcp_servers` configuration
and supplies it through `thread/start` or `thread/resume`. When the effective
set changes for an already-loaded idle thread, the worker unsubscribes and
resumes the thread so Codex rematerializes its native MCP runtime without
editing filesystem configuration.

OAuth remains a native, chat-scoped operation exposed by the customization
panel after the configured server is present on that chat's Codex thread.

## Unified composer discovery

Typing `/` at the start of an otherwise empty chat draft searches one portable
palette containing Cantrip built-in chat commands, Codex skills discovered for
that chat runtime, and the active project's personal and project workflows.
Collisions stay explicit through stable invocation namespaces: built-ins use
`/name`, workflows use `/personal/slug` or `/project/slug`, and skills use
`$name`. Choosing a skill inserts its native mention into the draft; choosing a
workflow opens its server-backed review and launch surface in Project Settings.
The palette does not reinterpret a workflow as a Codex slash command or copy a
skill into Cantrip-owned storage.

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

## Skills settings

App Settings includes a Skills tab for browsing the selected worker and Codex
provider's global skill roots. Project Settings adds its own Skills tab, with
repository skills from `.agents/skills` shown before a separately labeled
Global Skills inventory. This keeps project-owned workflows visibly distinct
from Cantrip-account, worker-user, bundled, and administrator skills.

The app talks only to the server. `GET /api/skills` resolves the requested
provider and optional project source, verifies the project's owning worker, and
asks that worker for a bounded inventory. Supporting files can be browsed and
regular files in project, Cantrip-account, or worker-user skills can be edited.
Bundled and administrator skills are read-only. Deleting an editable skill
moves its complete directory beneath the worker's private `skill-recovery`
directory instead of permanently erasing it.

Skill ids encode only a discovered root and relative skill directory. Every
read, write, and delete resolves the id against a fresh worker-side inventory;
paths outside the selected skill, symbolic-link escapes, new arbitrary files,
binary content, and files larger than 1 MB are rejected. `SKILL.md` edits must
retain non-empty `name` and `description` frontmatter.

External plugin candidates are rejected even when selected. This preserves the
current product boundary instead of reaching plugin operations indirectly
through import before Cantrip implements and validates them.

## Deliberate degradation

- Native multi-agent activity uses Codex's `multi_agent` feature and App Server
  events. Cantrip does not synthesize custom subagent semantics.
- Codex 0.148.0 does not expose a project/personal custom-agent discovery
  method. Cantrip reports that control as unsupported while keeping native
  subagents available.
- Codex 0.148.0 stabilizes its core plugin list/read/install/uninstall methods,
  but Cantrip has not yet implemented or payload-validated those product
  operations. Cantrip therefore continues to report them as unavailable until
  plugin adoption is completed as a separate feature.
- Read and mutation methods are gated separately. For example, skills can
  remain inspectable when `skills/config/write` is unavailable. Validated skill
  writes require both list and write methods, while reviewed imports require
  both detect and import methods.

The raw method support remains visible in the worker runtime compatibility
report for diagnostics; the customization capability response adds the stricter
product-stability policy.
