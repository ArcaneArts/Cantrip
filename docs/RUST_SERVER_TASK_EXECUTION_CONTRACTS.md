# Scheduled Task execution and protected follow-ups

The current Rust and Node servers both wait for a worker to report its opened
Task encryption grant before claiming a scheduled operation. The local suite
opens a real HPKE grant and reports it through the worker heartbeat. The
scheduler then claims the queued dispatch and sends
`task.operation.prepare` to the existing WorkerConnection.

The worker's production Task codec opens the saved draft and prepares its
encrypted operation. While the reply is held, the server retains one claimed
dispatch and the original draft, with no round, message or execution lane.
After release, the worker's NativeCommandClient submits claim, dispatch and
native binding acknowledgements. Direct execution completes the Task, and
initial planning saves the encrypted plan in the review state. Each operation
settles the original dispatch and retains its round, input receipt, terminal
digest and two encrypted messages.

The public turn route sends a Task follow-up to `task.message.protect`.
The worker codec rejects a modified Chat ciphertext, and the server retains
the exact prior rows. A valid submission holds the same message ID and
idempotency key while changing from the Chat key to the Task key. Repeating
the HTTP request returns the original saved message without dispatching
another turn. The returned and published ciphertext matches the database.

All nine local storage and authentication combinations pass. The suite compares
156 paired product HTTP observations and retains 36 additional pairs from HPKE
grant setup. It records 872 HTTP requests, 36 preparation commands, 36 message
protection commands, 54 turn commands, 108 worker SDK acknowledgements,
180 matching Task message Live events and 36 exact state reopens. A separate
verifier checks the 36 terminal digests and performs 396 crypto checks against
the captured preparation, result and retained message data.

The unchanged worker codecs and HTTP SDK execute with controlled model replies
and native binding facts. The suite covers direct execution, initial planning
and protected Task conversation. Continued planning, finalization, Goal
continuation, automation resume and final shipping acceptance retain their
separate scope. The two partial command mappings bring coverage to 286 of 323.
See the [acceptance record](security/rust-server-task-execution-acceptance.json).

Scoped formatting and diff checks pass. The local `pnpm check` passes the
server boundary tests and workspace typechecking, then stops in the worker
suite with 744 passing tests and two model-capacity retry and interruption
failures with unhandled rejections. Both failures were reproduced earlier on
clean main at `c65da5e2e`. The worker runtime and test files match the retained
baseline byte for byte.

```sh
node --import tsx scripts/server-rust/task-execution-http-compatibility.mjs \
  --database pglite --report /absolute/path/to/task-execution.json
```

Build the existing protocol, crypto, logging, version and Node reference
packages before running the suite. Supply the native HTTP and repository
fixture executables and database runtime assets as for the Goal recovery
suite. Select `bundled-postgres` or `postgres` to repeat it on PostgreSQL.
