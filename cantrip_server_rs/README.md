# Native server replacement in progress

This crate is the native replacement for `cantrip_server`. It is **not yet a
complete server or a production deployment artifact**. The authoritative coverage
ledger is [`docs/security/rust-server-coverage.json`](../docs/security/rust-server-coverage.json).
Normal desktop and standalone entrypoints still use the Node server until the
remaining domain, execution, transport, migration and delivery milestones pass.

The current implementation includes configuration, the existing SQL migrations,
authentication/sessions, account security and opaque encryption registries, plus
worker pairing, credentials, heartbeat storage and foundational control sockets.
Storage supports native PGlite, private managed PostgreSQL and external
PostgreSQL. The worker remains Node.

From the repository root:

```sh
pnpm server:rust:build
pnpm server:rust:check
pnpm server:rust:test
pnpm server:rust:compatibility
pnpm server:rust:auth:compatibility
```

The build prints the native executable path. Run it with `--help` for current
options. `--database pglite`, `--database bundled-postgres`, and
`--database postgres` choose storage explicitly. External PostgreSQL uses
`DATABASE_URL`; private PostgreSQL uses `CANTRIP_POSTGRES_BIN_DIR` during this
development milestone. Existing physical JavaScript PGlite directories are
**not** interchangeable with this crate's native PGlite format; legacy conversion
is still unfinished. Use disposable data for development.

Private PostgreSQL on Unix runs under a native owner mode of this executable.
The owner's parent pipe closes after normal shutdown or abrupt server death;
the owner stops and reaps its PostgreSQL child. New Unix clusters are initialized
in staging before promotion. Windows keeps its kill-on-close process job.
`scripts/server-rust/postgres-lifecycle.mjs` exercises actual process death,
retained account/worker state and external database isolation. Current local
macOS results require fresh platform and packaging acceptance.

## Worker compatibility evidence

Build the existing shared packages before executing the development harnesses:

```sh
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/crypto --filter @cantrip/glitch -r build
node node_modules/playwright-core/cli.js install --with-deps chromium
node --import tsx scripts/server-rust/worker-compatibility.mjs --report .qa/rust-server/worker-pglite-http.json
node --import tsx scripts/server-rust/worker-client-compatibility.mjs --report .qa/rust-server/worker-client-pglite.json
```

Repeat both harnesses with `--database bundled-postgres` and `--database postgres`.
Set `CANTRIP_TEST_POSTGRES_BIN_DIR` to the PostgreSQL binaries used by these
disposable tests. Every external database is created privately by the fixture;
the harness does not use a production `DATABASE_URL` inherited from the shell.

The HTTP/socket suite runs the same cases against the real Node and Rust
servers: pairing, ownership, replacement, credential rotation/revocation,
heartbeat and encryption bootstrap, upgrade validation, v1/v2/legacy readiness,
invalid UTF-8/masking/size rejection, reconnect and command deadline behavior.
The external PostgreSQL development profile additionally holds the actual
credential row lock to exercise 32 authentication slots, 1,024 buffered messages,
8 MiB per socket, a 64 MiB process budget, timeout and last-used writes after
client closure. Fault cases restart the fixture against its retained database
between cases so unfinished owner lookups from one case cannot consume the next
case's handshake slots.

Reference-server shutdown drains worker authentication handlers, including those
whose sockets have already closed, before closing the database pool. Ending the
postgres-js pool while authentication transactions are queued can leave reopened
connections alive after `end()` resolves. Shutdown regression tests cover both
credential and owner lookup completion, including a failed owner lookup. Harness
failures retain fixture identity, completed fault cases and primary errors when
cleanup also fails; the shutdown and authentication deadlines remain unchanged.

The browser suite uses real Chromium with the unchanged app API modules and the
unchanged worker enrollment, heartbeat, `WorkerConnection` and credential store.
Its controlled handler implements credential rotation and rejects other domain
commands explicitly. This proves an authenticated browser-to-worker control
operation and automatic credential reconnect, **not** whole app UI or full worker
runtime acceptance. Reports retain the reference server's background resource
commands separately; Rust does not yet implement those resource domains.

Native bridge tests use paused time for event callback ordering, cleared
deadlines, reconnect continuity, stale sockets, identity changes, grace expiry,
shutdown and one-time completion. They supplement the real transport suite.

The worker transport still needs full event/notification schema validation and
persistence, binary relays, App Live, shared coordination and resource/execution
recovery. Process-local invalidation broadcasts are not durable App Live.

`.github/workflows/rust-server.yml` executes native and compatibility suites on
Linux, macOS and Windows. A configured workflow is not passing evidence; record
observed results for the actual milestone head before claiming acceptance.

## Application Live core in progress

The native hub currently implements scoped subscriptions, bounded in-memory
replay, owner cursors, resynchronization, heartbeat/session checks, queue limits
and client-control targeting/acknowledgments. Its actual Node/Rust differential
adapter compares complete emitted messages, closure state, statistics,
publications, control results and effective usage callbacks:

```sh
node --import tsx scripts/server-rust/live-hub-oracle.mjs --report .qa/rust-server/live-hub-oracle.json
```

The current 44 scenarios contain 688 steps, including replay eviction, 128
subscriptions and pending controls, request-history eviction, wrong-peer and late
acknowledgments, revocation, send failures, heartbeat boundaries and JSON edge
cases. Only generated UUID identities are aliased, with their format and
relationships checked. Both adapters cross the same JSON output boundary; the
native runtime starts with a paused, millisecond-aligned clock so timer rounding
does not manufacture protocol differences.

This core is not yet registered as the `/api/live` HTTP route. Actual session and
account socket registries, repository scope authorization, revocation consumers,
resource publishers, coordination and app Live client acceptance remain required.
The adapter is not whole-product or real-network evidence. The HTTP integration
and CI command must be completed before this milestone is delivered.
