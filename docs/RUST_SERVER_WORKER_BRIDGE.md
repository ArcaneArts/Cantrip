# Native worker bridge and closing handshakes

The native local bridge now captures connection, command and shutdown diagnostics
through the shared server logger. Its paired reference test also repairs private
inference sequence allocation, abandoned-command callback ordering, zero-grace
offline ordering and insertion-ordered worker shutdown.

Planned shutdown sends an empty WebSocket CLOSE, preserves accepted output and
continues receiving responses until the physical connection closes. Sending
CLOSE alone does not interrupt the bridge generation. Worker upgrades remain
owned through actual TCP cleanup, including authentication that continues using
the database after its socket has closed.

The rejected-credential comparison also repairs premature TCP closure after
1008 Unauthorized. Both that rejection and planned shutdown during blocked
authentication now retain their close handshake. Malformed-frame errors keep
the existing bounded raw-byte drain. The optimized candidate also passes the
production matrix and additional closing-handshake cases described below.

Node remains the default server. The worker remains Node. This local milestone
does not establish full server replacement, supported-platform packaging or
Winterhold deployment readiness.

## Bridge reference

`worker-bridge-diagnostics-oracle.mjs` executes the actual TypeScript
`WorkerBridge`, deadline implementation, service logger and record minimizer.
The native integration test replays 24 scenarios and compares 233 snapshots:

- Full and minimized diagnostics, repetition windows and worker/request identity.
- Exact encoded control packets after validated correlation-ID aliasing.
- Encoding failure followed by a valid request, and attempted sends that fail.
- Success, worker errors, malformed envelopes and binary ingress.
- Ordered events, held asynchronous callbacks and response-arrival duration.
- Waiting/preparing deadlines, event failures, late responses and disabled deadlines.
- Replacement, recovery, identity changes, grace expiry, revocation and shutdown.
- Counters, caller outcomes and observable callback/log ordering.

An invalid command no longer consumes a private inference sequence. Allocation
uses the existing arbitrary-precision integer dependency and occurs in actual
send order. Failed send attempts still consume a sequence. Shutdown visits
connected workers, interruptions and remembered identities in their reference
insertion order.

## Actual wire and process evidence

The current debug artifact passes 40 actual Node/native production process runs.
These include all nine combinations of native PGlite, bundled PostgreSQL and
external PostgreSQL with none/password/accounts authentication. Thirty ordinary
processes exit zero; ten deliberate startup/key failures exit one.

The final optimized executable passes another forty production runs with Rust
started first, plus eighteen dedicated wire/authentication server runs. All
eighteen dedicated processes exit zero. Actual bootstrap responses report
version 1.1.2770. The macOS ARM64 executable is 94,122,160 bytes with SHA-256
`f688067f1d565b104fc9e4415cfbacfe82705a1b019011a11eb02080486f9ef7`.

The production bridge scenarios use the unchanged worker enrollment, credential
store, heartbeat and `WorkerConnection`. Endpoint command effects are controlled;
this does not qualify worker filesystem operations or native execution. Tests
retain actual HTTP error/header request-ID correlation and compare command
records grouped by their validated dispatched IDs.

Lifecycle comparison uses an observed peer disconnect before the server signal.
Connected-server shutdown has separate actual production wire cases. Close ACK,
HTTP drain and application close callbacks can complete in different orders:
both implementations demonstrably emit interruption first when the ACK arrives
while an HTTP command is still pending. The suite does not discard that record
or claim equal whole-server record counts.

Actual connected-shutdown cases establish:

- All three stores send an empty CLOSE and retain TCP while its ACK is held.
- A worker response sent after server CLOSE but before its ACK completes the
  original HTTP request with status 200.
- An early ACK with an unanswered command retains the ordinary fifteen-second
  reconnect grace, then returns the existing 503 disconnected-worker error.
- A never-acknowledged close reaches the actual thirty-second timeout. The
  optimized reference/native cases close after 30,000/30,003 milliseconds.
- A real PostgreSQL credential-row lock holds authentication across SIGTERM.
  TCP remains open until ACK, the server retains database ownership after TCP
  closes, and the original credential usage update commits exactly once after
  the lock is released. No ready frame is emitted after abandonment.
- Rejected credentials send 1008 Unauthorized and retain TCP until the actual
  client ACK, then allow clean server shutdown.

Reserved code 1005 represents an absent status internally and is never encoded
as a WebSocket status code. Explicit earlier close intent remains authoritative.

The Unix native TCP test admits two four-MiB frames, applies a real receive-buffer
limit and observes the first frame before requesting close. It verifies an
actually stalled writer, retained byte reservations, complete ordered payloads,
then empty CLOSE and peer ACK. Accepted send futures survive close notifications;
their reservations remain owned through the actual flush. This is functional
backpressure evidence, not a Node/Rust performance comparison.

The existing real HTTP/WebSocket worker-ingress comparison also passes on
external PostgreSQL, including unchanged worker transport components and raw
malformed/deep input. Its obsolete offline-error expectation was first observed
failing on Node, then updated to the current explicit `worker-command-not-sent`
code. The exact assertion remains in place.

## Local checks and remaining work

Current debug qualification includes all 80 library tests, 16 focused bridge,
budget and ingress tests, strict all-target Clippy, and all sixteen generated
schema/provider-map comparisons. The boundary and retired-workflow checks pass.
All development validation runs locally.

The standard `pnpm check` stops at unchanged Node line budgets: build-app is
1,539/1,500 lines and chat-turn-runtime is 2,336/1,999. The separate repository
budget check reports 2,284/2,000 for native-commands. Actual read-only Primary
checks reproduce those failures, with the three files and both check scripts
byte-identical to the base and current checkout. Later aggregate steps are not
reported as passing.

Set `CANTRIP_RUST_SERVER_BINARY` to the exact candidate and supply the existing
isolated PostgreSQL/PGlite fixture environment before running process cases:

```sh
node scripts/server-rust/cargo.mjs test --lib
node scripts/server-rust/cargo.mjs test \
  --test worker_bridge --test worker_bridge_diagnostics \
  --test worker_command_budgets --test worker_ingress
node scripts/server-rust/cargo.mjs clippy --all-targets -- -D warnings

node --import tsx scripts/server-rust/worker-close-handshake-compatibility.mjs \
  --database postgres --report /absolute/path/close.json
node --import tsx scripts/server-rust/worker-close-handshake-compatibility.mjs \
  --hold-authentication --report /absolute/path/auth-close.json
node --import tsx scripts/server-rust/worker-close-handshake-compatibility.mjs \
  --reject-authentication --report /absolute/path/rejected-auth-close.json
```

Repeat the ordinary close case for PGlite and bundled PostgreSQL. The
`--withhold-ack` and `--ack-before-response` cases exercise real timeout and grace
boundaries. Production records use `log-runtime-server-compatibility.mjs` with
`--worker-bridge-records`; `--scenario` selects one existing case for diagnosis.

Other production consumers and complete product/fault/coordination,
upgrade/post-write rollback, supported artifacts,
performance, Rust-default cutover and production Node-server removal remain
requirements of the original replacement goal.
