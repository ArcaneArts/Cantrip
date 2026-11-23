# Rust Chat controls

The native server implements the existing compact, worktree-selection,
execution-lane list and execution-lane release endpoints. This is a local
macOS arm64 qualification against Source `eac53fda28b918231f1c28fd94ce4fa3aee3733c`;
Node remains the normal server default and the complete replacement is unfinished.

| Method    | Route                                                | Native behavior                                                                                                                                |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| POST      | `/api/chats/:chatId/compact`                         | Resolve the existing model route, prepare the managed session and dispatch `chat.compact`.                                                     |
| PATCH     | `/api/chats/:chatId/worktree`                        | Atomically move Chat/runtime/lane/console placement with existing lease and busy guards.                                                       |
| GET, HEAD | `/api/chats/:chatId/execution-lanes`                 | Return the owner-scoped persisted lane catalog without mutation.                                                                               |
| POST      | `/api/chats/:chatId/execution-lanes/:laneId/release` | Check actual worker Git status, release the lane/branch lease, optionally return to Primary and protect the system message through the worker. |

## Behavioral boundaries

Authentication, CSRF, parser limits, unknown-field/default handling and outgoing
schemas retain the existing contracts. The shared IDE-only pre-handler runs
after body parsing and before worktree/lane schema validation. Unsupported
methods retain ordinary 404, raw-path budgets and audit attribution. Four
separately generated contract roots are appended without depending on unrelated
base-graph node positions.

Compaction retains running/approval, missing-thread, offline-worker and model
resolution errors. A null selected model can use the bound runtime route.
Managed preparation retains session, subagent, MCP and plan settings; the
original execution context still supplies the compact thread/model/provider.
This includes Source's standalone behavior: preparation can bind a new thread
while compact targets the original context thread. Operational started/completed
events retain their exact fields and ordering, including logging completion
before an invalid acknowledgment fails output validation.

Worktree mutation reuses the existing transaction and returns the full Chat wire
summary. Cross-worker, busy, active-lane, exclusive-lease, reservation and running
console guards remain intact. Same-worktree mode changes retain placement
revision behavior. A late SQL trigger failure proves transaction rollback.
Unexpected update failures retain the generic public error and the operational
`chat.worktree.update.failed` event without private SQL content.

Lane release retains missing/null input defaults and the already-released
shortcut, including success while the worker is offline. Dirty status rejects
release unless explicitly allowed. The actual production message-protection
command encrypts the attributed system message; the server stores the opaque
envelope. Protection failure can occur after the release transaction commits,
as in Source; replay takes the released shortcut without another protection
request. Normal message publication precedes response-completion Chat
invalidation. Reads do not publish mutation events.

Admitted operations use the existing owned-task lifecycle. Actual caller socket
destruction before the worker acknowledgment does not cancel the admitted
compact/release. Release still persists and publishes its encrypted message;
the disconnected response does not publish a completion invalidation.

## Worker integration fixes

Full-product execution exposed two failures in the current Node worker, both
also reproduced with the Node server:

- Stop/Goal clear invalidated the native inference gate, but compact did not
  renew it. The explicitly admitted `thread/compact/start` now uses the existing
  serialized generation renewal and previous-generation comparison. The old
  inference source remains aborted. Stop/Goal-clear regressions failed before
  the fix; uncertain-bind and replaced-transport cases are covered too.
- Native compaction can emit output before retaining its original turn context.
  Treating that temporary absence as a permanent publication failure left the
  Chat running after native completion. Output classification now subscribes
  before reading and waits for actual native history changes only when the
  original context is pending. Conflicting evidence fails immediately; thread
  close or transport replacement releases the observer. It does not poll,
  substitute current settings, or add an input gate.

The worker remains TypeScript/Node. The native Codex 0.166 executable and its
92-patch manifest are unchanged. This milestone does not extract shared crates
or start a Rust worker rewrite.

## Executed local qualification

All three stores pass each none/password/accounts profile, using real HTTP,
SQL, App Live and production worker command transport. Controlled filesystem
and native replies isolate boundary cases; message protection uses real
endpoint encryption and validates binding/decryption before comparison.

| Per database mode   | Paired cases | Paired caller-loss operations | Clean server exits | Operational log records |
| ------------------- | -----------: | ----------------------------: | -----------------: | ----------------------: |
| PGlite              |          252 |                             6 |                 12 |                      72 |
| Bundled PostgreSQL  |          252 |                             6 |                 12 |                      72 |
| External PostgreSQL |          252 |                             6 |                 12 |                      72 |
| Total               |          756 |                            18 |                 36 |                     216 |

The 756 paired cases produce 1,512 normal HTTP observations. Each profile
compares responses, worker commands, full selected SQL before/after snapshots,
live events and logs. Coverage includes owner isolation, guards, dirty release,
late rollback, replay, actual socket disappearance and retained server restart.
Random encryption envelopes are compared semantically only after verifying the
real ciphertext, binding and stored opaque value. Earlier failed runs remain
retained alongside the successful final reports.

The separate browser/full-worker matrix passes all six Node/Rust × storage
cells against actual production servers: 204 product steps, 36 clean server
exits, 42 clean full-worker exits and 12 actual Run child retirements. Each peer
uses six real native model POSTs with controlled public HTTP model responses.
The assertions require a real compacted rollout checkpoint, continuation using
its summary, canonical encrypted history with original model attribution, actual
Git dirty-file protection, intentional release, one decrypted system message,
idempotent replay and exact committed transcript retention after server/worker
restart. Linked consoles are closed through the public SDK before selection,
preserving the running-console prerequisite. Only the disposable local Git
catalog classification is seeded; no real project or GitHub operation is used.

The current 584-route production probe completes all 1,168 requests and both
servers exit zero. Active generic-fallback gaps decrease from 29 to 25. Its
inspection command still exits one because those other endpoints remain
unfinished. This probe does not prove complete successful-operation parity.

Qualified optimized production server SHA-256:
`ed2073fde1fb2703723a078514f4bf79282dd46cd8318fbe9257a56b4a6ab9b4`.
Both production HTTP version endpoints report `1.1.2754`. The controlled SQL
fixture executable is separately identified by SHA-256
`6be4ec81096ce107289473c07a23bb0ab089e2c4b9193689696c133220b0b135`.

Current checks pass: 65 Rust library tests, strict all-target Clippy, Rustfmt,
11 generated-contract/source-drift comparisons, worker compilation/native asset
verification, 89 focused worker tests, all four focused app worktree files
(56 tests), the app production build and boundary/workflow audits. The required
focused worktree suites
still reproduce the documented baseline failures: protocol 4 failed/1,116
passed; Node server 1 failed/59 passed; worker 2 failed/91 passed plus two
unhandled errors. `pnpm check` stops at unchanged Node source line limits
1,532/1,500 and 2,336/1,999; downstream aggregate stages did not run. No assertion
or required gate is weakened to call these results passing.

## Reproduction and remaining acceptance

Build current workspace dependencies and the Node comparison server first.
Use the shared Cargo target with incremental/debug-info disabled. Materialize a
private native PGlite runtime and supply private PostgreSQL binaries as required.

```sh
node --import tsx scripts/server-rust/chat-control-http-compatibility.mjs \
  --database pglite --boundaries --report /absolute/path/controls.json

CANTRIP_TEST_WORKER_PACKAGE=/absolute/path/full-worker-runtime \
CANTRIP_CODEX_BIN=/absolute/path/full-worker-runtime/bin/codex \
CANTRIP_TEST_CLI_BIN=/absolute/path/cantrip \
CANTRIP_TEST_SERVER_BINARY=/absolute/path/cantrip-server \
CANTRIP_TEST_PROJECT_REPOSITORY_BINARY=/absolute/path/project-repository-fixture \
PGLITE_RUNTIME_DIR=/absolute/path/native-pglite-runtime \
  node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database pglite --chat-controls --keep-fixture \
  --report /absolute/path/product.json
```

Repeat with `bundled-postgres` and `postgres`; set
`CANTRIP_TEST_POSTGRES_BIN_DIR` and `CANTRIP_RUST_DATABASE_FIXTURE_BINARY` for a
supplied private PostgreSQL fixture. The HTTP runner also accepts `--profile`
and `--runtime` for a focused reproduction. Complete reports, process logs,
profiles, native rollouts, failed discoveries and build inputs must be archived
before their owned fixtures are removed.

Full GUI interaction, current supported-platform and packaged-update acceptance,
complete-domain/background-service reconciliation, mixed-server recovery,
performance, final legacy migration/rollback, desktop/Winterhold rehearsal,
default Rust cutover and production Node-server removal remain required. All
development validation here is local; no GitHub Actions or production Winterhold
deployment is used.
