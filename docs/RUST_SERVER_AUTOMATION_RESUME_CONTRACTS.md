# Managed Chat automation resume and queued Goal delivery

The public Chat pause route invokes the managed automation command after it
commits the resume and the worker acknowledges the pause boundary. A malformed
resume receipt returns the existing 409 and restores the durable pause. The
worker receives a compensating pause command. A successful native reply keeps
control in the native runtime. When the reply contains `resumed: false`, the
server may claim a retained Goal prompt and send `chat.queue.execute`.

The worker's existing encryption and queue helpers open the pending message and
materialize the Goal mutation. The managed session and HTTP SDK admit, dispatch,
and settle the same claim and operation generation. The suite holds the native
result while checking the committed encrypted message and the dispatched
receipt. A repeated resume leaves the single pending first-cycle claim, original
message, and applied receipt intact.

The Node reference publishes a current-user Chat invalidation after a
successful mutating response. Rust's Chat execution handler omitted it. The
original PGlite run captured five of these events from Node and zero from Rust,
with the same project invalidations and encrypted message event. The repaired
handler publishes through the existing response-completion adapter. The
comparison checks each successful mutation and verifies that malformed
requests, the compensated failure, and reads emit no current-user Chat event.
The accounts profile also subscribes a separate account to verify isolation.

The local macOS arm64 comparison passes all nine combinations of PGlite,
bundled PostgreSQL, and external PostgreSQL with anonymous, password, and
accounts authentication. It records 108 paired product HTTP observations,
27 paired worker SDK requests, 99 paired worker commands, and 117 paired Live
events, including 45 current-user invalidations. The HTTP trace contains 612
requests. A separate verifier checks 162 captured SQL snapshots and 18 actual
server restarts. The reopened queue and history match exactly. Retained SQL
rows match with the independently bounded queue notification retry clock.
The fixture also opens and checks the submitted encrypted content, the native
command request and result, and their keyed digests.

Queue refreshes run on a timer and can coalesce revisions. Any overlapping
refresh is retained and its scope checked. The broader public Chat regression
suite passes all nine combinations with 867 paired HTTP observations. It checks
queue delivery and compares distinct logical completion identities against the
actual admitted turns. It retains every raw outbox delivery, including retries
of an identical operation generation. Strict all-target Clippy, all 86 Rust
library tests, and 157 focused worker tests pass locally.

The local `pnpm check` passes the native boundary checks and typechecking, then
stops after 744 passing worker tests with two capacity retry and interruption
failures and two unhandled rejections. The same failures reproduced on clean
main at `c65da5e2e`. Both worker source files match the retained baseline.

The two command mappings bring scoped coverage to 288 of 323. Native resume
replies and the Goal mutation result are controlled. Full worker and client
operation, additional queued native methods, autonomous Goal activation, and
shipping acceptance remain open. See the [acceptance
record](security/rust-server-automation-resume-acceptance.json).

```sh
node --import tsx scripts/server-rust/automation-resume-http-compatibility.mjs \
  --database pglite --report /absolute/path/to/automation-resume.json
```

Build the protocol, crypto, logging, version, and Node reference packages before
running the suite. Supply the native HTTP fixture and storage runtime assets.
Repeat with `bundled-postgres` and `postgres` for the PostgreSQL modes.
