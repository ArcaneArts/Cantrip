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

1. **Wire foundation and workspace — implemented and locally validated.**
   Move existing wire values, coercion, JSON/date behavior, and canonical digest
   into `cantrip-wire`. Preserve server import paths with re-exports. Move the
   existing focused tests with their implementation. Update Docker build inputs,
   local workspace checks, and development watching for the new layout.
2. **Protocol and pure scheduling — pending.** Extract generated contracts and
   validation, removing the current back-references into project capabilities
   and automation scheduling. Preserve exporter/oracle ownership and fixtures.
3. **Framing and execution contracts — pending.** Extract the three binary codecs
   and remaining applicable pure identities/history/execution contracts. Keep
   resource authority in server adapters.
4. **Configuration — pending.** Extract environment readers, environment-file
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
Node oracle remain development tools. Contract extraction must relocate generated
assets and update their producers together, preserving one maintained definition.

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

Milestone 1 uses branch `agent/manual/rust-shared-wire-foundation`.
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
