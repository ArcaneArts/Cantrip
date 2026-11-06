# Native external Chat imports

The Rust server implements external Codex history discovery and durable Chat
imports. The worker remains unchanged. This domain is part of the ongoing server
replacement; the production default is still the Node server.

## Behavior

The native routes are:

- `GET /api/projects/:projectId/external-chat-history`
- `POST /api/projects/:projectId/chat-imports`
- `GET /api/projects/:projectId/chat-imports`
- `GET /api/chat-imports/:jobId`
- `POST /api/chat-imports/:jobId/retry`

Discovery groups project replicas and worktrees by worker, uses the existing
name/id collation, limits the fleet to 64 candidates, preserves per-worker error
and truncation behavior, and attaches owner-scoped durable import references.
Worker-supplied import annotations are overwritten. Project ownership is checked
before interpreting `includeArchived`, including duplicate query parameters.

Admission resolves every requested destination before creating jobs, preserves
sequential creation and the existing partial-admission behavior, and uses the
Source fingerprint and idempotency rules. The native executor runs at most two
imports concurrently. It owns dispatch and request lifetimes, renews leases,
recovers interrupted work, resumes retryable jobs when workers reconnect, and
drains before database shutdown.

The reading phase requests the external transcript through the worker command
channel. Attachment chunks remain opaque, retain their authenticated fields, and
are verified at the destination. Failed partial uploads are deleted. Canonical
Chat history, runtime/lane bindings, pane membership, attachment rows and the
post-canonical job state commit in one database transaction. Protection runs in
100-message worker batches; SQL insertion uses bounded 500-row batches.

Hydration uses the shared immutable canonical payload implementation. Current
placement, selected/default models, routes, provider accounts, permissions, MCP
servers and runtime capabilities determine execution. An unsupported runtime
can leave a successful canonical import without a managed thread. A successful
hydration must pass digest/snapshot validation and thread synchronization before
its session is attached. Reconnecting after a lost acknowledgment reuses the
worker's existing hydration snapshot.

Post-commit publication preserves the Source ordering: project-scoped
`chat-import-job`, project-scoped `project`, and, once a Chat exists,
project-scoped `chat` followed by chat-scoped `chat-message`. These are
invalidations without content payloads. Public job errors retain only the error
code and retryability; worker error text is omitted.

Malformed create/retry schemas reach the existing generic HTTP 500 handler in
the Source implementation. Rust preserves that behavior. Invalid discovery query
values return 400, and hidden resources preserve their existing 404/409 rules.

## Local executable evidence

All development validation runs locally. GitHub Actions remains reserved for
releases and deployments.

The repository comparison runs both actual SQL repositories against isolated
stores. Each storage mode passed 195 paired observations and 49 complete raw
state comparisons, including actual second-batch unique-constraint rollback,
the 1,000-job history limit, fencing, pre/post-canonical recovery, retry/requeue,
canonical protection and process reopen. The three modes are native PGlite,
external PostgreSQL and managed private PostgreSQL; the Source side uses its
existing supported PGlite/PostgreSQL implementations.

Eleven added protocol roots are compared against the actual current TypeScript
schemas in 5,333 cases, including custom attachment refinements, ordering of
validation issues, defaults, Unicode and malformed inputs. A separate oracle
drives the actual Source executor to capture 501 error settlements, covering
classification precedence, Unicode case folding, UTF-16 truncation, and typed
offline, validation and hydration errors.

The real HTTP/Live harness uses production server services and the unchanged
`WorkerConnection` transport with controlled external history, protection,
attachment and native-runtime replies. Its initial PGlite/anonymous qualification
passed 34 scenarios and 57 public HTTP observations for each implementation.
Scenarios include retry, ownership, idempotency, 103-message protection batches,
opaque attachment streams and cleanup, runtime fallback, actual worker
disconnect/reconnect, immutable history preservation, lost-acknowledgment thread
reuse, and a gated subscription proving the four-event final publication.

The expanded matrix passed on macOS arm64 with Node 24.22.1 and PostgreSQL 17.9:

| Native storage      | Authentication modes     | Paired scenarios | Paired HTTP observations |
| ------------------- | ------------------------ | ---------------: | -----------------------: |
| PGlite              | none, password, accounts |              107 |                      197 |
| External PostgreSQL | none, password, accounts |              107 |                      197 |
| Private PostgreSQL  | none, password, accounts |              107 |                      197 |

Each store additionally passed the real lease/concurrency case: two external
reads remain active through a production lease renewal while a third stays
queued. Concurrent failures preserve atomic publication batches; explicit retries
then perform canonical writes in a controlled order so raw global message
sequences and pane positions can be compared exactly. Each implementation also
survives actual server SIGKILL during reading and hydration, reopens the same
store and port, and reuses the existing worker thread after a lost acknowledgment.
New-epoch startup frames are retained raw; after subscribing, the harness fetches
and compares the actual recovery baseline before comparing subsequent events.

Discovery qualification includes durable import annotations, invalid worker
responses, capability loss, 66 project workers, the 64-worker bound, independent
JavaScript collation expectations, and UTF-16 name/platform truncation. Explicit
canonical retry preserves exact encrypted rows and does not reread or reprotect
the source transcript.

Two defects were reproduced and fixed. Concurrent Rust import tasks could
interleave one another's invalidation batches; publication now holds one service
mutex through the complete batch. An immediate private PostgreSQL restart could
race the old Unix owner's shutdown. A private OS file lock now spans initialization,
postmaster lifetime, shutdown and reap; a replacement waits on the actual lock,
without inferring process identity from a PID file. A deterministic owner-pause
regression fails on the frozen pre-fix binary and passes on the fixed binary.
The complete nine-case PostgreSQL lifecycle suite also passes, including retained
identity/credentials, interrupted initialization, failed promotion, foreground
signals and external-database isolation. Windows ownership remains unchanged;
these local results do not establish Windows or Linux execution.

Reproduce the focused checks from the repository root:

```sh
node scripts/server-rust/cargo.mjs test --lib --test chat_import_contracts
node scripts/server-rust/cargo.mjs clippy --all-targets -- -D warnings
cargo fmt --manifest-path cantrip_server_rs/Cargo.toml -- --check
pnpm --filter @cantrip/server test test/chat-import-jobs.test.ts test/chat-import-batching.test.ts test/external-chat-history-api.test.ts
node --import tsx scripts/server-rust/chat-import-repository-compatibility.mjs --database pglite --report /tmp/chat-import-repository-pglite.json
node --import tsx scripts/server-rust/chat-import-http-compatibility.mjs --database pglite --leases --lifecycle --discovery --report /tmp/chat-import-http-pglite.json
node --import tsx scripts/server-rust/chat-import-http-compatibility.mjs --database postgres --leases --lifecycle --discovery --report /tmp/chat-import-http-postgres.json
node --import tsx scripts/server-rust/chat-import-http-compatibility.mjs --database bundled-postgres --leases --lifecycle --discovery --report /tmp/chat-import-http-bundled.json
node --import tsx scripts/server-rust/postgres-lifecycle.mjs --report /tmp/private-postgres-lifecycle.json
git diff --check
```

The HTTP command runs `none`, `password` and `accounts` authentication unless
`--profile` selects one. `--leases` holds real worker requests across the
production renewal interval and checks the two-import limit in the anonymous
profile. `--lifecycle` runs the crash cases in that profile; `--discovery` adds the
fleet and annotation cases in every profile. The HTTP harness freezes its actual
native executable per run and records its SHA-256, so rebuilding the shared Cargo
target cannot change later authentication cells. PostgreSQL tests accept
`CANTRIP_TEST_POSTGRES_BIN_DIR`; private-server
tests use those local runtime binaries without installing or starting a shared
user database. Reports retain raw SQL state, commands, uploaded canonical bytes,
Live frames, shutdown results and diagnostics. Earlier failed observations are
kept with their original database directories.

The final native checks passed 56 library tests (including the 501-case Source
error oracle), the 5,333-case schema test, strict all-target Clippy, Rustfmt and
changed-file formatting. The nine existing Source API tests pass with their
original timeout; jobs/batching separately passed three tests with one existing
skip. `pnpm check` remains red on Main-identical decomposition limits in
`build-app.ts` (1,531/1,500) and `chat-turn-runtime.ts` (2,286/1,999). The independent
boundary audit also reports the existing `desktopTarget` references in
`cantrip-os-desktop.ts` at lines 341 and 390. Their actual failing reports and
matching Main blob evidence are retained; no assertion or audit was disabled.

## Remaining acceptance

Controlled-worker comparisons do not prove actual endpoint-key encryption,
physical worker file transfer, Codex replay, or an existing client's full import
flow. Those product checks remain required. Additional service/caller
interruption, shared Redis and mixed-server coordination, representative old-data
upgrades, post-write rollback, supported desktop/server platforms, packaged
artifacts and performance acceptance remain part of the full replacement goal.

No production cutover, Winterhold deployment, removal of the Node server, or
worker rewrite is included in this domain milestone.
