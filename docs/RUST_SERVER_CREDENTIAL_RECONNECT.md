# Legacy credentials on worker reconnect

Rust now starts the existing legacy provider-credential migration coordinator
after each authenticated worker connection. The reference comparison originally
captured the opaque credential, stored `signed-in` at revision 1 and acknowledged
purge. Native sent neither command and retained `migration-needed` at revision 0.
Both original processes exited zero. The original failure is retained.

Node remains the default server, the worker remains Node, and full replacement
acceptance is incomplete.

## Behavior and lifetime

The worker socket passes its authenticated owner and worker identities to an
account-service operation. That operation starts the existing coordinator
immediately and observes its result without blocking the worker handshake.
Migration and its completion log belong to the existing owned-operation drain.
The coordinator still controls candidate selection, revision and identity
guards, opaque storage, portable-auth handling, purge acknowledgments and the
actual fifteen-second worker deadlines. No protocol, SQL migration or production
worker changes are required.

Completion logs contain the same public counters and worker identity as Node.
Empty or missing-only passes remain quiet. Startup-query failure emits the fixed
warning without serializing the error. Worker error strings and malformed
credential responses remain absent from server logs. The new connection adapter
uses the shared native operational logger.

## Executed local qualification

All nine macOS arm64 storage/authentication pairs pass: PGlite, private PostgreSQL
and external PostgreSQL, each with none/password/accounts. The comparisons
retain 27 paired HTTP observations, 243 paired worker commands, 18 paired public
summaries, 18 paired persistence stages and 18 clean server exits.

Each pair exercises thirteen accounts and two reconnects: portable capture and
purge, nonportable capture, missing and malformed credentials, invalid metadata,
worker errors, an already captured identity with different returned ciphertext,
an identity conflict, a disabled account, excluded signed-out/foreign accounts,
Grok and a failed purge followed by successful retry. The worker observes the
actual committed credential before returning each purge acknowledgment.
Stored envelopes, blinded subjects, revisions and account states match exactly;
existing ciphertext is retained for an already captured identity. Unicode home
keys and command fields match. Both server output streams are retained and
checked for the private error/response marker.

A separate external-PostgreSQL account comparison waits through the actual
fifteen-second capture deadline. It preserves the failed account and continues
the migration pass. No shortened clock is used.

The query-failure comparison physically renames the account relation, opens a
real authenticated worker connection, observes the fixed startup warning and
zero migration commands, restores the relation and verifies successful retry.
That connection omits the producer's optional HTTP heartbeat while the relation
is intentionally unavailable; its actual WebSocket authentication remains intact.

The shutdown comparison blocks the actual captured-credential UPDATE behind a
PostgreSQL advisory-lock trigger. Neither peer sends a purge before commit.
Both physically close App Live and remain alive with the UPDATE blocked; native
shutdown reaches its account-operation drain. After release, both persist the
same opaque envelope at revision 1 and exit zero. The closed worker channel
retains its legacy copy. Restarting the same server/database and reconnecting
the same enrolled worker captures the matching identity, retains the existing
envelope/revision and completes one purge. Other account states remain intact.

The optimized production executable also passes the combined query failure,
held-UPDATE shutdown and restart scenario: four paired HTTP observations,
60 paired commands, six paired summaries and four paired persistence stages.
Its separate real-deadline pair passes too. Both production peers reject the SQL
control route with 404; setup and observation use independent connections only
to fixture-owned external PostgreSQL databases. The combined lifecycle case
exits four server processes cleanly; the deadline case exits two.

The production executable contains 93,623,392 bytes with SHA-256
`a86cfad01fc4de089f0114a794f447b8edee8aa3f8199ee78a173f187ae780a2`.

Strict all-target Clippy, all 76 Rust library tests, three focused Source tests,
server typecheck/build, all 16 generated schema graphs/maps, boundary and
workflow-removal audits pass locally. The standard `pnpm check` still stops at
unchanged Node decomposition limits: `build-app.ts` 1,539/1,500 and
`chat-turn-runtime.ts` 2,336/1,999. Subsequent aggregate stages did not run.
Original failures and the initial log-observer fixture correction remain
retained; these focused results do not make the aggregate green.

## Repeating the comparison

```sh
node --import tsx scripts/server-rust/worker-credential-reconnect-compatibility.mjs \
  --database postgres --profile accounts --report /absolute/path/reconnect.json

node --import tsx scripts/server-rust/worker-credential-reconnect-compatibility.mjs \
  --production --query-failure --shutdown --report /absolute/path/lifecycle.json

node --import tsx scripts/server-rust/worker-credential-reconnect-compatibility.mjs \
  --production --timeouts --report /absolute/path/deadline.json
```

Build workspace packages and the current native fixture first. Supply the native
executable, private PostgreSQL helper/binaries and materialized PGlite runtime as
in the other comparisons. Repeat the first command for every store and auth
profile. Production scenarios require the actual optimized executable and the
isolated external PostgreSQL fixture. Run deadline qualification separately
from the lifecycle scenario.

These are actual HTTP/SQL/WebSocket and lifecycle tests using the unchanged
production `WorkerConnection` with controlled capture/purge replies. They do not
establish actual provider login, worker credential encryption or deletion of a
real legacy credential file. Complete full-worker/product, current artifact,
supported-platform, migration/rollback, coordination and performance acceptance
remain required. Remaining operational log consumers/buffering/archive services,
Rust default selection and production Node-server removal also remain required.
Development validation stays local; GitHub Actions is reserved for releases and
deployments.
