# Rust worker maintenance operations

The native server implements these existing maintenance routes:

- `GET /api/workers/:workerId/version`, including automatic `HEAD`.
- `POST /api/workers/:workerId/codegraph/update-check`.
- `POST /api/workers/:workerId/web-runtimes/actions`.
- `GET /api/projects/:projectId/worktrees/:worktreeId/codegraph`, including `HEAD`.
- `POST /api/projects/:projectId/worktrees/:worktreeId/codegraph/sync`.
- `POST /api/projects/:projectId/worktrees/:worktreeId/codegraph/rebuild`.

The server reads the existing owner-scoped worker and ready-worktree contexts,
then dispatches the unchanged worker commands. Worker-local paths remain routing
values; the server does not execute CodeGraph or install worker runtime assets.
The existing managed-folder `worktrees` capability guard runs before worktree
lookup, preserving its 409 response even for a missing worktree.

Version reads check connection availability before dispatch and use the command
bus default deadline. CodeGraph operations retain their five-second deadline;
managed web runtime actions retain their twelve-minute deadline. Dispatch and
response validation failures use Source's caught worker-failure contract,
including its handling of concurrency and rate-limit errors without Retry-After.
Database/context failures retain ordinary application error handling.

Successful worker mutations publish the worker catalog invalidation after HTTP
response completion. Successful worktree mutations publish a project-scoped
worktree invalidation with the requested worktree identity. Read operations and
failed mutations do not publish those events. Accepted work remains owned after
caller loss, using the existing operation coordinator and limited command bus.

Four independently generated contracts supplement the existing CodeGraph status
contract. Native refinements preserve version-component consistency and the
existing managed-runtime action constraints. The implementation adds no protocol
change, database migration, worker rewrite or default-server cutover.

## Local qualification

The integrated Source baseline is `70c714f9a18e98f413336e41375147cc5c97413c`.
`.qa/rust-worker-operations` retains the frozen native HTTP SQL fixtures, their
SHA256 values and native-source manifests. Earlier reports retain the original
`74e88cb22f99ac1f0ba7b349cd7c5f0876aa8e68` baseline.
Qualification runs on macOS arm64 using actual HTTP, App Live sockets and the
unchanged production `WorkerConnection`. Endpoint CodeGraph and runtime effects
are controlled. The development-only SQL fixture uses production server startup
and routing.

The expanded twelve-cell matrix passes PGlite, external PostgreSQL and privately
managed PostgreSQL with development, password, account and standalone-bootstrap
profiles: 798 paired HTTP observations and 759 complete selected SQL comparisons.
The selected domains are workers, credentials, enrollment codes, projects,
sources, worktrees and settings. The standalone profile exercises bootstrap and
worker-token configuration; it does not establish complete standalone deployment
acceptance.

All three stores additionally pass caller destruction after actual worker
dispatch, server/database reopen with retained state and credentials, actual
ordinary command-slot exhaustion while version control remains usable, recovered
capacity, and actual command rate exhaustion. Caught limit failures preserve
Source's absent Retry-After header. Observed concurrency refusals are retained
separately from rate exhaustion; neither is treated as the other.

Additional passing local checks include 883 actual Source value/issue/exact-error
comparisons, 1,968 comparisons across independent base graph sizes, thirteen
worker authentication/bridge/admission/budget regressions, four shared body-parser
tests and eight response-completion tests. The existing Source version API test
passes with nine unselected tests skipped; all five managed-runtime protocol
tests pass. The previous worker-management development/PGlite comparison also
passes. Strict all-target Clippy passes after repairing inherited compilation
errors and an outdated fixture initializer.

The original qualification exposed inherited logging and wire-value compilation
errors; the integrated main branch now contains those repairs. This milestone
updates a missing additive catalog-update field in a development fixture and
simplifies three inherited Task conditions for strict Clippy. Their short-circuit
behavior and SQL remain unchanged. Original failures and baseline byte identity
are retained.

The real twelve-minute holds pass on Source and Rust: timeout HTTP responses
arrive at 720,010.711 ms and 720,010.177 ms respectively. Both retain the actual
App Live JSON heartbeat, reject the late response as a second completion, and
accept the following version command. All 67 common HTTP observations and 64
complete SQL/command/Live cases match. The additional missing-worktree capability
case is independently compared in the current twelve-cell matrix.

The Source long run retains its original baseline; the native long run uses the
integrated baseline. Its v4 binary precedes only the three Task lint expressions;
the source-drift manifest proves maintenance, dispatch, timeout, SQL and Live
sources unchanged. The final v5 binary passes the complete expanded matrix. Four
Task/suspension regression tests also pass, including 8,206 Source Task-input
comparisons. Earlier client header-limit, heartbeat and fixture-constraint
failures remain preserved and are not described as passing.

The broad repository check fails on unchanged Source decomposition limits:
`build-app.ts` 1532/1500 and `chat-turn-runtime.ts` 2336/1999. The independent
boundary audit fails on protected `desktopTarget` references at lines 343 and 392
in unchanged `cantrip-os-desktop.ts`. The app build additionally finds missing
`availableCatalogModelIds` exports in the pinned Source UI. The focused protocol
run retains two public-surface snapshot/discriminator failures and ten passing
tests. The worktree guide's focused app tests pass all 56 tests; its server tests
retain one failing standalone-Chat admission expectation (59 pass), and its worker
tests retain two failing model-capacity expectations (92 pass). Source-only
reproduction and byte identity across 4,192 Source/package files distinguish
these failures from native maintenance routing. These broader checks are not
green.

## Reproduction and remaining acceptance

Use Node 24, build workspace dependencies and run the local comparison:

```sh
pnpm --filter '@cantrip/server^...' --filter '@cantrip/worker^...' run build
node scripts/server-rust/cargo.mjs test --test worker_operation_contracts
node scripts/server-rust/cargo.mjs test --lib worker_operation_contracts_survive_unrelated_base_graph_growth
node --import tsx scripts/server-rust/worker-operation-http-compatibility.mjs --database pglite --lifecycle --report /tmp/worker-operations-pglite.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/worker-operation-http-compatibility.mjs --database postgres --lifecycle --report /tmp/worker-operations-postgres.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/worker-operation-http-compatibility.mjs --database bundled-postgres --lifecycle --report /tmp/worker-operations-bundled.json
```

`CANTRIP_RUST_SERVER_BINARY` optionally selects a frozen HTTP SQL fixture. Use
`--profile development --kind node --long-deadline` and the corresponding
`--kind rust` command to run the real twelve-minute holds concurrently. The long
client uses raw HTTP to avoid a separate five-minute fetch header timeout, while
maintaining the actual App Live application heartbeat. Each test runtime has an
isolated `PGLITE_RUNTIME_DIR`. Reuse a persistent Cargo target directory with
incremental compilation disabled instead of creating a cache per worktree.

Actual browser/full-worker CodeGraph and runtime asset operations, shared/mixed
Redis consumers and supported-platform/package acceptance remain required.
Representative legacy upgrades, post-write Node rollback, performance, desktop
packaging, Winterhold rehearsal and production Node-server removal remain part
of the full replacement goal. Node remains the default server and the worker
remains Node. Development validation runs locally; GitHub Actions is reserved for
releases and deployments.
