# Shared-server product acceptance

`actual-folder-client.mjs --database postgres --server-pair all` runs the
existing encrypted application SDK scenarios across four real server pairings:
Node/Node, Node/Rust, Rust/Node and Rust/Rust. The first peer serves the browser;
the full unchanged Node worker connects to the second. The driver checks the
actual Redis worker claim to prove that commands cross the server boundary.

Each pairing owns an isolated PostgreSQL database, Redis process, server
profiles, browser context and worker directory. Node peers use the compiled
production `cantrip_server/dist/index.js` entry point. Rust peers use the normal
server executable. No fixture routes, command-handler replacements, worker
acknowledgment substitutes or SQL-seeded product state are needed for these
scenarios. Public model HTTP responses are controlled when exercising the real
native Codex runtime.

## Running the scenarios locally

Build the browser dependencies and Node comparison implementation:

```sh
pnpm install --frozen-lockfile
pnpm --filter '@cantrip/app^...' build
pnpm --filter '@cantrip/server...' build
```

Use an existing full worker distribution to retain its matching native runtime,
PTY bindings and CLI. Optional absolute-path overrides reuse already-built
artifacts; the programs are executed normally and their actual results decide
success. Omitting the server or CLI override uses the existing build helpers.

```sh
export CARGO_TARGET_DIR=/absolute/path/to/shared/cargo-target
export CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CANTRIP_TEST_POSTGRES_BIN_DIR=/absolute/path/to/postgresql18/bin
export CANTRIP_TEST_REDIS_BIN=/absolute/path/to/redis-server
export CANTRIP_TEST_WORKER_PACKAGE=/absolute/path/to/packaged/worker
export CANTRIP_TEST_CLI_BIN="$CANTRIP_TEST_WORKER_PACKAGE/bin/cantrip"
export CANTRIP_TEST_SERVER_BINARY=/absolute/path/to/optimized/cantrip-server
```

The PostgreSQL fixture uses a small native cluster-owner executable. Its
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY` override can likewise reuse a built
`database-fixture` example. Keep all Cargo outputs in the shared cache rather
than creating a target for each worktree.

Run each group against separate disposable databases:

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --rolling-servers --keep-fixture \
  --project-surfaces --file-documents --workspaces --terminals --worker-links \
  --report .qa/shared/resources.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --rolling-servers --keep-fixture \
  --tasks --report .qa/shared/tasks.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --rolling-servers --keep-fixture \
  --project-chats --agent-tasks --report .qa/shared/agent-tasks.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --rolling-servers --keep-fixture \
  --project-chats --report .qa/shared/chats.json
```

`--server-pair node/rust` selects one pairing for diagnosis. Existing invocations
without this option retain their separate Node/Rust single-server behavior and
all three storage modes. Shared product runs use account authentication and
external PostgreSQL; this does not imply concurrent ownership of one embedded
PGlite profile.

The test Vite instance pre-bundles the optional workspace imports that otherwise
reload a cold browser halfway through the scenario. Application code, protocol
validation and behavioral assertions are unchanged by that setup. Managed Agent
submissions assert the production route's exact `queued` result and decrypted
prompt identity/text. The old non-Task scenario expected immediate `started`,
although the existing managed-session route durably queues new GUI input.
Native response counts, Goal completion and canonical history assertions remain
strict.

## Replacement and retention checks

The macOS ARM64 `1.1.2881` package and same-source Node reference passed
128 resource steps across all four initial server pairings. All eight
peer replacements retained the original worker process. The browser
kept its encrypted session and App Live continuity and read and wrote
the same 64 KiB test file through both replacement peers. The run also
covered workspace ownership, detached editor drafts, file-document
replay, Git views, terminal snapshots and both encrypted PTY transports.
[Current rolling resource acceptance](security/rust-server-2881-shared-resource-rolling.json)

`--rolling-servers` replaces the application peer with Rust while the full
worker stays connected to its existing owner. It then replaces the worker-owner
peer with Rust and requires a new real connection generation. Both steps retain
the worker PID, persisted credential, browser session and encryption state.
The existing App Live client reconnects with its actual resume state.

After each replacement the application reads and writes an encrypted 64 KiB
file through its Explorer API and the real remote worker. Assertions inspect
the actual saved bytes and reject plaintext paths/content in captured server
requests. Native conversation scenarios additionally require the exact completed
message projection to survive both replacements. An extra binding field must
return the same strict HTTP 400 contract on both implementations.

Managed Agent history is sampled after the real native-history API contains
every observed terminal turn and the live native item events have materialized
in the canonical projection. Synthetic worker supplements retain their original
correlations and remain in the exact comparison. Task conversations use the
durable Task message/receipt pipeline; their entire completed Task DTO and
message projection must remain identical. No DTO fields are removed from these
before/after comparisons.

The original scenarios also retain their restart, idempotency, stale-write,
wrong-checkout, workspace ownership, dirty editor and encrypted PTY checks.
Task scenarios execute the real native runtime for completion, planning/Goal,
failure/retry and paused admissions. Agent scenarios exercise encrypted turns,
native Goal tools, canonical history, console synchronization and full-worker
restart; the separate Agent-to-Task group executes actual native MCP child
Task operations.

`--keep-fixture` retains successful profiles as well as failures. Archive the
reports, logs, private database profiles and tested executable bytes before
removing only the run's owned directories. Profiles contain disposable fixture
credentials and endpoint keys; they are not release assets.

## Observed local results

On November 7, 2026, all four pairings passed each group on macOS ARM64 with
private PostgreSQL, Redis 8.10.3, Node 24.22.1 and the unchanged packaged worker
with native Codex 0.166.0. These are recorded scenario steps, rather than counts
of individual assertions:

| Group                                                   | Steps per pairing | Worker exits | Server exits | Rolling replacements |
| ------------------------------------------------------- | ----------------: | -----------: | -----------: | -------------------: |
| Resources, files, workspace, PTY and WorkerLink         |                31 |           24 |           24 |                    8 |
| Native Tasks, planning/Goal, retry and paused admission |                16 |           24 |           40 |                    8 |
| Agent-to-Task native MCP operations                     |                13 |           20 |           32 |                    8 |
| Agent turns, native Goal and canonical history          |                15 |           20 |           32 |                    8 |
| Total across all four pairings                          |               300 |           88 |          128 |                   32 |

All recorded worker and server exits were zero, with no terminating signal.
The rolling phase retained the original worker PID in every run. Native Task
runs each made eight model requests and retained the complete Task state.
Agent-to-Task runs each retained eight committed native turns; ordinary Agent
runs retained two. Model fixtures recorded no failures. Each rolling operation
preserved an actual encrypted 65,536-byte file through the existing client API.

The qualifying reports are `final-resources.json`, `tasks-canonical-v2.json`,
`agent-tasks-canonical-v3.json` and `chats-canonical-v1.json` in the milestone's
private evidence archive. Earlier failed runs remain there, including cold
Vite dependency reloads, the obsolete managed-turn assertion, an invalid file
binding and an initial live-to-canonical history snapshot. These led to changes
in test setup and observation timing; production server and worker code did not
change in this milestone.

Focused process-fixture tests passed. The root `pnpm check` stopped at existing
Node server line budgets (`build-app.ts`: 1,532/1,500 and
`chat-turn-runtime.ts`: 2,336/1,999); later aggregate stages were not run.

## Scope

These are real product and orderly replacement checks on the observed host.
Completed native work precedes the rolling phase. They do not establish
in-flight Task/chat server-crash failover, lease expiry, delayed acknowledgment,
long Redis outage/recovery, Redis TLS, multi-host networking, other operating
systems, performance or full replacement readiness. Those requirements remain
part of the original goal, along with default cutover and production Node
server removal. The worker remains Node.
