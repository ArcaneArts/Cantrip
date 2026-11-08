# Worker catalog and quota maintenance

Rust now starts worker-scoped catalog and quota maintenance after authenticated
worker connections and every fifteen minutes. Node remains the default server,
the worker remains Node, and full replacement acceptance is incomplete.

## Behavior

Each server remembers the owner of workers authenticated on that server. A
reconnection updates that registry and starts a refresh. The periodic producer
checks connection availability before starting each registered worker's pass;
disconnecting does not erase its registry entry, matching Node.

A pass reads the owner's current provider targets and worker record. Dedicated
worker endpoints remain eligible without an encryption grant. ChatGPT and Grok
require the worker's `provider-credential` grant. Catalog loads use the existing
services with `force: false`; all catalog attempts settle before independent
quota reads start for every enabled account of eligible account providers.
Cached catalogs do not suppress those quota reads. Catalog failures and an
individual account's quota failure do not suppress the other eligible work.
Quota observations retain `worker-reconnected` or `periodic-refresh`, the
explicit owner, worker and account, and the existing persistence boundaries.

The timer starts with application composition, waits the actual fifteen-minute
period and does not replay a burst of missed ticks. It holds weak service
references. Started passes belong to the existing account-service operation
tracker, so stopping the producer prevents further ticks while shutdown drains
already admitted operations before closing the database. No worker protocol,
schema, encrypted-envelope or external configuration changes are required.

The broader catalog comparison also reproduced a separate label mismatch:
custom OpenAI-compatible discovery reported `Model endpoint` in Rust where
Node reported `OpenAI compatible`. The shared label now matches both the HTTP
error and the dispatched worker request. The old test's expected 409 was stale:
the current Node implementation returns 503 when no worker is available. The
comparison now requires that exact status and message and also checks successful
discovery with a connected worker. Original failures remain retained.

## Local qualification

The pre-change executable authenticated a worker connection but produced zero
catalog commands, failing the real connection comparison. Its process exited
cleanly; the failure was missing behavior, rather than failed setup. Earlier
fixture setup failures are retained separately.

All nine macOS arm64 storage/authentication comparisons pass: PGlite, private
PostgreSQL and external PostgreSQL, each with none/password/accounts. They
retain 27 paired HTTP observations, 189 paired worker commands, 36 paired
persistence stages and 18 clean server exits. Command fields are compared
exactly after validating and normalizing fresh transfer UUIDs. Persisted account,
worker, trigger and batch relationships match. Cases cover grant filtering,
multiple enabled accounts, a disabled account, foreign ownership, a failed
catalog, cached reconnects, an individual quota failure and successful retry.

A separate external-PostgreSQL account pair holds an actual quota INSERT behind
an advisory-lock trigger. Both servers physically close App Live and remain
alive while the INSERT is blocked. Rust reaches its account-operation drain.
After release both finish the two quota windows and exit zero. These are real
SQL operations and real lifecycle events.

Separate external-PostgreSQL account runs pass through the actual fifteen-minute
production interval on both peers. Their commands and persisted relationships
also compare equally; no shortened clock is used.

The current optimized production executable also passes the complete external
PostgreSQL account scenario, actual fifteen-minute timer and held-INSERT shutdown
pair. This retains four paired HTTP observations, 30 paired commands and five
paired persistence stages. Quota commands arrive at 901,796 ms for Node and
901,438–901,439 ms for Rust relative to each launch. Both peers reject the fixture
SQL control route with 404; setup and observation use a separate connection to
the isolated fixture database. After releasing the shutdown lock, both retain
12 target-account quota rows against the prior 10 and exit zero.

The production executable contains 93,504,064 bytes with SHA-256
`40ff4bdcdeeda5d7d31f6981636fb9168299d613448da590f6a530a313e5c8c2`.

Strict all-target Clippy, 76 Rust library tests, three Source account-provider
tests, seven Source catalog tests, server typecheck, all 16 generated contract
graphs/maps, boundary audit and workflow-removal verification pass locally.
The standard `pnpm check` stops at unchanged Node decomposition limits:
`build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,336/1,999. Subsequent
aggregate stages did not run. Focused checks do not make the aggregate green.

The fixtures use the unchanged production `WorkerConnection` implementation
with controlled provider replies. They do not establish actual provider login,
native provider execution, full-worker product or supported-platform acceptance.
Development validation is local; GitHub Actions remains reserved for releases
and deployments.

```sh
node --import tsx scripts/server-rust/worker-catalog-refresh-compatibility.mjs \
  --database postgres --profile accounts --report /absolute/path/reconnect.json

node --import tsx scripts/server-rust/worker-catalog-refresh-compatibility.mjs \
  --kind rust --database postgres --profile accounts --periodic --production \
  --shutdown --report /absolute/path/production-periodic.json
```

Build the workspace packages and native fixture first. Supply
`CANTRIP_RUST_SERVER_BINARY`, the PostgreSQL fixture/binaries and the materialized
native PGlite runtime as in the existing comparisons. Repeat the first command
for all three stores and authentication modes. `--production` requires the
actual production executable and an isolated external PostgreSQL fixture. It
uses a separate SQL observer and verifies that both peers reject the SQL control
route with 404. `--periodic` waits through the actual production interval;
`--shutdown` holds a real INSERT during process shutdown.

The next connection-service discrepancy is automatic legacy provider credential
capture/purge. An actual external-PostgreSQL account comparison observes Node
capture the opaque credential, persist revision 1 and acknowledge purge. Rust
sends neither command and retains `migration-needed` at revision 0; both
processes exit zero. Rust's existing `migrate_worker` service has no production
caller. The reproduction is retained with this milestone; that repair remains
separate work. The subsequent [credential reconnect qualification](RUST_SERVER_CREDENTIAL_RECONNECT.md)
repairs that composition and records its actual failure/recovery and shutdown
scope. Remaining full product, fault, coordination,
performance, historical-profile, current-artifact and supported-platform
acceptance, Rust default selection and production Node-server removal remain
required.
