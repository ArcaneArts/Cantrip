# Native Task and Goal product qualification

The [current production qualification](RUST_SERVER_SHARED_AGENT_RECOVERY.md)
passes all six cases with the current client, rebuilt worker, 92-patch native
runtime and optimized production Rust executable, without SQL fixture routes.
It also adds active Agent/Goal crash recovery across shared peers. Earlier
frozen-artifact results below retain their original scope. Supported-platform,
packaged, performance and complete replacement acceptance remain separate.

Run development qualification locally. GitHub Actions is reserved for releases
and deployments. These tests compare the existing browser SDKs through each
server, the full Node worker and an actual built Cantrip native runtime. Only the
public model HTTP responses are controlled. They do not prove packaged desktop,
supported-platform, multi-instance or Winterhold readiness.

Prepare the workspace dependencies and worker:

```sh
pnpm install --frozen-lockfile
pnpm --filter '@cantrip/worker...' -r build
pnpm --filter '@cantrip/app^...' -r build
```

Build the current native runtime with `pnpm codex:build`, or use a separately
preserved bundle whose source and patch digests match the checkout. Supply its
actual executable and a PostgreSQL binary directory to the local matrix:

```sh
CANTRIP_CODEX_BIN=/absolute/path/to/bundle/codex \
CANTRIP_TEST_POSTGRES_BIN_DIR=/absolute/path/to/postgresql/bin \
node --import tsx scripts/server-rust/native-product-compatibility.mjs \
  --report-directory .qa/rust-server/native-product-current
```

The default matrix runs both scenarios against Node and Rust on native PGlite,
external PostgreSQL and bundled PostgreSQL. Every scenario receives a new
disposable project and store. The PostgreSQL fixture owns its temporary server;
the tests do not connect to an inherited production `DATABASE_URL`.

- `tasks` covers browser-encrypted direct execution, planning and review, native
  Goal completion, quota failure and explicit retry, paused admission, and
  retained completion and history across server/worker restart.
- `agent-tasks` covers native MCP Task creation, exact-operation replay, catalog
  reads, status and wait, actual delegated child execution through the
  scheduler, encrypted result decryption and exact restart retention without
  duplicate inference.

Keep the scenarios separate: the native MCP scenario asserts that its initial
Task catalog is empty. Combining `--tasks` with `--agent-tasks` in one invocation
of the underlying folder driver creates earlier Tasks in that same project.
The matrix runner preserves the existing assertions and uses independent
invocations instead.

Each matrix invocation creates a new report subdirectory, including when the
requested report directory already exists, so rerunning preserves earlier
failures and reports.

To reproduce one matrix case, add `--database pglite --suite tasks`. Both options
can be repeated. Selecting fewer cases leaves `fullLocalMatrix` false in the
summary. Each case records its exit status, report and failure; independent
cases still run after a failure, and any failed case makes the matrix exit
unsuccessfully. The runner records an explicitly supplied absolute native
executable's SHA-256 after execution, without blocking worker startup on a
manifest or executable preflight.

The underlying driver uses production server startup and routes plus a
development-only SQL endpoint. On a Task failure, it captures owner/project
scoped operational rows from the open database before teardown. This is a
read-only repeatable-read snapshot; it neither repairs state nor replaces the
original failure. Failed fixture roots and raw browser, worker, model and server
reports remain available for investigation.

Use `--postgres-errors` with the underlying folder driver to retain PostgreSQL
SQLSTATE and deadlock details. This changes error logging only for the role in
the disposable test cluster, then reopens the server connections. Diagnostic
runs retain server stderr after readiness for each server launch, including
errors that would otherwise fall outside the normal bounded diagnostic tail.

The product flow exposed several concrete defects: Node omitted the protected
Goal prompt when its Task messages were already encrypted; Rust Goal observation
and historical attribution used nonexistent worktree columns; finalization's
requeue statement inferred a timestamp parameter as text; and usage persistence
could deadlock against owner-first Task control. The fixes preserve encrypted
payloads, ownership checks, exclusive Task locks and receipt validation. Usage
and canonical history now acquire their owner foreign-key reference lock before
project/chat locks in both implementations.

The PostgreSQL Task Worker repository suite includes four actual usage/pause
races, covering both implementations and both mixed directions. Each observes
real database lock waiters and requires both writes to commit with exact usage
counts and the next pause revision. The regression rejects an actual deadlock
before the lock-order fix; the existing revision/conflict races remain intact.

The Node reference fixture tracks and drains actual authentication notification
promises before database shutdown. This qualification does not establish that
the ordinary Node shutdown race is fixed. Rust uses its production drain.

## Deployment and backend selection

```sh
node --import tsx scripts/server-rust/profile-database-compatibility.mjs \
  --report .qa/rust-server/database-selection.json
```

For each backend, this test performs actual setup, restarts without database
flags, an empty URL template, a failed PostgreSQL setup and an explicit
`DATABASE_URL` override. It also reopens the remembered store twice in hosted
mode with account authentication and then in local mode, requiring the original
server identity, stored backend, profile bytes and encryption key bytes.
Hosted HTTP requests use HTTPS forwarding headers from a trusted loopback
proxy; this is not a TLS deployment or container rehearsal.

Current integrated native product execution and the supported-platform matrix
remain under qualification. A successful runtime build or backend-selection
test alone does not establish full server replacement.

The frozen `348760ffd` candidate with these fixes passes all six matrix cases
on macOS arm64 using the 83-patch native bundle (patch digest
`001a4552e74d3f1f7178e47fbd263058235453dc0afea07a72544952f23f2f4d`).
This covers 12 peer runs, 150 product steps, 54 clean worker stops and 144 model
POSTs. The original failures remain in the local evidence. Later native Task
pause/provider-transfer changes require separate integrated qualification.

The local Task Worker repository suite also passes 102 paired cases, ten SQL
snapshots, 40 existing races and four usage/pause races. Server typechecking and
Rust formatting pass. Six related Node unit files retain eight failures and 58
passes, reproduced exactly on the unchanged baseline with source/test byte
proofs. The broad repository check remains red at its existing application line
budgets; no broad success or complete replacement is claimed.

After integrating `77f5cf763`, all three storage modes also pass the remembered
backend/local/hosted restart checks and the full profile transfer/fault suite
against 130 tables and four sequences. Reverse transfer retains accepted Rust
writes and the real Node session. The integrated candidate passes 54 Rust
library tests, strict Clippy, worker/dependency builds, server typechecking and
the 102-case/44-race PostgreSQL repository suite. Five failures in four related
Node unit files reproduce exactly on unchanged `77f5cf763`; the project-pause
fixture lacks its new request dependency. Those unit checks remain red.

The controlled queue-delivery backend now models the Source's await of an
absent optional Task pause reader. Production Rust already performs the actual
asynchronous lookup. All original oracle traces and assertions are retained.
PR #2655 separately delivered the incoming compilation repairs; this candidate
retains its type-inferred worker declaration. The worker remains in Node.

The subsequent `2a2d63fb4` integration passes the 54 library tests, strict Clippy,
worker/dependency builds and server typechecking. Explicitly typing the throwing
handoff helper restores TypeScript narrowing; its emitted JavaScript is
identical to the incoming version. The 86 native patch inputs match the local
build in progress. Current native execution remains unqualified until that
artifact is built and exercised.
