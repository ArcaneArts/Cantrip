# Native worker CLI relay

The Rust server implements `POST /api/internal/cli` and all 35 commands in the
existing worker CLI protocol. The worker and its CLI client remain TypeScript.
The server executes these requests through native repositories, worker command
transport and domain services. Normal server startup and CLI execution require
no JavaScript server helper.

Desktop and standalone now select the Rust server. The CLI comparison
exercises the retained Node reference alongside the native implementation.
The [acceptance reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md)
records the packaged and product runs.

The [current CLI matrix](security/rust-server-cli-http-contract-matrix.json)
repeats the paired HTTP, worker-client, disconnect and restart checks
against the `1.1.2881` Rust source.

## Native CLI worktree continuation

The packaged CLI now completes create-and-switch with a full worker and real
native turns. The worker keeps a separate managed execution runner for each
Chat placement. The server commits the selected model route with the new lane's
accepted input receipt, then binds the native thread when the worker starts it.
Canonical history reuses the exact protected system continuation message and
preserves its lane and worktree attribution.

The local browser test closes the linked console through the existing client
control, holds the original native turn open, invokes `cantrip worktree create
--switch`, and checks the real Git checkout before releasing the turn. It
verifies two distinct native threads, one canonical answer per lane, and exact
transcript retention after server and worker restart. The Rust debug executable
passed on PGlite, bundled PostgreSQL, and external PostgreSQL. The rebuilt Node
reference passed on external PostgreSQL. The optimized macOS ARM64 package
`1.1.2935` repeated the same flow on all three stores. Each run passed 12
product steps, issued two model requests and reopened the exact transcript
after four clean server exits and four clean worker exits. The worker ran
rebuilt JavaScript with the previously packaged Node runtime, dependencies,
CLI and Codex. The fixture supplies the local repository's catalog
classification and scripted model responses.

The Linux ARM64 and x64 `1.1.2936` container images also passed on all
three stores. The browser, worker, CLI and Codex ran on macOS ARM64,
with the x64 server container running under emulation. Across six runs,
the harness verified 72 product steps, 24 clean server exits and 24 clean
worker exits. Each run verified two distinct native threads and one
canonical answer per lane. The Windows release package run remains open.
[Worktree continuation evidence](security/rust-server-cli-worktree-product.json)
[macOS release evidence](security/rust-server-2935-macos-release-acceptance.json)
[Linux container evidence](security/rust-server-2936-linux-cli-worktree-acceptance.json)

## Preserved behavior

CLI context can come from an explicit Chat lane, Codex thread, Terminal, or
containing project root. Explicit `lane` and `cwd` selection preserve their
independent lookup behavior. Automatic selection rejects mutations when the
bound lane and current directory identify different execution placements. Public
CLI context retains its nine reference fields; the internal MCP discriminator
is not added to it.

Worktree, policy, target, Explorer, Terminal and browser operations share the
native domain services. CLI create-and-switch uses the existing worktree acquire
service; acquire remains absent from the MCP allowlist. Run commands preserve
their CLI arguments, caller operation IDs and read-only guard order without
adding the MCP worker-binding restriction.

Target selection retains narrow exact/current-Terminal lookups, worker/project
scope, separate exact and partial candidate queries, and focused catalogs.
Selecting a Terminal does not require mapping unrelated Chat or browser records.
Generated reference SQL diagnostics are attached only after an actual database
operation fails. Normal startup does not run the reference exporter.

CLI errors preserve their reference status/code, full validation details and
UTF-16 strings. The shared MCP transport continues its own bounded/redacted error
contract. CLI argument maps retain the 20-entry limit independently of MCP's
32-entry limit. The CLI wire graph has five roots and 60 nodes and is composed
with relocated references rather than depending on base-graph offsets.

Mutation audits follow command classification, including successful no-op
results. Audit field validation occurs after execution, matching the reference
when a completed operation is followed by a CLI argument error. Admitted
operations retain their worker reply, publication and audit lifetime after the
HTTP caller disconnects. Policies, surface content, Run output and secrets
remain opaque to the server.

## Local qualification

The paired HTTP suite exercises both server implementations with isolated data,
the production WorkerConnection and the unchanged worker CLI client. All 35
commands have successful coverage. The nine storage/authentication profiles
pass 108 ordinary calls per peer: 972 paired cases and 1,944 responses. The
unchanged worker CLI client also makes five calls per peer (90 total), including
status, worktree/Run reads, encrypted Terminal input and typed rejection. Each peer
also completes a real admitted-write socket disconnect and a real server
restart, for 18 disconnects and 18 restarts across the matrix.

The suite checks complete bodies, relevant headers, worker commands and mutation
audits. It verifies policy decryption and encrypted Run secret/output use at the
endpoint, branch derivation/collision handling, durable continuation scheduling,
read-only and context guard order, strict request/argument boundaries, and
preservation of committed browser state across restart. Actual missing-table
queries retain matching diagnostics, including a 7,249-character untyped target
failure. A 2,523-character worker error is preserved in full. Narrow target
lookups also succeed with a malformed unrelated Chat, while full catalog reads
retain that record's validation diagnostics before validating the kind filter.

The integrated Unicode-worker test also checks that status returns the stored
worker ID after SQL replaces an unpaired input character, while connection
lookup retains the original input identity.

The controlled worker sends real authenticated HTTP heartbeats as well as
maintaining its command socket. These are separate production worker duties.
The fixture does not extend presence timeouts or make stored last-seen times
permanently current. It records the heartbeat responses.

The unmodified Node PGlite reference also hit a 15-second shutdown deadline in
the integrated restart suite. That failure is retained. The passing PGlite run
uses the existing reference-oracle notification drain: it tracks and awaits the
real repository/notification promises before closing the database. PostgreSQL
reference runs use the ordinary fixture. Rust uses its production drain. The
shutdown deadline and protocol assertions are unchanged; this is not evidence
that the original Node shutdown race has been fixed.

The Rust library passes 54 tests, including 7,149 independent CLI wire
comparisons and 24 exact selector-query comparisons with variable worker lists
and Unicode identities. The separate Run MCP oracle passes 2,617 comparisons.
Strict all-target Clippy passes. The repository-wide `pnpm check` fails on the
unchanged baseline TypeScript budgets: `build-app.ts` has 1,527 lines against
1,500 and `chat-turn-runtime.ts` has 2,249 against 1,999. That check is not green.

Run the HTTP suite locally with an already-built fixture binary, or let it build
the Rust example:

```sh
pnpm exec tsx scripts/server-rust/cli-http-compatibility.mjs --database pglite --report .qa/rust-server/cli-pglite.json
pnpm exec tsx scripts/server-rust/cli-http-compatibility.mjs --database bundled-postgres --report .qa/rust-server/cli-bundled.json
pnpm exec tsx scripts/server-rust/cli-http-compatibility.mjs --database postgres --report .qa/rust-server/cli-postgres.json
node scripts/server-rust/cargo.mjs test --lib
node scripts/server-rust/cargo.mjs clippy --all-targets -- -D warnings
```

Set `CANTRIP_TEST_POSTGRES_BIN_DIR` for the PostgreSQL fixtures and optionally
`CANTRIP_RUST_SERVER_BINARY` to a pinned `http-sql-fixture` executable. Reference
query/contract generators run only as development checks. GitHub Actions remains
reserved for releases and deployments.

These results are local darwin-arm64 evidence. Endpoint replies and Git/Run
process results are controlled. Tests prepare an active secondary lane between
switch and release to qualify those server operations independently of native
turn execution. Full worker/Codex product recovery, Linux/Windows artifacts,
mixed-instance coordination, migration/post-write rollback, packaging,
Winterhold rehearsal, default cutover and production Node server removal remain
separate acceptance requirements.
