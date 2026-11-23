# Rust worker management

The native server implements the existing worker management routes:

- `GET /api/workers/management`, including automatic `HEAD` handling.
- `PATCH /api/workers/:workerId`.
- `POST /api/workers/:workerId/restart`.
- `DELETE /api/workers/:workerId`.

The catalog preserves owner scoping, runtime-name ordering, active project-source
relationships and separate display/runtime names. Its active credential count
includes expired unrevoked credentials, as Source does. Development bootstrap
workers without credentials remain protected from rename/unlink; standalone
workers follow the existing standalone rules.

Rename retains runtime-reported names and unrelated state. Restart dispatches the
unchanged worker command through the existing limited command bus, validates its
acknowledgment and preserves the ten-second deadline, offline error and quota
headers. Unlink locks the worker and atomically records its tombstone and revokes
all unrevoked credentials. Existing sources, projects and credential history are
retained. Post-commit cache revocation and socket closure precede the availability
event; the worker catalog event follows successful HTTP response completion.

No migration, external protocol change, worker rewrite or default-server cutover
is included.

## Local qualification

Qualification against Source `a689b9d966a5e14855609b6e21923569751516ce` ran
on macOS arm64. The HTTP SQL fixture runs production server startup and routing,
with development-only SQL controls. Both implementations use actual HTTP, App
Live sockets and the unchanged production `WorkerConnection`. Endpoint restart
effects are controlled; this is not full worker supervisor acceptance.

PGlite, external PostgreSQL and privately managed PostgreSQL each pass development,
password, account and standalone profiles:

- 591 paired HTTP observations and 519 complete paired SQL comparisons over
  workers, credentials, enrollment codes, project sources, projects and settings.
- 24 actual cross-owner constraint rejections and 24 actual unlink transaction
  failures after credential updates, with complete rollback and a connected worker.
- 24 concurrent-unlink batches: exactly one success and three not-found replies,
  retained history, revoked credentials and rejection of an in-flight restart.
  Raw traces additionally prove one shared unlink/revocation timestamp and exact
  preservation of every other worker and credential field.
- Six real ten-second restart timeouts, followed by late-reply handling.
- 24 server/database reopens after writes, same-identity re-enrollment, retained
  display names and continued rejection of the old credential.
- 1,436 additional HTTP requests to exhaust actual command quotas. Rename remains
  usable while restart is rate limited; Retry-After is checked against real time.
- Exact ordered worker and availability Live events, status codes, headers,
  validation/error bodies and restart command bodies.

The report family is `http-{pglite,postgres,bundled-postgres}-matrix-v4.json`
under `.qa/rust-worker-management`. The native HTTP fixture SHA256 is
`f7835689439fb778aa371922d51ed7b27cd7e0380af23ad7ea992e7d65c77331`.
Native source manifests are retained with those reports. Earlier failed runs are retained too. The real
comparison found and corrected a missing native response-completion catalog
notification. PostgreSQL test controls now include their actual error chain;
their diagnostic body is separate from production HTTP contract comparisons.

Additional local checks cover 5,396 actual Source validation/error comparisons,
16,188 comparisons across independent base graph sizes, the existing five Source
worker-enrollment API tests, worker authentication/admission/bridge/budget
regressions, eight response-completion tests and strict all-target Clippy.
Integration also resolves equivalent boolean/if-chain Clippy warnings in Main
pagination and its CantripOS fixture; the existing CantripOS HTTP restart test
passes. The full exporter reproduces all
other tracked contract graphs unchanged.

`pnpm check` fails on unchanged Source line budgets: `build-app.ts` 1532/1500
and `chat-turn-runtime.ts` 2334/1999. The independent boundary audit fails on
unchanged protected `desktopTarget` references in `cantrip-os-desktop.ts` at
lines 343 and 392. Source and audit-script byte identity with the pinned baseline
is recorded; neither broad check is described as passing.

## Reproduction and remaining acceptance

Build workspace dependencies, then use Node 24 with the local harness:

```sh
pnpm --filter '@cantrip/server^...' --filter '@cantrip/worker^...' run build
node scripts/server-rust/cargo.mjs test --test worker_management_contracts
node scripts/server-rust/cargo.mjs test --lib worker_management_contracts_survive_unrelated_base_graph_growth
node --import tsx scripts/server-rust/worker-management-http-compatibility.mjs --database pglite --report /tmp/worker-management-pglite.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/worker-management-http-compatibility.mjs --database postgres --report /tmp/worker-management-postgres.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/worker-management-http-compatibility.mjs --database bundled-postgres --report /tmp/worker-management-bundled.json
```

`CANTRIP_RUST_SERVER_BINARY` optionally selects a frozen HTTP SQL fixture. Test
runtimes have isolated `PGLITE_RUNTIME_DIR` directories. Reuse a persistent
`CARGO_TARGET_DIR` with `CARGO_INCREMENTAL=0` for repeated development builds;
creating a separate Cargo cache for every milestone is unnecessary.

Actual browser/full-worker supervisor restart and service ownership, shared/mixed
Redis consumers, supported-platform artifacts and packaged desktop/standalone
acceptance remain required. Representative existing-data upgrades, post-write
Node rollback, performance, Winterhold rehearsal and final Node-server removal
remain part of the full replacement goal. Node is still the default server and
the worker remains Node. Development checks run locally; GitHub Actions is
reserved for releases and deployments.
