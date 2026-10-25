# Rust server replacement

Status: **implementation in progress; not a deployable replacement**.

The full objective is a Node-free Rust server supporting desktop-packaged and
standalone operation, with PGlite, bundled private PostgreSQL, and external
PostgreSQL. The existing app, worker, CLI, browser and mobile contracts remain
the compatibility baseline. Winterhold readiness and desktop packaging are
required before completion. Production deployment is a separate action.

## Foundation

`cantrip_server_rs` currently contains native database execution, the existing
SQL migration chain and Drizzle journal, private PostgreSQL provisioning, and
three HTTP routes: `GET /api`, `GET /healthz`, and `GET /readyz`. Other domains
remain unported. The existing Node service remains the production entry point.

The compatibility harness launches the actual Node service and Rust executable
on ephemeral ports with isolated database roots. It compares JSON bodies,
status codes, content types, HEAD behavior, method handling, unknown routes and
trailing slash handling. Only timestamps and measured latency are normalized;
their types and ranges are validated. It also restarts Rust and requests actual
database readiness. Its report explicitly does not assert full replacement.

The database contracts execute all existing migrations, inspect every journal
hash and timestamp, rerun without replaying migrations, exercise JSONB and bound
parameters, constraints, commit, rollback, cancellation rollback and LISTEN /
NOTIFY, and verify retained data after reopening in a new process. PostgreSQL
tests start a real private cluster and also invoke the executable in external
connection mode. They never connect to a developer's ordinary database.

PGlite candidate: `pglite-rs` 0.2.7 statically embeds Electric's
`postgres-pglite` fork. It reports PostgreSQL 17.5. The current JavaScript
PGlite 0.5.4 reports PostgreSQL 18.3. **Physical directories are not compatible
by assumption. Existing-installation conversion is unfinished.** Native
PostgreSQL owns process-wide stdio and signal state; native tests use separate
processes, and the executable duplicates launcher pipes before initialization.
PL/pgSQL needs backend symbols exported from the final executable on macOS and
Linux. The native runtime and its license/artifact distribution still need
release review and packaging integration.

The Rust command requires an explicit data directory during development. It
uses the canonical `server-db` root and never falls back to a fresh root when
opening the chosen database fails. Bundled mode currently requires a directory
containing PostgreSQL executables; automatic runtime packaging remains pending.

Run from the repository root:

```sh
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol -r build
cargo build --locked --manifest-path cantrip_server_rs/Cargo.toml
CANTRIP_TEST_POSTGRES_BIN_DIR=/absolute/path/to/postgres/bin \
  cargo test --locked --manifest-path cantrip_server_rs/Cargo.toml -- --nocapture
node scripts/server-rust/compatibility.mjs --report .qa/rust-server/foundation-http.json
```

The GitHub workflow executes real tests on Linux, macOS and Windows; scheduled
or configured coverage is not evidence of a passing run. Windows currently
uses the native PGlite crate's GNU target, independently of the desktop Tauri
MSVC target. Cross-platform results must be observed before claiming support.

Local evidence, 2026-10-25, macOS arm64: the database integration scenarios
passed with all 235 migrations and real PGlite process reopen, PostgreSQL 18
private-cluster restart, external-mode executable invocation, cancellation
rollback and notifications. Seven HTTP comparisons plus a Rust restart passed
against the Node service over actual sockets. Rust formatting and Clippy with
warnings denied passed. These are foundation results, not the complete server
or product-flow acceptance matrix.

## Remaining delivery sequence

1. Establish cross-platform foundation results and legacy PGlite logical
   export/import evidence; evaluate native runtime limitations against actual
   operations before selecting final packaged database artifacts.
2. Port configuration, shared wire validation and version/build identity.
3. Port authentication, sessions, tenant authorization, encryption envelopes,
   worker enrollment and revocation.
4. Complete an unchanged app-to-worker operation, including ordered events,
   reconnect continuity and committed App Live notifications.
5. Port durable account, provider, policy, project, workspace, source, worktree,
   file, tab, surface, chat, attachment, usage and administration domains.
6. Port native admission/receipts, history, managed queues, settings/permissions,
   handoffs, Tasks, retries, automations, leases and recovery.
7. Complete streaming, WorkerLink, tunnels, attachments, logs, Redis routing,
   multi-instance failure recovery and any claimed mixed-version rollout.
8. Prove existing-installation upgrades, interrupted conversion and post-write
   data-preserving rollback across the supported storage modes.
9. Integrate desktop supervision, native/container releases, Winterhold
   deployment tooling and the supported platform/storage product-flow matrix.
10. Switch defaults and remove the production Node server after acceptance.

Every current route, worker command and durable table in
`security/server-route-inventory.json` remains in scope. Add behavioral cases
as each domain is ported; passing foundation cases does not close other rows.
Also retain the encryption inventories, operational contracts and migration
history as requirements while the implementation changes language.

## Completion evidence

Completion requires merged milestones and an integrated commit, a complete
contract ledger, actual deployment/storage/platform results, migration and
post-write rollback evidence, native/container artifact paths and checksums,
desktop and representative Winterhold deployment results, and representative
performance/recovery measurements. No production runtime path may delegate to
Node, Bun, Deno or the old TypeScript server. Node may remain for the unchanged
worker, frontend builds, compatibility tests and bounded legacy conversion.

No complete replacement, production cutover, existing-data migration,
cross-platform acceptance, packaged release or Winterhold deployment is claimed
by the foundation work.
