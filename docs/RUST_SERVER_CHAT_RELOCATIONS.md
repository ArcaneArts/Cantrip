# Native Chat relocation server

The Rust server implements durable project Chat relocation through its existing
SQL, worker command bus, App Live and replica services. This is a server port;
the production worker remains Node. Desktop packaging still selects the Node
server by default. This milestone does not establish complete replacement or
Winterhold deployment readiness.

## Implemented behavior

The five existing HTTP routes preserve admission, owner isolation, project and
worker capability checks, standalone restrictions, schema errors, idempotency,
history, revision conflicts, retry and cancellation:

- `POST /api/chats/:chatId/relocations`
- `GET /api/chats/:chatId/relocations`
- `GET /api/chat-relocations/:jobId`
- `POST /api/chat-relocations/:jobId/retry`
- `POST /api/chat-relocations/:jobId/cancel`

The repository captures an immutable encrypted Agent or Task transcript, its
canonical digest, model and permission context, required revision and attachment
availability. It retains existing SQL tables and job identities. Placement,
runtime sessions, execution lanes, branch leases and linked terminals commit
together. Stale placement and real branch conflicts preserve the original
resources rather than leaving a partial move.

The production service owns admitted mutations after HTTP caller disconnection,
dispatches at most two relocations per service, renews leases every 30 seconds,
and recovers interrupted work without taking unexpired shared leases. Its
startup, worker connection, periodic recovery and shutdown paths are wired into
the server. Lease ownership and attempt checks remain in the repository.

Execution checks the source and target again, permits only the existing safe
Primary synchronization policy, and queues the actual replica service when
synchronization is required. Attachment relay preserves authenticated ciphertext
and chunk fields, verifies the destination result, and removes partial transfers
on failure. Runtime selection uses the existing model/account eligibility
helpers and target-specific permission and MCP context.

The Rust hydration helper preserves Source canonical JSON encoding, UTF-16 key
ordering, opaque payload bytes and hashes. It uses the existing begin/chunk/
complete protocol and supports worker-reported reuse. Post-commit job and Chat
events preserve the existing scopes and publication order. The independent HTTP
catalog callback can precede or follow an immediate offline failure; both orders
were observed in the Node reference on different databases and are checked as
that explicit partial order.

## Safety corrections shared with Node

Local fault injection reproduced two unsafe behaviors in both implementations.
The same corrections are applied to the existing Node executor and Rust port:

- A backend can commit successfully while its COMMIT acknowledgement is lost.
  If the subsequent ownership lookup also fails, that failure cannot prove the
  target is uncommitted. The executor retains the hydrated target and reports
  the original failure rather than discarding the committed thread.
- An expired execution can finish after recovery has queued or reassigned the
  same job. The newer execution can reuse the same hydrated thread. Cleanup
  checks the current attempt and excludes queued, waiting and succeeded jobs
  so the expired execution does not discard that reused target.

Confirmed cancellation and failed-placement compensation still discard the
uncommitted target. Source runtime cleanup failure after a successful placement
does not undo the durable success.

## Local evidence

All results below were executed locally on macOS arm64. GitHub Actions is not
used for development validation.

- Actual repository comparisons: 205 paired observations and 41 complete SQL
  snapshots per storage mode, across PGlite, bundled PostgreSQL and external
  PostgreSQL. These include real constraint rollback, attempt fencing, recovery,
  attachment availability and same-store process reopen.
- Hydration helper comparison: 32 paired cases, including opaque Agent/Task
  payloads, reused threads, Unicode, chunk boundaries, errors and deadlines.
- Production HTTP/job/Live comparison: 28 scenarios per peer in every storage
  and authentication combination, or 252 paired scenarios across the nine
  combinations. The suites compare HTTP results, worker commands, opaque bytes,
  ordered events and complete SQL snapshots.
- Real service restart, maximum-two concurrency and actual 30-second renewal
  checks pass in all three storage modes with anonymous authentication.
- Active cancellation, actual branch-lease conflict, transactional rollback,
  target compensation and successful retry are exercised through production
  HTTP and job services.
- PostgreSQL tests cover all three authentication modes while a real row lock
  holds placement commit, rejecting unsafe cancellation without changing state.
  Another real table lock holds an admitted snapshot INSERT while its HTTP
  caller disconnects and the server shuts down; the mutation commits before
  clean process exit.
- The commit proxy observes the real backend `COMMIT` completion frame before
  dropping its acknowledgement. A separate case revokes the runtime role's
  SELECT privilege and observes actual PostgreSQL SQLSTATE `42501` for the
  owner-scoped recovery read. Both implementations retain their committed
  target after these faults.
- Recovery fencing uses actual service interruption with `SIGSTOP`/`SIGCONT`,
  lease expiration, production repository recovery in another process and
  public idempotency replay. Both the queued and reassigned cases reuse one
  hydrated thread and preserve the immutable snapshot.

The original failing reports and source copies are retained alongside corrected
results in `.qa/rust-chat-relocations/`. The suites retain disposable databases,
failure diagnostics and clean shutdown outcomes. The repository/hydration,
HTTP matrix and interruption checks have separate evidence scopes.

Focused Source tests and typecheck, 55 Rust library tests, strict all-target
Clippy and formatting pass locally. The broad `pnpm check` remains failed at
the unchanged Node decomposition budgets in `build-app.ts` and
`chat-turn-runtime.ts`. The independent server boundary audit also fails on two
existing `desktopTarget` references in `cantrip-os-desktop.ts`; the same failure
was reproduced against clean Primary with byte-identical source. These failures
are retained as failures, not treated as passing release evidence.

The operation results in these suites are controlled through the unchanged
production `WorkerConnection`. They establish server and wire behavior; they do
not establish full-worker decryption, native thread replay, actual filesystem
attachment transfer, supported-platform packaging or mixed-instance acceptance.

## Reproduction

Use Node 24, the repository dependencies, Rust and local PostgreSQL test binaries.
Set `CANTRIP_TEST_POSTGRES_BIN_DIR` for the PostgreSQL fixture. These are test
dependencies, not the intended end-user installation requirements.

```bash
node --import tsx scripts/server-rust/chat-relocation-repository-compatibility.mjs --database pglite --report .qa/relocation-repository.json
node --import tsx scripts/server-rust/chat-hydration-compatibility.mjs --report .qa/relocation-hydration.json
node --import tsx scripts/server-rust/chat-relocation-http-compatibility.mjs --database pglite --failures --report .qa/relocation-pglite.json
node --import tsx scripts/server-rust/chat-relocation-http-compatibility.mjs --database bundled-postgres --failures --report .qa/relocation-bundled.json
node --import tsx scripts/server-rust/chat-relocation-http-compatibility.mjs --database postgres --recovery-fence --commit-faults --failures --caller --report .qa/relocation-postgres-faults.json
node --import tsx scripts/server-rust/chat-relocation-http-compatibility.mjs --database postgres --profile none --lifecycle --leases --report .qa/relocation-lifecycle.json
```

The signal-based recovery test currently qualifies the local POSIX host only.
`CANTRIP_RUST_SERVER_BINARY` can select an already-built `http-sql-fixture` for
HTTP runs. Without it the harness builds that example. Tests still execute the
selected binary; an override is not evidence of its source or release provenance.

## Remaining acceptance

Full browser/client and unchanged worker execution with actual endpoint keys,
native runtime replay and real attachment files remain required. Shared
Node/Rust instances with Redis, additional cleanup/retry overlap boundaries,
supported platforms, existing-data upgrades, post-write lossless rollback,
performance, desktop/standalone artifacts and default cutover remain part of the
full server replacement goal. This document does not waive those requirements.
