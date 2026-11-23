# Native approval expiry and notifications

The Rust server's global approval-expiry timer now publishes the existing Chat
invalidation, Chat summary and Task workload fanout after expiry. Node remains
the default server and the worker remains Node. Complete replacement, supported
platform/artifact acceptance and final cutover remain unfinished.

## Reproduced defects and repair

The original real HTTP/SQL/App Live comparison observed six expired native rows
but none of Node's seven required Chat/summary/Task notifications. Rust had put
repository expiry inside the project-alert listener, bypassing Chat mutations.
The replacement has an independent one-second producer. It publishes once per
affected Chat, preserves Task fanout and standalone current-user summaries, and
does not send Chat notifications for requests without a Chat. Later ticks can
admit work while an earlier SQL operation is pending. Stopping the timer prevents
new admission; already admitted work belongs to the existing maintenance drain.
The timer holds weak references and does not keep its service graph alive.

The account-profile comparison separately reproduced a Node defect: its global
timer expired rows, then threw because no request supplied an account owner.
Both implementations now retain the stored owner beside the mapped expiry
result. Node enters that explicit owner context when publishing; Rust passes
the owner directly. This metadata is internal and does not enter public request
objects. The original public repository expiry method retains its result shape.

A held PostgreSQL UPDATE reproduced another Node failure during shutdown. The
row committed as expired after release, but closing the database interrupted its
Chat restoration, leaving `waiting-for-approval`. Node now stops the producer
and drains started expiry operations before database close. Rust uses its
existing owned-operation drain. Both now finish that UPDATE and restoration,
then exit zero. Original failures, SQL state, notifications and diagnostics are
retained with the milestone evidence.

No protocol schemas, encrypted envelopes or SQL migrations change. Expiry still
uses the original global update and per-Chat restoration boundaries. Ownership
is retained from the updated row rather than inferred from a current worker,
request or the account of another expired request. Protected computer-use
content remains opaque and unchanged.

## Executed local qualification

All nine macOS arm64 storage/authentication comparisons pass: PGlite, bundled
PostgreSQL and external PostgreSQL, each with none/password/accounts. These
retain 21 paired HTTP observations, 30 paired publication stages, 105 paired
notification events and 18 clean server exits. Cases include multiple requests
in one Chat, Task and standalone Chats, protected computer-use requests, no-Chat
rows, future pending requests, already-resolved rows, successive real timer
passes and simultaneous accounts. HTTP request-list reads occur after timer
expiry and verify that internal owner metadata is absent from the public wire
objects; they cannot cause the expiry being tested.

Each peer also observes a real timer SQL failure while the request relation is
temporarily renamed. Restoring the relation permits the next real expiry and
the same notifications. Selected SQL state proves that contents are preserved,
resolved timestamps are set and Chat statuses recover after their last pending
approval. The account probe receives only its own events.

A separate external-PostgreSQL account pair holds an actual BEFORE UPDATE
advisory-lock trigger, observes the pending SQL and pending row, starts shutdown,
observes physical App Live closure and verifies the process and UPDATE remain
alive. After releasing the lock, both peers retain `expired`, a resolved
timestamp and the same restored Chat state, and exit zero. This is real SQL and
real lifecycle execution, not an accelerated clock or an emulated query reply.

The optimized production executable also passes the complete external-PostgreSQL
account scenario and held-UPDATE shutdown test. Its 93,374,272 bytes have SHA-256
`9819464e16a2a78201f311a287a7abf9881411d70eb14e9ebb0b160dfbe7bc60`.
Both production peers reject the fixture SQL control path with 404; setup and
observation use a separate connection to the fixture-owned database.

Strict all-target Clippy, all 76 Rust library tests, the focused native
project-alert interaction test, 19 Node interaction tests, server typecheck/build
and the independent schema-source corpus pass locally. Development validation
is local; GitHub Actions remains reserved for releases and deployments.

The standard `pnpm check` still stops at the existing Node decomposition limits.
The expiry owner/drain wiring increases `build-app.ts` from the clean baseline's
1,532 lines to 1,539 (limit 1,500). The other failure remains byte-identical
`chat-turn-runtime.ts`, 2,336/1,999. Downstream aggregate stages did not run;
focused checks above ran independently. This does not make the aggregate green.
The separately executed repository decomposition check also fails on
`native-commands.ts`, 2,284/2,000. Clean Primary reproduces that failure and the
file is byte-identical; the new expiry repository methods stay within their budgets.

## Repeatable commands

Build the current workspace packages and Node reference. Use the same native
HTTP SQL fixture, PostgreSQL tools/helper and native PGlite runtime environment
as the other server comparisons. Keep one shared Cargo target with incremental
compilation disabled.

```sh
node --import tsx scripts/server-rust/interaction-expiry-live-compatibility.mjs \
  --database pglite --report /absolute/path/to/expiry.json

node --import tsx scripts/server-rust/interaction-expiry-live-compatibility.mjs \
  --database postgres --profile accounts --shutdown \
  --report /absolute/path/to/expiry-shutdown.json
```

Repeat the first command for both PostgreSQL modes and every authentication
profile. `--production` uses a separate SQL observer connected only to each
fixture-owned external PostgreSQL database; supply the actual native executable
through `CANTRIP_RUST_SERVER_BINARY`. That mode disables fixture SQL routes and
verifies their actual absence. It does not install observers in a product server.

Current supported-platform/package, complete product/fault and performance
acceptance remain required. Periodic connected-worker catalog/quota refresh is
the next identified background-service comparison. Rust default selection and
production Node-server removal remain part of the original goal.
