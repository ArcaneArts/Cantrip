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
the foundation HTTP routes, version/bootstrap responses, and account/session
authentication. Other domains remain unported. The existing Node service
remains the production entry point.

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

Windows private-cluster startup uses PostgreSQL's own `pg_ctl` restricted-token
launch path. A kill-on-close Windows Job Object owns the launcher and its
descendants, assigned during process creation so startup cannot outrun process
ownership. The Windows integration test abruptly kills the owner, observes the
actual postmaster exit, and reopens the cluster to verify committed data after
crash recovery. This test passed in the observed Windows run linked below;
future changes still require their own execution results.

PGlite candidate: `pglite-rs` 0.2.7 statically embeds Electric's
`postgres-pglite` fork. It reports PostgreSQL 17.5. The current JavaScript
PGlite 0.5.4 reports PostgreSQL 18.3. **Physical directories are not compatible
by assumption. Existing-installation conversion is unfinished.** Native
PostgreSQL owns process-wide stdio and signal state; native tests use separate
processes, and the executable duplicates launcher pipes before initialization.
PL/pgSQL needs backend symbols exported from the final executable on macOS and
Linux. The native runtime and its license/artifact distribution still need
release review and packaging integration.

The Rust command reads the existing server environment configuration, including
auth/deployment/bootstrap modes, hosted startup protections, origins, proxies,
cookies, key rings, limits, WorkerLink policy, TURN and WebRTC settings. The
configuration itself is implemented; the session handlers are now implemented
and the remaining transport domains are unported. CLI host, port, data directory and database options
override their environment settings. Explicit CLI port zero supports ephemeral
process tests; environment ports retain the existing 1–65535 range.

Data paths resolve lexically before native PostgreSQL can change the process
working directory. The default remains `../.cantrip/dev` relative to the launch
directory. The canonical `server-db` root is preserved; an opening failure never
selects an empty replacement. Bundled mode still needs PostgreSQL executables
through `CANTRIP_POSTGRES_BIN_DIR` or the CLI option until packaging is integrated.

Storage selection uses `CANTRIP_DATABASE_MODE=pglite|bundled-postgres|postgres`.
When unset, a nonempty `DATABASE_URL` selects external PostgreSQL; otherwise
PGlite preserves the existing behavior. Explicit embedded/private modes also
work with hosted configuration while retaining its authentication, key-ring,
origin, proxy and cookie protections. Storage selection is independent from
deployment; this does not assert that the remaining hosted service is ported.

A differential configuration test executes the actual Node parser for 977
scenarios and compares every resulting field or validation error with Rust.
Inputs cover all bounded numeric settings, booleans, Unicode, key rings, nested
policy validation, host/origin/proxy handling, multi-instance quota division,
and error precedence. Executable tests exercise configuration rejection before
storage writes, CLI precedence, relative paths and real PGlite process reopen.
The Node oracle is development-only and is not called by the server executable.

Run from the repository root:

```sh
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol -r build
node scripts/server-rust/build.mjs
CANTRIP_TEST_POSTGRES_BIN_DIR=/absolute/path/to/postgres/bin \
  node scripts/server-rust/cargo.mjs test -- --nocapture
node scripts/server-rust/compatibility.mjs --report .qa/rust-server/foundation-http.json
```

The GitHub workflow executes real tests on Linux, macOS and Windows; scheduled
or configured coverage is not evidence of a passing run. Windows currently
uses the native PGlite crate's GNU target, independently of the desktop Tauri
MSVC target. Cross-platform results must be observed before claiming support.
The build tooling points the compiler at Cargo's resolved, checksummed native
artifact package. This works around the upstream 0.2.7 build scripts checking
only for an uncompressed archive, overlooking their published `.a.zst`, and
falling back to a nonexistent Windows release download. The actual compiler
and runtime tests still execute; no declared capability substitutes for them.

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
2. Finish shared wire validation, version/build identity and runtime logging;
   configuration parity is implemented and requires cross-platform acceptance.
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

The machine-readable ledger is `security/rust-server-coverage.json`. Every
inventory row inherits its category's explicit default until overridden.
Applying a table's schema does not establish its domain behavior; local tests
and configured CI do not establish platform acceptance.

## Completion evidence

Completion requires merged milestones and an integrated commit, a complete
contract ledger, actual deployment/storage/platform results, migration and
post-write rollback evidence, native/container artifact paths and checksums,
desktop and representative Winterhold deployment results, and representative
performance/recovery measurements. No production runtime path may delegate to
Node, Bun, Deno or the old TypeScript server. Node may remain for the unchanged
worker, frontend builds, compatibility tests and bounded legacy conversion.

No complete replacement, production cutover, existing-data migration,
packaged release or Winterhold deployment is claimed by the foundation work.

## Account and session milestone

The current implementation adds the existing `/version`, `/api/bootstrap`, and
eight authentication endpoints: registration, login, session lookup,
reauthentication, mobile grant creation/exchange, logout and logout-all.
Authentication modes, origin/CORS/security headers, body parsing and limits,
account pins, session-cookie conflicts, CSRF, rate limits, configured
administrators, owner/member provisioning and security audit writes are ported.

Password hashing uses the existing Argon2id parameters and accepts retained Node
hashes; Node also verifies Rust-produced hashes. Session token and CSRF hashes,
secure/partitioned cookies, mobile code formats and single-use transactions
retain their existing contracts. Session revocations publish internal events;
the live, WorkerLink and attachment transports still need implementations that
consume those events before transport-wide revocation can be considered done.

The Rust build embeds metadata from the authoritative existing version resolver
at build time. Node is a build dependency, never a server runtime dependency.
Wire responses retain the protocol schema's existing validation and field
stripping, including its rejection of suffixed synthetic versions.

Native database error statements are suppressed at the engine boundary. Tests
execute an invalid SQL statement containing a private sentinel and inspect the
native process output and private PostgreSQL log for disclosure. Query errors
remain available to callers; this does not complete the remaining operational
logging APIs or their broader privacy acceptance.

The socket harness runs the actual Node and Rust servers against independent
fixtures. Profiles cover anonymous, password and account modes, secure dual
cookies, licensing, trusted proxies and rate limits. It compares full response
bodies and security/cookie/CORS headers, validates entropy and CSRF derivation,
and checks identities, sessions and expiration consistency across restarts.
The same scenarios can run with PGlite, private PostgreSQL or external
PostgreSQL. No scenario connects to an ordinary developer database.

An external-PostgreSQL transition scenario uses one disposable populated
database sequentially: Node creates an owner/session, Rust retains them and
creates accounts/mobile sessions, Node reads those writes and verifies Rust
password hashes, then Node observes Rust session revocation. This establishes
account/session compatibility after Rust writes, not full-server rollback.

Run the socket matrix with a PostgreSQL binary directory supplied for the two
PostgreSQL modes:

```sh
pnpm server:rust:auth:compatibility --report .qa/rust-server/auth-pglite-http.json
pnpm server:rust:auth:compatibility --database bundled-postgres --report .qa/rust-server/auth-bundled-http.json
pnpm server:rust:auth:compatibility --database postgres --report .qa/rust-server/auth-external-http.json
```

The test-only `database-fixture` example owns isolated PostgreSQL clusters for
the Node reference and external mode. It is not distributed with the server.
The native repository tests additionally cover concurrent mobile consumption,
legacy CSRF rotation, settings/workspace provisioning, configured-administrator
updates and PGlite/PostgreSQL retained state. Request-schema tests execute the
actual TypeScript protocol schemas rather than reproducing their expectations.

The session milestone merged as [PR 2277](https://github.com/ArcaneArts/Cantrip/pull/2277),
commit `d759084a30cba3e8641878bd51b69a7c936c4155`. Its
[observed workflow run](https://github.com/ArcaneArts/Cantrip/actions/runs/40254773601)
passed on Linux, macOS and Windows, including all three database socket suites,
retained-state tests, configuration contracts and database/process recovery.
This establishes that milestone's platform results, not full product readiness.

## Encryption registry and account security

The current slice adds the account encryption profile, initialization,
migration-status updates, password rewrapping, principals, approvals,
revocations, and grant APIs. It stores existing opaque envelopes and their
metadata in the original schema. Password-hash and wrapper changes commit
atomically under the existing profile revision check. Revoking a principal
cascades to its active grants; retained revoked grants still prevent duplicate
component/revision inserts. Worker-principal repository operations retain
credential/owner checks and atomic identity rotation, while the worker
enrollment/bootstrap HTTP integration remains unported.

Account session lists, owner/admin audit queries and license-whitelist APIs
are also present. Session connection indicators currently cover the current
session; additional connected sessions require the remaining live transport.
Mutation auditing covers the existing account/encryption responses. The final
streaming lifecycle still needs to attach audit completion after body delivery,
matching Fastify's `onResponse` timing.

`contracts/security.json` is generated from 36 actual protocol exports by
`scripts/server-rust/contracts.mjs`. The native validator preserves defaults,
stripping/strictness, issue paths/order/messages, coercion, unions and explicit
custom refinements. Unknown exporter operations fail the development export;
normal server startup never invokes the exporter or JavaScript. Differential
tests execute the actual protocol independently, compare the generated manifest
and run 27,252 mutation cases, including lone UTF-16 code units in keys and
values. The native JSON representation retains UTF-16 and JavaScript number and
property-order semantics. A further 69,647 JSON round trips compare every
UTF-16 code unit and deterministic floating-point edge cases with Node.
Global malformed/deep-JSON behavior and the remaining domains' schema semantics
still require acceptance; these counts do not close those contracts.

The security socket harness compares entire responses, security/cache/CORS
headers, cookies, errors, tenant boundaries, revision conflicts and retained
state. It uses the existing client crypto implementation to create real HPKE
and password wrappers, fetch and decrypt them, change passwords without
changing the master key, reject wrong-owner/tampered wrappers, and repeat after
restart. External PostgreSQL additionally runs Node initialization, Rust
password/wrapper writes, and Node reopening those writes with the original
client keys. This is encryption/account evidence, not full-server rollback or
legacy PGlite conversion.

```sh
node --import tsx scripts/server-rust/security-compatibility.mjs --report .qa/rust-server/security-pglite-http.json
node --import tsx scripts/server-rust/security-compatibility.mjs --database bundled-postgres --report .qa/rust-server/security-bundled-http.json
node --import tsx scripts/server-rust/security-compatibility.mjs --database postgres --report .qa/rust-server/security-external-http.json
```

Supply `CANTRIP_TEST_POSTGRES_BIN_DIR` for the PostgreSQL fixtures. These
databases and the client key material are disposable. Linux/macOS/Windows CI
executes the same tests; configured checks are not passing evidence.

Worker enrollment/control, live transports, account usage and other resource
and execution domains, usable legacy conversion/rollback, desktop packaging and
Winterhold delivery remain required work.
