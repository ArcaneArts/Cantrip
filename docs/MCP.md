# Managed Cantrip MCP

## External MCP discovery

External MCP lets a local MCP client look up Cantrip workspaces, projects,
chats, agents, tasks, workers, and placements. Enable the discovery service on
a local server with `CANTRIP_AUTH_MODE=none` by passing
`--external-mcp-local-port 4314` to `cantrip-server`. The server prints the
selected control origin as `server.external-mcp.listening`. Use port `0` to
let the OS choose the port.

Configure a stdio MCP client to launch the worker with these arguments.

```sh
cantrip-worker external-mcp --server http://127.0.0.1:4314
```

For a Streamable HTTP client, start the bridge and use the loopback URL it prints.

```sh
cantrip-worker external-mcp --server http://127.0.0.1:4314 --http-port 4315
```

Both listeners bind to `127.0.0.1`. Give the MCP URL to clients on the same
machine and keep these ports out of reverse-proxy and port-forwarding rules.
Use `project_list` to find a stable project ID, then pass it to
`agent_list`, `chat_list`, `task_list`, or
`placement_list`. Discovery returns stored metadata for offline workers and
placements. Encrypted display names remain in Cantrip's protected store.
Discovery marks these entries with `labelProtected`.

### Hosted integrations

Sign in to an account-mode Cantrip Server to manage integrations. Use the
account session and its CSRF token for mutations to the integration API.

| Method | Path                                                 | Result                                                                                |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/account/external-mcp-integrations`             | List your grants and their expiration or revocation times.                            |
| POST   | `/api/account/external-mcp-integrations`             | Create a grant and return its credential once.                                        |
| POST   | `/api/account/external-mcp-integrations/{id}/rotate` | Set a new expiration and replace the credential. Send `expiresInSeconds` in the body. |
| DELETE | `/api/account/external-mcp-integrations/{id}`        | Revoke the grant and close its relay connections.                                     |

For example, this create request allows project discovery and worker context for
one project for 24 hours. Replace the example UUID with the project ID shown in
Cantrip.

```json
{
  "label": "Project assistant",
  "permissions": {
    "projects": {
      "kind": "selected",
      "projectIds": ["af64fefd-7f60-4aa6-aca5-006c7bbcb2d7"]
    },
    "scopes": ["projects-read", "placements-read"]
  },
  "expiresInSeconds": 86400
}
```

Use `{"kind":"all"}` for access to all your account's projects. Available
scopes include `projects-read`, `chats-read`, `chats-write`, `tasks-read`,
`tasks-write`, `placements-read`, `files-read`, `codegraph-read`,
`commands-execute`, `cli-read`, and `cli-runs-write`.

Write the returned `credential` to a private file as a single line. On Unix,
make the file owner-readable and owner-writable only (mode `0600`). Configure
the MCP client to launch the stdio bridge with the file path.

```sh
cantrip-worker external-mcp --server https://cantrip.example.com \
  --credential-file /path/to/cantrip-mcp.credential
```

After rotating the credential, replace the file contents and restart the
bridge. Use `project_list` to find a project, then call `worker_context` with
its ID to check the assigned worker. The project must have a live Explorer
placement and the worker must have an approved encryption identity.

Cantrip Server verifies the integration credential and issues a separate,
short-lived WorkerLink grant for the exact integration generation, worker
process, project, and worktree. The headless bridge tries enabled WorkerLink
routes in LOCAL, LAN, WAN, then RELAY order. LOCAL requires the worker's
loopback broker to be accessible from the bridge machine. LAN and WAN use
the server's existing ICE and interface policy. The bridge falls back to RELAY
when a direct route cannot carry the call.

Every carrier carries the request and reply as ciphertext.
The bridge wraps a fresh per-call key to the approved worker's public key.
The worker opens the request with its private key and encrypts the reply under
the per-call key held by the bridge. The existing account encryption keys stay
with their provisioned clients and workers.

### Connect a URL-only MCP client

Run a dedicated bridge on the same machine as a trusted HTTPS reverse proxy.
For an account-mode Cantrip Server with `CANTRIP_PUBLIC_ORIGIN` set to its
HTTPS API origin, configure these additional settings.

| Setting                           | Value                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CANTRIP_EXTERNAL_MCP_PUBLIC_URL` | The exact public resource URL, such as `https://mcp.example.com/mcp`.                          |
| `CANTRIP_EXTERNAL_MCP_BRIDGE_KEY` | A private value with prefix `ctbk_` followed by 32 random bytes encoded as unpadded base64url. |

Provide the same bridge key in a private single-line file readable by the
bridge service account. Start the packaged worker executable in bridge mode.

```sh
cantrip-worker external-mcp --server https://cantrip.example.com \
  --http-port 4315 --public-url https://mcp.example.com/mcp \
  --issuer https://cantrip.example.com \
  --bridge-key-file /path/to/cantrip-bridge.credential
```

On the MCP hostname, forward `/mcp` and
`/.well-known/oauth-protected-resource/mcp` to `127.0.0.1:4315`. Preserve
the public Host header and Authorization header on that hop. The API hostname
serves `/.well-known/oauth-authorization-server` and
`/api/external-mcp/oauth/*` through the normal Cantrip Server HTTPS proxy.
Avoid logging request bodies, credentials, and OAuth query strings. The bridge
listener is loopback-only.

Give the client the public `/mcp` URL. Compatible clients discover the
authorization server, register an OAuth public client, and open a browser
for consent. Sign in to Cantrip and select an existing scoped integration.
The client uses authorization code with PKCE and can refresh access while the
same integration generation remains active. Cantrip validates the token's
audience and issues the bridge a separate short-lived credential for calls to
Cantrip Server. Rotation and revocation invalidate existing OAuth tokens and
close active WorkerLink channels for that integration.

### Delegate and monitor work

Use `agent_list` to find an existing project Agent chat. If you need a new
chat, call `agent_create` with the project ID, an operation UUID, and an
optional title. Call `chat_send` with the chat ID, the message, and its own
operation UUID. Cantrip attributes the message to the integration and admits
it through the chat queue.

Read the transcript with `chat_read`. Use its cursor with `chat_wait` to
watch for messages and status changes. Use `agent_read` to inspect the
chat's placement and recent native subagents.

To schedule work, call `task_create` with a description and a new operation
UUID. Pass `start: false` to keep it as a draft, then use `task_start` to
queue it. Use `task_status` or `task_wait` with the returned task ID.

For hosted integrations, grant chat and task read or write scopes separately.
The responsible worker needs existing chat, task, and private label encryption
grants for the actions that use that content. Reuse an operation UUID only for
an identical request, including a retry after a lost response. Wait calls can
run for up to ten seconds. After a timeout, use the latest cursor for another
wait. Work already admitted continues under Cantrip's normal controls.

### Inspect project files and CodeGraph

Use `directory_list` for checkout entries, `file_metadata` for a single entry,
`file_read` for UTF-8 text, and `file_search` to find filenames. Paths are
relative to the selected checkout. The default is the project's Explorer
checkout. Call `placement_list` to find another checkout and pass its
`worktreeId` to any inspection tool.

Pass `nextCursor` back to `directory_list` with the same checkout and path to
read the next page. If the directory changes, start again without the cursor.
Use `nextOffset` from `file_read` as the next byte offset until it returns
`null`. Files larger than a single page are read in chunks. Links are listed
as links. Directory traversal and file reads stay inside the selected checkout.

With `codegraph-read`, use `codegraph_status` to check the selected checkout's
index, then `codegraph_query` with `kind` set to `symbols`, `references`, or
`context`. Queries use the index maintained by the assigned worker. Check that
CodeGraph is enabled for the checkout in Cantrip, and wait for any pending index
updates before querying.

### Execute a command or invoke the Cantrip CLI

Worker commands require `commands-execute` and an enabled workspace execution
policy. Find the project's workspace ID in `GET /api/workspaces`. An account
owner can read or set its policy at
`/api/workspaces/{workspaceId}/external-mcp-execution` using `GET` or `PUT`.
Send `{"policy":"read-only"}` to allow sandboxed reads, or
`{"policy":"workspace-write"}` to also allow checkout writes. Workspaces
start with `{"policy":"disabled"}`. These policies also apply to local MCP.

Call `command_start` with a project ID, operation UUID, executable, and
argument array. For example, use `executable: "grep"` and
`args: ["TODO", "src/main.rs"]`. Supply a checkout-relative `cwd` to run
from a subdirectory and a `worktreeId` to select a checkout explicitly.
The worker runs the command in the installed Codex sandbox with network
access disabled. Commands use the worker platform's available sandbox and
process-tree supervision. Each command has a timeout of at most two minutes.

Use the returned `commandId` with `command_status`, `command_wait`, and
`command_cancel`. Pass `afterRevision` to wait for a change, or omit it to
wait for completion. Use `command_output` to read the retained text and pass
`nextOffset` back to continue. When old output has been discarded,
`outputTruncated` is set and `outputStart` identifies the earliest remaining
byte. The worker retains command receipts for up to seven days. A restart
preserves the receipt and any recorded exit status, while text remains
available during that worker process generation.

With `cli-read`, call `cantrip_cli` with a typed command such as
`{"name":"context"}`, `{"name":"target_list"}`, or
`{"name":"run_status","configurationId":"…"}`. Read commands for a Git
checkout also include `worktree_list` and `worktree_status`. Run commands
support listing, inspecting, and reading bounded logs for existing
configurations.

With `cli-runs-write`, call `cantrip_cli_run` with an existing Run
configuration ID, an operation UUID, and the action `start`, `restart`,
or `stop`. Start and restart require `workspace-write` and use the existing
Run configuration lifecycle, including its configured environment and
authorization. Scope the integration to the projects it needs.

## In-chat MCP

Cantrip gives every project Agent chat and standalone Chat a worker-owned MCP
server named `cantrip`. One server implementation is exposed through two
profiles: IDE/project agents receive the full catalog, while standalone Chat
receives only `tool_help`, `web_search`, and `web_read`. The full profile is the
preferred agent interface for Cantrip-owned context, Policies, Run
configurations and runtimes, worktrees, execution targets, surfaces, and
bounded client controls.
Normal repository reads, edits, commands, and Git operations still use normal
shell, file, and Git tools. The worker-authenticated [`cantrip` CLI](CLI.md)
remains available to humans, scripts, diagnostics, and agents whose MCP runtime
is unavailable.

The MCP process runs on the worker that owns the Codex runtime, not on Cantrip
Server. This keeps the STDIO transport, runtime dependencies, local execution
context, and sensitive binding document beside Codex. Server-owned authorization
and cross-worker routing remain authoritative.

## Architecture

```text
Codex App Server
    │ MCP over STDIO
    ▼
worker: dist/mcp/stdio.js
    │ authenticated HTTP on a random 127.0.0.1 port
    ▼
worker: bounded MCP broker
    ├─ worker-owned worktree and protected-surface adapters
    └─ worker credential → Cantrip Server /api/internal/agent-operations
                              ├─ authoritative binding revalidation
                              ├─ target-worker routing when required
                              └─ ephemeral client request
                                      │ authenticated app-live WebSocket
                                      ▼
                                  active Cantrip app
```

For each attached chat lane, the worker creates an expiring binding and writes
an atomic connection document below its private data directory. On POSIX hosts,
the directory is mode `0700` and the regular, non-symlink document is mode
`0600`; the MCP host verifies ownership and permissions before reading it. The
document contains only the loopback broker endpoint, a random binding ID and
credential, protocol version, and expiry. Codex receives the document path as
the `--connection` argument; the credential is not put in environment variables
or MCP configuration returned to the app.

The worker synthesizes the reserved `cantrip` server after removing any
user-configured server that attempts to shadow a Cantrip-managed name. Codex
spawns it with the worker's current Node runtime. A new binding replaces the
previous binding for that chat and expires after six hours. Project bindings
are rejected when the worker, owner, project, chat, execution lane, worktree,
permission profile, or active execution status no longer matches. Standalone
bindings instead carry the Chat identity and its worker-owned scratch root and
cannot contain project, worktree, or project-lane claims. Worker startup clears
orphaned binding documents; revocation and shutdown remove live documents.

Every call is schema-bounded at MCP, broker, worker/server, and result
boundaries. The broker uses constant-time bearer comparison, permits at most
four concurrent calls per binding, rechecks the allowed-operation set, caps
request and response sizes, and binds only to `127.0.0.1`. Cantrip Server derives
the owner and worker from the worker credential, reloads the current chat lane,
and independently checks expiry, permission profile, operation allowlist, and
lane identity before dispatch.

Successful tool calls use the human-readable `summary` as their text content
and carry the complete validated object once in `structuredContent`; they do
not serialize that object into both channels. List tools expose bounded pages.
`worktree_list` omits released lanes and idle suspended Primary lanes by
default, while retaining suspended secondary lanes because those still protect
resumable work. Set `includeLeaseHistory: true` only for explicit lease-history
inspection.

Successful Run configuration mutations are audited against the stable
configuration ID. Runtime output and secret plaintext are not added to audit
records.

## Agent use

### IDE/project profile

1. Call `context_get` first and treat its project, lane, worker, root, worktree,
   permission, binding-readiness, and latest native context-window information
   as authoritative. If it reports `refresh-required`, follow its recovery
   instruction instead of attempting a mutation on the same attachment. If the
   user requests `/compact`, or the remaining window is inadequate for imminent
   high-volume work, call `context_compact` and end the turn immediately. The
   worker runs native compaction only after the tool-calling turn is idle.
2. Before guessing an argument, call `tool_help` with the known MCP tool name.
   It returns JSON Schema generated from the same Zod validator used at runtime,
   plus bounded examples and terminology notes.
3. Use `policy_list`, then `policy_read` for each summary that requires the
   current full policy.
4. Use `target_list` and `target_inspect`; never guess, cache across bindings,
   or reconstruct opaque target identifiers.
5. Use the target-specific tool. Normal filesystem and Git work stays in normal
   repository tools.
6. Use `run_configuration_list` and `run_configuration_get` to obtain stable
   IDs and current revisions. Use detect/create/update/delete for authoring,
   start/restart/stop for lifecycle control, status/read-output for observation,
   and secret-set for encrypted project secret values. Omit `worktreeId` to run
   on Primary; pass an exact ID from `worktree_list` for Run in Worktree. MCP
   never invokes the CLI internally.
7. If a result has `continuationScheduled: true`, end the current turn
   immediately so Cantrip can checkpoint and resume in the selected lane.
8. If managed MCP is unavailable, use `cantrip -h` and the corresponding CLI
   command. Do not retry an expired, stale, or denied binding without refreshed
   chat context.

### Standalone Chat profile

Standalone Chat receives exactly three managed tools: `tool_help`,
`web_search`, and `web_read`. Use `tool_help` for either web tool's exact
schema, `web_search` to discover sources, and `web_read` to retrieve bounded
content. The profile cannot discover or invoke project, worktree, Policy, Run,
client-control, protected-surface, or interactive-browser tools. Its binding is
rooted in the Chat's private scratch directory rather than a project.

New and resumed Codex threads continue to set `dynamicTools: []`. This removes
legacy Cantrip dynamic-tool declarations; it does not disable native MCP tools.
The managed MCP is injected through Codex's MCP configuration and appears in
the runtime customization inventory as **Managed by Cantrip**. Cantrip also
sets Codex's common `web_search = "disabled"` runtime policy for every provider,
so the hosted native search tool cannot compete with the managed search path.
The IDE catalog mixes read and mutation tools, so the server as a whole is not
labeled read only. CodeGraph remains separately labeled **Read only** and is
IDE-only.

## Tool catalog

The IDE catalog attaches read-only and mutation annotations per tool.
Cantrip narrows Codex's enabled tool list to the current
permission profile, so read-only bindings receive the Run configuration read
tools but not authoring, lifecycle, or secret mutations; the broker and server
independently enforce the same boundary. The standalone profile is a strict
three-tool subset, and `tool_help` only advertises tools in the active profile.

| Tool                            | Kind                            | Purpose                                                                                         |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `task_create`                   | Mutation                        | Queue a normal Task from a description using the caller's model, with Goal mode off.            |
| `task_list`                     | Read                            | Page through project Tasks with exact IDs, model, state, and dispatch status.                   |
| `task_status`                   | Read                            | Inspect one or multiple project Task IDs.                                                       |
| `task_wait`                     | Read                            | Wait for all specified Tasks or race until any Task finishes.                                   |
| `chat_list`                     | Read                            | List accessible Agent chats in the current project, with stable IDs and status.                 |
| `chat_read`                     | Read                            | Read bounded text history with agent attribution, paging, and a change cursor.                  |
| `chat_send`                     | Mutation                        | Send an attributed message through another Agent chat's normal queue.                           |
| `chat_wait`                     | Read                            | Wait up to 30 seconds for messages, streaming edits, pause changes, or status changes.          |
| `context_get`                   | Read                            | Return validated task scope plus exact current context occupancy when Codex has reported it.    |
| `context_compact`               | Mutation                        | Schedule native Codex context compaction at the safe idle boundary after the current turn.      |
| `tool_help`                     | Read                            | Return exact generated input JSON Schema, examples, and notes for one Cantrip MCP tool.         |
| `policy_list`                   | Read                            | List bounded summaries of effective Policies in configured order.                               |
| `policy_read`                   | Read                            | Read the current full body for a key returned by `policy_list`.                                 |
| `target_list`                   | Read                            | Page through exact authorized execution targets for the bound project.                          |
| `target_inspect`                | Read                            | Revalidate one listed target and report current placement and availability.                     |
| `run_configuration_list`        | Read                            | List shared stable-ID definitions and diagnostics from Primary.                                 |
| `run_configuration_get`         | Read                            | Read one exact definition and its current revision.                                             |
| `run_configuration_detect`      | Read                            | Detect supported project types and propose definitions without writing.                         |
| `run_configuration_status`      | Read                            | List durable runtime state for one configuration or worktree selection.                         |
| `run_configuration_read_output` | Read                            | Read a bounded protected tail from one exact runtime.                                           |
| `worktree_list`                 | Read                            | Page through worktrees and work-protecting leases without exposing worker filesystem paths.     |
| `worktree_status`               | Read                            | Read bounded Git status for the current or an exact listed worktree.                            |
| `explorer_list`                 | Read                            | List a bounded directory page through an exact Explorer target.                                 |
| `explorer_read`                 | Read                            | Read bounded protected text and its version from an Explorer target.                            |
| `terminal_read`                 | Read                            | Read a bounded protected Terminal snapshot.                                                     |
| `browser_services`              | Read/open-world                 | Discover bounded local HTTP services visible to a Browser target.                               |
| `web_search`                    | Read/open-world                 | Search through the worker-managed search runtime and return bounded normalized results.         |
| `web_read`                      | Read/open-world                 | Fetch and extract bounded page content from a URL or prior search result.                       |
| `web_session_snapshot`          | Read/open-world                 | Return a bounded accessibility snapshot for an exact managed web session.                       |
| `web_session_open`              | Open-world mutation             | Open or resume an isolated managed browser session at an allowed URL.                           |
| `web_session_click`             | Open-world mutation             | Click one generation-fenced element reference in a managed web session.                         |
| `web_session_type`              | Open-world mutation             | Type bounded text into one generation-fenced element reference.                                 |
| `web_session_close`             | Open-world mutation             | Close an exact managed web session and release its ephemeral state.                             |
| `run_configuration_create`      | Mutation                        | Create one revisioned shared definition using its document ID.                                  |
| `run_configuration_update`      | Mutation                        | Update one exact definition with optimistic revision control.                                   |
| `run_configuration_delete`      | Destructive mutation            | Delete one exact definition after revision validation.                                          |
| `run_configuration_start`       | Open-world mutation             | Start the configuration on Primary or an exact requested worktree.                              |
| `run_configuration_restart`     | Destructive/open-world mutation | Stop the active generation and launch the next in the same managed terminal.                    |
| `run_configuration_stop`        | Destructive mutation            | Stop the configuration's complete process tree.                                                 |
| `run_configuration_secret_set`  | Mutation                        | Encrypt and store one project secret value referenced by definitions.                           |
| `worktree_create`               | Mutation                        | Create an agent-owned worktree in the bound project.                                            |
| `worktree_switch`               | Mutation                        | Schedule continuation in an exact authorized worktree.                                          |
| `worktree_release`              | Destructive mutation            | Release a clean secondary lease and schedule continuation on Primary.                           |
| `worktree_remove`               | Destructive mutation            | Remove a clean, unused, agent-created secondary worktree while retaining its branch.            |
| `explorer_write`                | Destructive mutation            | Replace bounded text using the expected version returned by `explorer_read`.                    |
| `terminal_send`                 | Open-world mutation             | Send bounded protected input to an exact Terminal target.                                       |
| `terminal_restart`              | Destructive mutation            | Restart the service owned by an eligible Terminal target.                                       |
| `browser_navigate`              | Open-world mutation             | Navigate a Browser target to a revision-checked HTTP(S) URL.                                    |
| `client_notify`                 | Client mutation                 | Deliver one bounded best-effort notice to a compatible project-active app.                      |
| `client_focus_project`          | Client mutation                 | Ask a compatible app to focus the bound project.                                                |
| `client_focus_surface`          | Client mutation                 | Ask a compatible app to focus an authorized Chat, Terminal, Explorer, Code, or Browser surface. |
| `client_show_interaction`       | Client mutation                 | Ask a compatible chat-active app to show an exact pending interaction without answering it.     |

Unrestricted UI-surface creation is intentionally not an MCP tool. Run
configuration terminals are server-materialized from authorized runtime state
and remain read-only. A generic future `surface_create` still requires a
separate durable design.

See [Run Configurations](RUN_CONFIGURATIONS.md) for the shared configuration
contract, CLI parity, provider behavior, lifecycle, limits, and threat model.

## Client controls

Client controls travel worker → server → client over the already authenticated
application live WebSocket. During live-channel initialization, the app declares
the exact control kinds it supports; omission defaults to no capabilities. The
server selects a connected client owned by the same user and subscribed to the
bound project, preferring the bound chat for interaction focus. Requests carry
a correlation ID and a maximum ten-second expiry. The app returns `applied`,
`declined`, `unsupported`, or `expired`; the server can additionally return
`unavailable` when no eligible client is connected or the chosen client drops.

These frames are deliberately outside the live event cursor, replay ring, and
durable database. Reconnect does not replay focus changes or notices. Duplicate
correlation IDs are acknowledged from a bounded client cache so a retry cannot
apply the same control twice. Capability fields were introduced within live
protocol version 1 and the app/server release is deployed as one compatibility
unit; older clients that omit capabilities safely receive no controls.

## Failure and recovery

- `forbidden` means the binding, current permission profile, or server
  operation allowlist does not permit the call.
- `context_get.data.binding` reports `ready`, `read-only`, or
  `refresh-required`, a bounded list of changed claims, expiry, and one recovery
  instruction. Only `ready` authorizes managed MCP mutations.
- `context_get.data.contextWindow` reports the native thread and turn IDs,
  tokens used, model limit, tokens and percentage remaining, measurement time,
  and whether compaction is already scheduled. Counts remain `null` until Codex
  emits native usage instead of being estimated from unrelated account usage.
- `context_compact` is lane-bound and returns `continuationScheduled: true`.
  The worker releases the active turn before calling `thread/compact/start`, so
  the tool never sends `/compact` as text or attempts an invalid in-turn native
  mutation.
- `expired` or `stale-binding` means the agent must obtain a fresh attachment;
  a retry using the same connection document cannot restore authority. The
  worker latches a stale rejection so repeated calls fail locally without more
  server traffic, then clears that latch when a new or resumed Cantrip turn
  refreshes the binding claims in place.
- `busy`, rate, size, and concurrency failures are bounded backpressure, not a
  reason to bypass the broker.
- A missing or unavailable target requires `target_list`/`target_inspect` and
  may reflect a moved or disconnected worker.
- Client `unsupported` and `unavailable` are normal best-effort outcomes; they
  must not be converted into durable state claims.
- MCP startup fails visibly if the connection document is missing, unsafe,
  expired, malformed, or cannot complete the broker handshake.

## Packaging and verification

The worker package includes `dist/mcp/stdio.js` and all production MCP SDK
dependencies. Standalone workers include `runtime/node` on macOS/Linux or
`runtime/node.exe` on Windows; desktop packages use the shared embedded Node
runtime. Packaging statically requires the regular MCP entry file, then invokes
it with the bundled standalone runtime and expects it to reach its bounded
`--connection` argument check. Native release CI repeats that smoke check on
the `darwin-arm64` and `win32-x64` worker artifacts before archiving them.

Run a packaged smoke check manually with:

```console
node scripts/verify-packaged-worker-mcp.mjs artifacts/cantrip-worker-<target>
```

Runtime support also depends on the pinned Codex App Server accepting native
MCP configuration, exposing `mcpServerStatus/list` for inventory, and preserving
the explicit empty dynamic-tool override on resume. See
[`CODEX_RUNTIME_COMPATIBILITY.md`](CODEX_RUNTIME_COMPATIBILITY.md),
[`LIVE_TRANSPORT.md`](LIVE_TRANSPORT.md), and
[`HOSTED_SECURITY_ARCHITECTURE.md`](HOSTED_SECURITY_ARCHITECTURE.md).

## Messages between Agent chats

The four `chat_*` tools operate on active Agent chats owned by the same account
in the bound project. They use stable Cantrip chat IDs, so the destination may
have a different worker, provider account, or native thread. Standalone Chats,
Tasks, archived chats, and other projects are outside this tool scope.

`chat_send` requires a UUID `operationId`. Reuse it when retrying the same send.
Queue admission and both encrypted transcript records commit in one transaction;
retries retain the original delivery, including after server restart. The target
keeps its current model configuration and permissions. Busy chats queue the
message, paused chats remain paused, and the ordinary queue dispatcher handles
idle chats. No native collaboration tree is created or modified.

The sender sees the full message in a **Sent to [chat] · Agent** bubble. The
recipient sees **From [chat] · Agent**, with an agent icon instead of a human
avatar. These rows remain outside collapsed tool groups, and received messages
cannot be edited and resent as human input. Protected content carries the sender
and recipient names, IDs, and delivery identity. Model-visible queued input also
identifies the source as another agent. The server routes only encrypted bodies
and labels; it never needs to decrypt them.

`chat_read` returns chronological messages within a bounded history page. Use
`page.nextBeforeSequence` to read older pages and `cursor` as `chat_wait`'s
`afterCursor`. The change cursor is independent of the requested history page
and includes recent encrypted content revisions, so streaming changes wake a
wait even when no new message ID appears. A wait never starts, resumes, or
interrupts the target. Text output is capped with `maxChars`, prioritizing the newest messages;
attachment and activity payloads are omitted. Pending delivery cards do not
create turn boundaries while another turn is running. Once the queued input
starts, its attributed prompt replaces the receipt in the visible transcript.

## Creating and waiting for Tasks

Project agents can delegate ordinary Tasks with `task_create`. Supply a
`description`, an optional `title`, and a fresh UUID `operationId`. The server
inherits the calling chat's model and reasoning configuration and always queues
direct execution with Goal mode disabled. Task scheduling, capacity limits,
permission checks, and project pause controls still apply. The task title and
description remain encrypted; only the worker opens them. Creation does not
open or rearrange the user's tabs.

Reuse the same `operationId` only when retrying the same creation. The caller
and operation identify one Task, including when the original response was lost
or admission was interrupted. Retrying an existing Task never restarts it.
`task_list` returns project Tasks in bounded pages; `task_status` accepts up to
50 exact IDs. Both include task state, scheduling state, model configuration,
and a `terminal` flag. Deleted, archived, and inaccessible IDs appear in
`missingTaskIds` without exposing another project's Tasks.

Use `task_wait` with `taskIds` and `mode: "all"` to wait for every task, or
`mode: "any"` to return when the first finishes. A final failure counts as
finished, while scheduled automatic retries, queued/running dispatches, paused
tasks, and blocked tasks remain unfinished. Missing IDs return immediately.
`timeoutMs: 0` (the default) holds the tool call until completion, cancellation,
or expiry of the active turn binding. A positive timeout returns the current
snapshot with `timedOut: true`. Waiting does not resume Tasks, and a Task cannot
wait for itself. The broker batches status checks once per second and cancels
the wait when its MCP request disconnects or its execution binding is revoked.
