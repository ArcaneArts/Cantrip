# Rust foundations for the worker port

This work extracts existing Rust server implementations for reuse by a future
Rust worker. The production server consumes each extracted library. The Node
worker remains the worker implementation throughout this goal.

The baseline is `86f7963df5a87d5da977ff2bcc6f8016a64627ab`, the completed Rust
server replacement. The implementation is delivered in the sequential milestones
below, each through its own worktree, pull request, and observed squash auto-merge.

## Ownership and dependencies

The root Cargo workspace contains `cantrip_server_rs` and `crates/*`. It shares the
server's existing lockfile, dependency patches, release profile, and Rust 1.93
baseline. Desktop, CLI, interaction, CUA, vendored Codex, and third-party crates
retain their independent ownership. The server manifest and binary name remain
valid entry points. Root `cargo build` selects the server by default.

Libraries depend on lower-level libraries, never on the server. They must work as
ordinary path dependencies in an independent Cargo project. PostgreSQL, PGlite,
Redis coordination, HTTP handlers, migrations, and server startup stay outside
their dependency graphs. No crate may hide a server dependency behind its default
features.

| Library                                                  | Existing implementation and boundary                                                                                                 | Future worker consumer                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `cantrip-wire`                                           | `wire/value`, coercion, JSON text, date semantics, text helpers, host locale/timezone snapshot, and canonical history payload digest | Every protocol producer/consumer and worker history publication                       |
| `cantrip-scheduling`                                     | Pure cron/timezone calculations from `project_automations`; scheduler policy and SQL remain server-owned                             | Worker automation schedule calculations                                               |
| `cantrip-protocol`                                       | Generated contract assets, validation engine, refinements, pure capability and execution/identity contracts from `wire`              | Worker requests, events, notifications, encrypted envelopes, and execution validation |
| `cantrip-framing`                                        | WorkerLink, tunnel, and remote-surface binary codecs; no authorization or resource lookup                                            | Worker transport framing and stream adapters                                          |
| `cantrip-config`                                         | Environment-file parsing, readers, and configuration errors; no `ServerConfig` or deployment defaults                                | Future worker configuration parsing                                                   |
| `cantrip-logging`                                        | Structured records, redaction, formatting, buffer/archive management and explicit logging lifecycle                                  | Worker diagnostic and log-stream infrastructure                                       |
| `cantrip-transport`                                      | Existing reusable ordered subscriptions, correlation/deadlines, bounded queues, cancellation and lifecycle mechanisms                | Worker connection and command infrastructure, implemented later                       |
| Filesystem/process library, subject to source inspection | Private writes, atomic publication, and child ownership mechanisms with useful independent boundaries                                | Worker local persistence and child cleanup, implemented later                         |

The wire layer is the bottom of this graph. Scheduling and protocol build on its
semantics; framing builds on protocol. Logging, configuration, and transport may
use the applicable lower layers. No reverse edge may be added to resolve an
extraction difficulty. Tiny related helpers belong in an existing cohesive crate.

The filesystem/process milestone must inspect actual implementation boundaries.
PostgreSQL initialization, profile migration/activation policy, task dispatch,
worker authorization, and durable execution ownership are not reusable worker
mechanisms. Its delivery record must identify what moved and why remaining
server policy stayed in place.

## Milestones and current progress

1. **Wire foundation and workspace — merged in [#3156](https://github.com/ArcaneArts/Cantrip/pull/3156).**
   Move existing wire values, coercion, JSON/date behavior, and canonical digest
   into `cantrip-wire`. Preserve server import paths with re-exports. Move the
   existing focused tests with their implementation. Update Docker build inputs,
   local workspace checks, and development watching for the new layout.
2. **Protocol and pure scheduling — merged in [#3157](https://github.com/ArcaneArts/Cantrip/pull/3157).** Extract generated contracts and
   validation, removing the current back-references into project capabilities
   and automation scheduling. Preserve exporter/oracle ownership and fixtures.
3. **Framing and execution contracts — merged in [#3158](https://github.com/ArcaneArts/Cantrip/pull/3158).** Extract the three binary codecs
   and remaining applicable pure identities/history/execution contracts. Keep
   resource authority in server adapters.
4. **Configuration — implemented and locally validated.** Extract environment readers, environment-file
   parsing, and errors while keeping server defaults and precedence unchanged.
5. **Logging — pending.** Extract records, formatting/redaction, archives, and
   lifecycle with explicit process configuration. Keep HTTP instrumentation and
   authenticated endpoints in the server.
6. **Transport primitives — pending.** Extract mechanisms after the wire,
   framing, and logging boundaries are available. Keep Redis and server authority
   outside the library; preserve ordering, backpressure, and shutdown behavior.
7. **Filesystem/process mechanisms — pending.** Inspect and extract cohesive
   existing mechanisms. Preserve platform implementations and server policy.
8. **Independent consumption and integration — pending.** Add a small real
   library-consumption example, audit remaining dependencies and packaging paths,
   perform a linked local server build and short smoke tests, and close out the
   crate/consumer map and merged PR record.

Milestones can be divided further if a diff is too large to review, but dependent
work begins only after the previous PR has merged. All shared implementations
must be used by the production server; this is not a collection of future stubs.

## Compatibility details

`cantrip-wire` preserves UTF-16 code units, missing/null distinctions, nonfinite
numbers, ECMAScript property order, canonical digest order, and Node-compatible
JSON/date behavior. Its host snapshot is initialized at the same existing server
call sites before native PGlite can alter process locale/timezone. The database's
PGlite default-timezone policy remains in the server.

The public wire APIs are the existing operations needed across crate boundaries.
Internal storage representations, parser stacks, and formatting machinery remain
private. The `json!` macro resolves its types inside its defining library so it
works through the server compatibility re-export and in independent consumers.

Protocol schema sources remain `packages/protocol`. The development exporter and
Node oracle remain development tools. The 16 generated schema graphs now live in
`crates/cantrip-protocol/contracts`, with their exporter and source-drift audit
updated together. SQL queries, provider catalogs, and server policy assets stay
in `cantrip_server_rs/contracts`. All moved graph bytes are unchanged.

`cantrip-protocol` depends on wire values and `cantrip-scheduling`, replacing its
former back-references into server project capabilities and automation services.
The scheduling library accepts validated schedules and contains no database,
timers, claims, or dispatch. Its timezone data and Croner license moved with the
implementation. Existing server `wire` and `project_automations::schedule` paths
remain compatibility facades; implementations are not duplicated.

The server stores encrypted payloads and grants opaquely. Extracting its protocol
validation does not supply HPKE, component-key storage, endpoint encryption, or
worker decryption. Those implementations currently live in `packages/crypto` and
the Node worker and remain work for the separate worker port.

The existing `cantrip-interaction` library supplies geometry, cursor, input, and
ownership primitives. `cantrip-cua` already owns native computer-use execution;
the future worker can integrate it without moving capture or input into the
server. `cantrip-cli` remains the worker-authenticated CLI, not a worker runtime.
None is copied or reorganized merely to add packages.

## Validation and build discipline

Use the existing bounded shared Cargo target directory through the server Cargo
wrapper when validating the server. Shared libraries can also be checked/tested
directly with `cargo check -p <crate>` or `cargo test -p <crate>` and the same
`CARGO_TARGET_DIR`, disabled incremental compilation, two build jobs, and no dev
or test debug information. Direct library builds do not run the server build
script or discover/build PGlite.

Move existing tests with their behavior. Run affected crate tests and compile
server consumers, including affected tests/examples. Use relevant existing
fixtures for wire values, validation, framing, and digests. Date oracle tests use
the maintained Node 24.22.2 development reference recorded during server
qualification. Tests require the existing protocol build artifacts.

Final validation includes a linked local server build, short
startup/readiness/shutdown smoke, a representative current Node-worker
interaction, and independent library consumption. Additional database or
packaging checks follow actual changed integration. Do not repeat the full server
replacement matrix, physical-device tests, VM campaigns, or release operations.
GitHub Actions remains reserved for releases and deployments.

The later worker goal still owns transport connection/reconnect, command
execution, worker enrollment/credentials, files/Git/PTYs, browser management,
runtime adapters, encryption, local journals, history reducers, provider
execution, and platform integration. These extractions provide reusable
foundations; they do not constitute those implementations.

## Delivery record

Milestone 1 used branch `agent/manual/rust-shared-wire-foundation` and merged in
[#3156](https://github.com/ArcaneArts/Cantrip/pull/3156), commit `6d8efe5f7`.
Primary was synchronized and its owned temporary worktree removed.
Local validation on macOS ARM64 with Rust 1.93 and Node 24.22.2 passed:

- Workspace check and Clippy with all targets and warnings denied.
- All eight `cantrip-wire` unit/integration tests, including 10,009 ISO values,
  4,536 date vectors in each of 15 timezone settings, deep JSON lifetimes, and
  canonical history digests.
- The server's existing JSON round-trip oracle covering numeric/property order
  and UTF-16 behavior through the new library boundary.
- Formatting, diff checks, source decomposition checks, Run-contract audit,
  workflow-removal audit, and the network ownership contract check.

Cargo metadata confirms only the server and extracted library are workspace
members; desktop, CLI, CUA, and interaction remain separate workspaces. The
lockfile adds only the new library and its server dependency; existing package
versions and checksums are unchanged. The library's resolved dependency closure
contains no server, SQL driver, PGlite, Redis, or HTTP runtime.

The compile pass caught and resolved an implicit ICU `alloc` feature dependency
and a server locale dependency that must remain declared. A copied development
artifact setup initially lacked package links; the existing network check passed
after supplying those local dependencies. No product behavior was changed to
make these checks pass. Full application suites and release/platform campaigns
were not run for this milestone.

Milestone 2 uses branch `agent/manual/rust-shared-protocol-scheduling`. It moves
the existing protocol engine and scheduling implementation into
`cantrip-protocol` and `cantrip-scheduling`, including their fixtures, timezone
assets, and Croner license. The shared dependency closures have no server,
database driver, PGlite, Redis, or HTTP runtime; the lockfile preserves all
existing third-party versions and checksums. Both libraries compile independently.

All 16 regenerated schema graphs and six moved timezone assets are byte-for-byte
unchanged. The source-drift audit also matches the server-owned provider map.
Workspace Clippy passes with all targets and warnings denied, covering the
server's library, executable, integration tests, and examples. The existing
immutable-string cache exception moved to root `clippy.toml` and now names the
shared wire type. The compile pass also identified two UTC-date aliases still
used by server telemetry; the compatibility facade retains them.

The 18 protocol unit tests pass, including independent graph composition and
recursive JSON normalization; the Git-observation oracle needed the existing
worker package links supplied in the temporary worktree before its successful
retry. The generated-manifest, JSON round-trip, and automation contract tests
also pass. The exhaustive all-schema mutation test was stopped intentionally
after the other cases passed: it repeats broad qualification beyond this
structural move and is not counted as a passing run. The local Run-contract audit
and three focused authentication/encryption/HTTP boundary tests pass.

The moved worker-envelope test passes 34,862 comparisons and the scheduling test
passes 17,252 occurrence comparisons against Node 24.22.2. Formatting, diff, and
source decomposition checks pass. The full application suite, device/VM QA, and
release packaging were not run; this milestone is locally validated on macOS
ARM64, with other platform implementations preserved by the move.

Milestone 2 merged in [#3157](https://github.com/ArcaneArts/Cantrip/pull/3157),
commit `14339908b`. Primary was synchronized and its owned worktree removed.

Milestone 3 uses branch `agent/manual/rust-shared-framing`. `cantrip-framing`
contains the existing WorkerLink, tunnel, and remote-surface codecs and remote
chunk assembly. Frame objects retain their original immutable bytes, including
unknown or differently ordered header properties. The server's existing frame
module paths re-export the library implementations.

The codecs' previous validation dependencies on server settings and WorkerLink
services now live in `cantrip-protocol::response` and `worker_link`. The concrete
error types are re-exported by the server, preserving downcasting, logging, and
error classification. Only value/error and identity mechanisms moved; session
availability, authorization, leases, resource lookup, and routing remain in the
server. WorkerLink keys still use UTF-16 lengths and require validated input.

`cantrip-protocol::history` now supplies the existing history item key and
protected-event ID algorithms. The canonical payload digest was already extracted
into `cantrip-wire`. Inspection of `native_history` and execution lanes found
that the remaining helpers implement database reconciliation, retained telemetry,
provenance, and transactional ownership policy; they remain server responsibilities.
The shared generated contracts already include history and execution envelopes.
No worker history reducer, journal, or execution runtime is implemented here.

Local validation for milestone 3 passed on macOS ARM64: independent framing
compilation/tests; 160 tunnel and 127 WorkerLink/chunk/assembly oracle cases;
26 remote-surface byte/error/buffer-retention cases; 18 history identity pairs
against existing Node functions; and concrete response-error downcast checks.
Workspace Clippy passes for all targets with warnings denied, including every
server consumer. Formatting, diff, decomposition, and the Run-contract audit
pass. The framing dependency closure has no server, database, Redis, or HTTP
runtime, and third-party versions/checksums are unchanged. No broad protocol
mutation rerun, application suite, hosted CI, or platform campaign was performed.

Milestone 3 merged in [#3158](https://github.com/ArcaneArts/Cantrip/pull/3158),
commit `ed73d9d16`. Primary was synchronized and its owned worktree removed.

Milestone 4 uses branch `agent/manual/rust-shared-config`. `cantrip-config`
contains the existing environment map/readers, dotenv implementation, errors,
lexical paths, and object-entry ordering. Its only shared library dependency is
`cantrip-wire` for existing text semantics; it has no database or server startup
dependency. Server defaults, environment-variable names, hosted origin/proxy
policy, peer settings, and secret/database configuration stay in `ServerConfig`
and its server-owned modules. Re-exports preserve existing public imports.

The process environment loader retains its unsafe startup-only contract and its
place in executable initialization. It still applies byte-sorted names using the
OS environment lookup rules and never overwrites existing values. The Windows
drive-resolution implementation moves unchanged; no filesystem preflight was
introduced. Configuration readers do not merge server and worker policy.

Milestone 4 validation passed locally on macOS ARM64: independent config tests
match 1,308 Node dotenv cases; the existing server configuration target passes
all four tests, including 977 Node/Rust configuration comparisons, database-mode
selection/hosted policy, CLI overrides and relative-path reopening, and serving
process identity with HTTP startup and orderly shutdown. This target links and
runs the real server with temporary local storage. Workspace Clippy passes for
all targets with warnings denied, as do formatting, diff, decomposition, and
Run-contract checks. No third-party version/checksum changed. Windows-specific
code is preserved but was not executed; no full suite or hosted CI ran.
