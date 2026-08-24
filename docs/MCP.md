# Managed Cantrip MCP

Cantrip gives each applicable Codex chat a worker-owned MCP server named
`cantrip`. It is the preferred agent interface for Cantrip-owned context,
Policies, Run configurations and runtimes, worktrees, execution targets,
surfaces, and bounded client controls.
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
previous binding for that chat, expires after six hours, and is rejected sooner
when the worker, owner, project, chat, execution lane, worktree, permission
profile, or active execution status no longer matches. Worker startup clears
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

1. Call `context_get` first and treat its project, lane, worker, root, worktree,
   permission, and binding-readiness information as authoritative. If it reports
   `refresh-required`, follow its recovery instruction instead of attempting a
   mutation on the same attachment.
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

New and resumed Codex threads continue to set `dynamicTools: []`. This removes
legacy Cantrip dynamic-tool declarations; it does not disable native MCP tools.
The managed MCP is injected through Codex's MCP configuration and appears in
the runtime customization inventory as **Managed by Cantrip**. Its catalog is a
mix of read and mutation tools, so the server as a whole is not labeled read
only. CodeGraph remains separately labeled **Read only**.

## Tool catalog

The catalog contains 36 tools. Read-only and mutation annotations are attached
per tool. Cantrip narrows Codex's enabled tool list to the current permission
profile, so read-only bindings receive the Run configuration read tools but not
authoring, lifecycle, or secret mutations; the broker and server independently
enforce the same boundary.

| Tool                            | Kind                            | Purpose                                                                                         |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `context_get`                   | Read                            | Return the validated project, chat lane, worker, root, worktree, and permission context.        |
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
