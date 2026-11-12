# Native interruption and encrypted queue preparation

Rust's failed encrypted queue replacement returned a native database diagnostic;
the existing Node route returns the ORM statement and its bound parameters. A
real failing UPDATE reproduced this difference after the worker had already
normalized the encrypted input. Both peers preserved transaction rollback.

The repair attaches the captured reference diagnostic only after the native
replacement actually fails. Successful SQL and transaction boundaries stay the
same. `queued-prompt-query-manifest.mjs` captures the statement from the actual
reference repository and checks its committed diagnostic contract. No reference
server correction, database migration or protocol change is included.

## Executed scope

All nine local storage/authentication pairs pass: PGlite, bundled PostgreSQL and
external PostgreSQL, each with none/password/accounts authentication. Both project
and standalone Agent Chats use production routers, real HTTP/Live sockets, actual
SQL and the unchanged worker connection transport.

- Legacy interruption verifies both acknowledgements and the exact profile,
  thread and Chat authority. Dispatched native interruption preserves the active
  generation and command authority.
- Accepted preparation cancellation verifies rejected receipts, logical
  completion, inactive activations and suspended lanes. Missing logical roots
  avoid a worker command, and retries do not repeat a committed cancellation.
- A real SQL rejection rolls back cancellation while preserving the separately
  committed autonomy-stop intent. Notification failure, HTTP caller disappearance,
  worker replacement and the actual five-second notification deadline preserve
  committed cancellation.
- Queue preparation runs the real worker codec, using authenticated retained GUI
  native vectors, encrypted display content and encrypted future user messages.
  Normalization reseals only native input and preserves display/message envelopes.
  Immutable replay avoids repeated preparation; stale and concurrent edits cannot
  replace the accepted revision. A real SQL error rolls back the queue revision,
  prompt and receipt; retrying the same operation then succeeds.
- Tampered native input is rejected by actual worker decryption. Queue SQL rows
  retain null plaintext, and HTTP, Live, SQL snapshots and diagnostics contain no
  private queue marker. Original GUI mutation digests and stable server/Chat/message
  queue identities are checked independently before comparison normalization.

## Evidence and limits

The retained matrix has 531 paired HTTP observations, 2,916 traced requests, 612
command witnesses, 2,376 endpoint crypto checks and 216 original-mutation digest
bindings. It includes 36 caller disappearances, 36 worker replacements, 36 actual
notification deadlines, 648 raw native-state stages, 216 raw queue stages and 36
exact complete Chat/command/activation/lane reopen sets.

A separate verifier reopens 792 original, normalized, stored and reopened payloads
through the unchanged crypto package and worker codec, performing another 2,376
checks. It verifies all eight accepted queue receipts per peer after reopen.
SQL diagnostic comparison independently checks the complete statement, all twelve
parameters, actual normalized ciphertext and request-bounded update clock before
normalizing only proven dynamic fields.

The original failed comparison and frozen sources remain retained. A later cached
reference version mismatch was resolved by rebuilding `@cantrip/version` to the
same current `1.1.2808` source version as the fixed native executables; version
assertions were preserved. Fixed binaries are copied out of the shared Cargo
target and hashed before execution. Builds use two jobs, no incremental cache and
debug information disabled.

Three new scoped mappings (`chat.interrupt`, `chat.native-logical.cancel` and
`chat.queue.prepare`) bring worker-command coverage to 280/323. Existing
`chat.native-control` evidence is extended with interruption. All four mappings
remain partial: native replies are controlled, the queue inputs have no
attachments, and this suite does not execute native Core/model/filesystem work.
It does not complete Task/Goal recovery or final supported-platform shipping.
The original full replacement goal remains incomplete.

See [machine-readable evidence](security/rust-server-native-control-acceptance.json)
and the [current replacement reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md).

## Packaged cold Stop after worker restart

The macOS ARM64 Rust package built at `cb41197c6` and the Node reference
passed 12 cases using the Chromium SDK, packaged worker, and actual native
runtime. Both peers passed cold Chat Stop and cold Task Stop on PGlite,
bundled PostgreSQL, and external PostgreSQL. The Node reference used isolated
external databases for both PostgreSQL comparisons.

Each run paused a native turn, killed the owned worker tree, restarted the
worker, and sent two Stop requests over HTTP. The original native turn
recorded one abort and no completion. In the Chat cases a late Resume left
the turn stopped and did not start inference. The Task cases also preserved the
dispatch operation, attempt count, and planning round.
[Current cold Stop evidence](security/rust-server-native-control-acceptance.json#currentPackagedColdStop)

## Packaged Stop during live execution and restoration

The same macOS ARM64 Rust package passed all nine cases across PGlite,
bundled PostgreSQL, and external PostgreSQL. The Node reference used the
same packaged worker and actual native runtime for comparison.

- In the mounted Chat UI, Pause returned the active-command error without
  committing a checkpoint. The Stop control stopped the original turn. The
  yielded command remained alive until the worker tree was killed. After the
  worker restarted, the chat stayed stopped and rejected late Resume.
- The browser SDK stopped an actively executing direct Task and a direct Task
  whose restoration was waiting for provider capacity. In both cases two Stop
  requests produced one native abort, preserved the dispatch operation and
  counters, and left the Task stopped after a late Resume. Freeing provider
  capacity did not restart the stopped restoration.

The Node reference passed both the mounted Chat and running Task cases on
all three stores. Its restoration test passed on PGlite. Its comparison
against Rust's bundled mode hit a PostgreSQL deadlock and returned HTTP 502
from Stop. The first external PostgreSQL comparison completed the Stop
assertions, then the Node process exited with `CONNECTION_ENDED` during
teardown. A repeat against Node reproduced the PostgreSQL deadlock. The
Rust-only PostgreSQL tests exercised the same assertions through clean
teardown. All three Node failures are retained.

[Current live and restoring Stop evidence](security/rust-server-native-control-acceptance.json#currentPackagedLiveStop)

## Local checks

Rust formatting, strict all-target Clippy and all 86 library tests pass. The
required local `pnpm check` reaches the unchanged worker test suite: 744 tests
pass and two model-capacity/backoff tests fail with two unhandled errors. The same
two failures were independently reproduced on clean main in PR #2821; both the
worker implementation and test file remain byte-identical at this milestone's
base. This result is retained as a failure, not a passing repository check.
The separate repository formatting check flags twelve files that are byte-identical
to the base; formatting of every changed file passes.

## Local execution

Build the reference workspace distributions and native `http-sql-fixture`,
`project-repository-fixture` and `database-fixture` executables. Fixed executable
overrides use `CANTRIP_RUST_HTTP_FIXTURE_BINARY`,
`CANTRIP_RUST_PROJECT_REPOSITORY_BINARY` and
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY`. Supply the real native PGlite assets with
`PGLITE_RUNTIME_DIR` and the private PostgreSQL binaries with
`CANTRIP_TEST_POSTGRES_BIN_DIR`.

```sh
node --import tsx scripts/server-rust/queued-prompt-query-manifest.mjs
node --import tsx scripts/server-rust/native-control-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/to/native-controls.json
```

Repeat for `bundled-postgres` and `postgres`. Each invocation exercises all three
authentication profiles; `--profile` selects a single profile for diagnosis.
Keep original reports, traces, binaries, sources and database roots until their
delivery archive has been verified. Development validation is local; GitHub
Actions remains reserved for releases and deployments.
