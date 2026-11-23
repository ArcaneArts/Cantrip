# Native project insights and script commands

Rust implements the existing five read endpoints for project repository/folder
statistics, project token usage, project and terminal script-command discovery,
and project Task workload. Node remains the default server. The worker remains
Node, and complete replacement/platform/package acceptance is unfinished.

## Behavior

Repository statistics preserve owner-scoped source selection, connected-worker
preference, the Git versus folder command, the actual 30-second deadline and
response validation. A valid response for the wrong project kind is rejected.

Script discovery validates the operation UUID before reading context. Project
discovery retains default execution placement, explicit worktree selection,
offline/conflict errors and the second placement read before dispatch. Terminal
discovery retains its separate context and rejects Run terminals. Both responses
contain opaque worker-produced ciphertext. Terminal response identities remain
bound to the terminal exactly as in Source. The server never opens script lists.
Actual failed placement/context queries retain Source diagnostics; captured ORM
statements supply diagnostic text only after native SQL has failed.

Usage checks project ownership without parsing unrelated presentation metadata.
It retains lifetime totals, the 365-day UTC lower bound, future daily records,
cached/reasoning counters, deleted provider/model groups, stable equal-total
ordering, and existing agent-time interval rules. PostgreSQL aggregates cross
the JavaScript Number boundary before additions, as they do in Source.

Task workload reads owned, unarchived Tasks, encrypted plans and encrypted
messages through the existing repositories. Pagination expands the nominal
100 messages to preserve the containing user turn, up to the existing boundary.
The response checks that every plan/message belongs to its Task Chat. Reading
workload does not admit work or change Task/chat/message rows.

GET and automatic HEAD ignore request bodies. Unsupported methods retain the
existing unmatched-path response and middleware attribution. Ownership/context
failures outside Source's worker catches remain redacted global failures.

## Executed local qualification

On macOS arm64, all nine Source/Rust database/authentication pairs pass: PGlite,
private PostgreSQL and external PostgreSQL, each with none/password/accounts
authentication. They retain 954 paired HTTP observations, 666 paired command/
state cases, and 18 clean server exits. Actual concurrent 30-second deadlines
pass for all three worker-backed reads on both peers and all three stores.
Database failures use actual temporarily renamed relations, restored afterward.
The suite also checks malformed opaque replies, ownership, UTC/lifetime usage,
deleted/tied breakdowns, unsafe totals, 125-message whole-turn pagination and
unchanged durable Task state after reads.

The existing browser APIs and complete worker pass six single-server cells plus
all four Redis pairings: Node/Node, Node/Rust, Rust/Node and Rust/Rust. These ten
cells retain 110 product steps, 28 clean server exits and 30 clean worker stops.
They decrypt actual project/terminal script commands and a retained encrypted
Task draft through workload, reject a modified worktree encryption binding, and
repeat reads after server/worker restart. Raw HTTP responses retain ciphertext.
The larger Task message/plan execution matrix remains a separate acceptance
requirement; this product scenario creates an encrypted draft.

The actual spawned Rust processes use version `1.1.2757`, 92,263,664 bytes,
SHA-256 `ec9f126f8551ae1188fc44f3bb377bcc8554ea64da6a37e604ea9457966dc934`.
The production inventory completes 584 requests per peer with clean exits and
16 remaining generic fallbacks: remote desktop/surfaces and computer use.
Its inspection exit remains one while those unrelated routes are unfinished.

The independent generated graph passes 10,836 Source comparisons across three
base graph sizes. All 69 Rust library tests, strict all-target Clippy, generated
contract/source-query comparisons, server/worker builds, boundary/workflow
audits, and formatting/syntax checks pass locally. The standard `pnpm check`
still stops at unchanged Node line limits: `build-app.ts` 1,532/1,500 and
`chat-turn-runtime.ts` 2,336/1,999. Its downstream aggregate checks did not run.

## Repeatable commands

Build current workspace packages, the Node reference and worker first. Use the
existing fixture executable and PostgreSQL/Redis binary environment variables
when supplying those runtimes. Keep one shared Cargo target directory and
disable incremental compilation for this qualification workload.

```sh
node --import tsx scripts/server-rust/project-insights-http-compatibility.mjs \
  --database pglite --timers --report /absolute/path/to/http-report.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database pglite --project-insights --keep-fixture \
  --report /absolute/path/to/product-report.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --project-insights --keep-fixture \
  --report /absolute/path/to/shared-report.json
```

Use `CANTRIP_RUST_SERVER_BINARY` for the HTTP SQL fixture, but
`CANTRIP_TEST_SERVER_BINARY` for the production browser scenario. The latter
records actual spawned executable hashes. Repeat single-server runs with
`bundled-postgres` and `postgres`. Supply `CANTRIP_TEST_CLI_BIN` and
`CANTRIP_TEST_WORKER_PACKAGE` to exercise an existing complete worker package.
Retain raw fixtures and diagnostics before cleanup. Development validation is
local; GitHub Actions remains reserved for releases and deployments.
