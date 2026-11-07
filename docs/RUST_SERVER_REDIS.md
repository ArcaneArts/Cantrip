# Rust Redis coordination

The native `coordination::RedisCoordinator` implements the existing Node
coordinator's Redis directory and message envelopes. The native
`workers::coordinated::CoordinatedBridge` implements shared worker routing.
The authenticated worker socket and resource services accept a local or shared
`WorkerTransport`.
The native `worker_links::authority::Authority` also implements the existing
WorkerLink service's distributed operations and revocation. Production WorkerLink
HTTP handlers and resource consumers now use that authority through the composed
service and relay. Setting `REDIS_URL` now starts one native coordinator and
shares it across worker transport, WorkerLink and App Live. Readiness observes
its actual command connection, and shutdown closes it after service drains.
Transient recovery uses the observed instance count; background job recovery
retains unexpired peer leases whenever coordination is configured.
The full worker now passes local resource/native execution and orderly mixed
peer replacement checks described in [shared product acceptance](RUST_SERVER_SHARED_PRODUCT.md).
Active-execution failures, long outages and supported-platform acceptance remain
required.
Node remains the default server and the worker remains Node.

The Redis client is pinned to the vendored upstream 1.8.1 crate. Its original
archive checksum and three additional connection-observation methods are
documented in [the client provenance note](../cantrip_server_rs/third-party/redis/README.cantrip.md).
Inherited trailing whitespace is removed from its README, changelog and the
two changed Rust files; other upstream file bytes remain unchanged.
TLS, parsing, authentication and reconnect use the upstream implementation.
Cantrip's ordered command queue retains directory operations through reconnect;
publication and readiness reject an actually unavailable command connection
without waiting for that queue. No subscriber flag or separate TCP probe stands
in for the command driver's state.

## Implemented contracts

- The existing `cantrip:relay:v1` namespace, `:messages` channel and URI-component
  encoding of instance, worker and WorkerLink session keys.
- Subscribe-before-hydration startup, live presence hydration, private instance
  heartbeat, instance-count health and shutdown removal of the instance key.
- Worker claim replacement, connection/instance checks and raw-value Lua
  compare-and-set renewal/release. A claim returns the previous owner.
- WorkerLink session validation, exact lease timestamp matching, atomic `NX`
  election and authority-fenced compare-and-set renewal/release.
- Existing envelope metadata, missing/null behavior, UTF-16 length limits,
  opaque fields, number serialization, fractional message TTLs and the full
  encrypted-control message byte limit. Redis UTF-8 replacement matches Node.
- Cache expiry, self/target filtering and received/rejected/sent counters.
  Malformed or oversized raw subscriber messages are ignored before the
  coordinator counters, as in Node. The coordinator delivers repeated message
  IDs; durable execution deduplication belongs to its consumers.
- Live listener registration order, removal/addition during callbacks and
  isolated listener failures. Pending callbacks do not block reception of a
  later message that may resolve them.
- Command reconnect and subscriber resubscription after interruption. Pub/sub
  is ephemeral: this layer does not add replay of messages sent while offline.
- Shared worker claims, owner and attachment fencing, same-process reconnect
  grace, legacy connections without continuity assertions, ordered remote
  command events/responses, inference phase deadlines, notifications and opaque
  surface, tunnel and WorkerLink frames. Already validated local WorkerLink
  frames retain their original bytes; remote delivery rebuilds the carrier.
- Incoming requests recheck the captured attachment after the asynchronous
  owner lookup. Superseded attachment cleanup releases only its exact claim.
  Missing timeout and explicit null remain distinct; reply TTL validation does
  not coerce malformed timeout values.
- Resource services use the same transport interface for commands, connection
  identity, notifications, disconnection and binary frames. Its shared adapter
  starts attachment generation fencing before returning an awaitable future,
  retains the operation if its caller drops that future, and owns asynchronous
  shutdown cleanup. Credential revocation never waits behind Redis IO.
- The worker WebSocket continues reading bounded early input, close frames and
  shutdown while a shared claim is pending. A closed socket cannot subsequently
  become ready when that Redis operation completes.
- WorkerLink local-first session authorization, NX authority election after
  worker installation, remote session/peer/grant RPCs, claim renewal and
  re-election, account/owner/resource/attachment revocation and relay callbacks.
  The service preserves the ten-second RPC timeout, missing response results,
  500 UTF-16-unit error limit, caller-drop lifetime and exact-authority cleanup.
  Bulk revocation retains the reference directory-claim TTL behavior.
- WorkerLink HTTP authorization awaits the authority before entering operation
  error handling. Authorization failures and uncaught DELETE failures retain
  the reference general 500 response; caught operation failures retain their
  409/502 responses. Resource revocation and auth cleanup propagate failures in
  the reference order. Service revocations start eagerly and remain owned when
  their caller drops the future.
- The composed service retains its relay-revocation subscription and releases
  it before relay shutdown. During the second, upgraded WebSocket authorization
  lookup, the socket handles Ping, client close and shutdown while discarding
  application frames received before relay attachment. A rejected upgraded
  authorization terminates the connection without a Close frame, matching the
  reference WebSocket handler's 1006 client observation.

The runtime uses the native Redis client with Tokio and native TLS support.
There is no JavaScript database or coordination helper in this module. The
Node driver is exclusively a development oracle invoking the production Node
class. Database transactions remain authoritative for durable execution state.
Operational events use the existing redacted logger; connection strings,
credentials, Redis error details and message contents are not logged.

## Local acceptance

Build the server's TypeScript dependencies, then provide a local Redis binary:

```sh
pnpm --filter '@cantrip/server^...' -r build
node --import tsx scripts/server-rust/redis-coordination-compatibility.mjs \
  --redis-bin /path/to/redis-server \
  --report .qa/rust-redis/coordination.json
```

The harness builds a development-only Rust driver, launches a private loopback
Redis process in a new disposable directory and runs Node/Node, Node/Rust,
Rust/Node and Rust/Rust pairs. It never connects to `REDIS_URL` or an existing
Redis service. `--pair rust/node` selects a focused pair. Raw process output,
failures and the fixture directory are retained. Both subscribers acknowledge
fresh messages after reconnect before the suite asserts bidirectional peer
delivery; a successful command PING alone does not prove subscriber recovery.

Local macOS arm64 acceptance passed all four pairs and 52 scenario groups using
Redis 8.10.3. Coverage includes live startup hydration, malformed/expired keys,
opaque Unicode payloads, UTF-16 boundaries, stale worker replacement, concurrent
WorkerLink election, 16 real read/EVAL interleavings preserving intervening writes,
listener mutation/failure/reentrancy, exact maximum-size
messages, instance limits, expiry and real Redis process interruption/restart.
This does not prove full coordinated worker execution, mixed rolling product
deployment, outage-response timing/backlog, TLS operation, Linux/Windows
artifacts or packaging acceptance.

All development validation runs locally. GitHub Actions remains reserved for
releases and deployments.

The separate shared-bridge harness uses the actual Node and Rust bridge classes
with controlled worker sockets and owner lookups, and the same private Redis:

```sh
node scripts/server-rust/coordinated-bridge-compatibility.mjs \
  --redis-bin /path/to/redis-server \
  --report .qa/rust-coordinated/bridge.json
```

Local macOS arm64 acceptance passed 172 scenarios across all four pairings.
These cover command results/errors, ordered protected terminal events, event
handler failures, all three binary relays, reconnect continuity without input
replay, repeated legacy reconnects, generation replacement, attachment races at
real Redis claim/renew awaits, exact old-claim cleanup, grace expiry, missing/null
and coerced timeout inputs, expired requests, remaining receiver budgets,
sender clock skew and delayed offline publications.

The native fixture now drives attachment, subscriptions, frames and shutdown
through the runtime transport adapter. Additional cases exercise the command
delegate on local and remote workers, reject a mismatched owner before dispatch,
and drop an attachment future while its owner lookup is paused. The attachment
still acquires a real Redis claim and routes a subsequent command after release.

All native targets compile. The 72 local native tests include the database-backed
credential-revocation race and the interface's eager lifetime/correlation cases.
Real Node/Rust HTTP/WebSocket ingress with the unchanged worker enrollment,
heartbeat and WorkerConnection also passes using PGlite. This HTTP acceptance
uses local transport; it does not establish shared HTTP/SQL product behavior.

The suite fills the 512-publication, 2,048-pending-command and 512-incoming-command
bounds. It asserts overflow behavior, real socket delivery after publications
drain, and cleanup of every retained request when ownership goes offline or the
worker disconnects.

The outage cases save the real Redis directory, kill Redis, restart it from
that data and confirm actual bidirectional subscriber recovery. A short outage
retains the worker socket, pending command and claim generation. Even when a
local cache expires, the socket stays until Redis confirms claim loss; confirmed
expiry closes it with code 1012, after which a fresh attachment routes again.

This harness does not launch production HTTP/SQL services, the full WorkerLink
authority service or App Live. Remaining malformed relay payload cases, outage
response timing/backlog, TLS, other platforms and packaged artifacts still need
qualification. These results do not establish mixed rolling product deployment
or readiness to replace the default Node server.

The WorkerLink service has a separate compatibility suite:

```sh
node --import tsx scripts/server-rust/worker-link-authority-compatibility.mjs \
  --redis-bin /path/to/redis-server \
  --report .qa/rust-worker-links/authority.json
```

It invokes the unchanged Node `WorkerLinkService` and the native `Authority`
around their actual local coordinators. A private real Redis instance carries
the directory claims and operation requests/responses; worker acknowledgments
are controlled at the existing request callback. Local macOS arm64 acceptance
passes 68 scenario groups across all four pairings. Cases include remote
authorization and tenant filters,
expired claims, complete peer/grant operations, exact capability hashes, live
relay-listener mutation/deduplication/failure, ownership conflict after worker
installation, claim replacement during renewal, fallback NX election, caller
future abandonment, split-surrogate error bounds, late replies, the real
ten-second timeout and pending-operation shutdown. The parser's accepted
String-coerced reason retains its original value in worker commands.
Malformed grant fields accepted by the RPC parser return the reference property
errors and leave the coordinator usable; they cannot poison its state lock.

A separate native library test executes 2,445 comparisons against verbatim
reference helper source with the actual protocol schemas. These cover parser
normalization/defaults/unknown fields, malformed inputs and UTF-16 bounds.
Neither suite establishes production HTTP/SQL integration, real-worker product
behavior, Redis outage timing, supported-platform artifacts or mixed rolling
deployment readiness. Arbitrary malformed RPC error envelopes outside the typed
response contract also need separate qualification.

The existing `worker-link-http-compatibility.mjs --database pglite --keep-data`
suite retains its real database and server fixture directory in the report's
`root` field for inspection. Build TypeScript dependencies again after changing
Git revisions so both peers use the same generated server version metadata.

The authority harness also constructs the actual native `Service` and both
implementations' real relay classes. Its expanded 96 scenario groups across
all four pairings include closing attached relay sockets on route, session,
account and owner revocation; retaining session sockets on resource-only
revocation; harmless unmatched UTF-16 scopes; and eager service revocation
while a worker acknowledgment is held. Shutdown closes attached sockets before
authority cleanup. Worker acknowledgments and relay sockets remain controlled;
these cases do not establish real remote binary worker execution.

The HTTP authorization and await boundaries have a separate local harness:

```sh
node --import tsx scripts/server-rust/worker-link-http-boundary-compatibility.mjs \
  --redis-bin /path/to/redis-server \
  --report .qa/rust-worker-links/http-boundaries.json
```

It launches the production handlers with isolated PGlite databases and private
Redis. Thirty observations per implementation compare authorization and
operation failures, the real ten-second RPC timeout, pre-upgrade rejection,
post-upgrade termination, Ping during held authorization, discarded early data,
client close and shutdown. Controlled faults run after real Redis directory
reads. The native fixture replaces only the WorkerLink service dependency;
other services retain their ordinary local composition. This is HTTP facade
acceptance, not shared production bootstrap, Redis outage timing or full
multi-instance product acceptance.

The existing local HTTP/WebSocket suite also passes with authority-backed
handlers on PGlite, external PostgreSQL and private bundled PostgreSQL. Each
store covers `none` and `accounts` authentication with 182 paired observations
and controlled acknowledgments through the unchanged worker connection.
These macOS arm64 results do not qualify Linux/Windows artifacts, packaging,
App Live coordination or a mixed rolling product deployment.

## Shared HTTP runtime

The shared-runtime suite launches two complete HTTP/SQL service graphs against
one private PostgreSQL database and Redis process. It exercises Node/Node,
Node/Rust, Rust/Node and Rust/Rust with `none`, `password` and `accounts` auth:

```sh
node --import tsx scripts/server-rust/shared-runtime-http-compatibility.mjs \
  --redis-bin /path/to/redis-server \
  --report .qa/rust-shared-runtime/http.json
```

Select a focused combination with `--profile accounts --pair node/rust`.
Both servers use the same real account session, as behind a load balancer.
Local macOS arm64 acceptance passes 168 groups across all 12 combinations,
with all 24 server processes shutting down cleanly.
The fixture observes the actual Node Hub and includes the actual Rust executable
entry point; private SQL and publication routes exist only in test launchers.
Production handlers, services and coordination remain in use.

Cases cover committed enrollment and cross-instance Live invalidation/replay,
256-event synchronous bursts and eight concurrent 64-event producers in both
directions, active surfaces and six unexpired claimed job rows across five
services. The unchanged production `WorkerConnection` attaches only to one peer;
the opposite peer installs a WorkerLink session, cross-authority renew/delete
works, and actual relay sockets on both peers close on revocation. Account cases
also reject foreign worker/session access and relay upgrades, retain the owner's
session after foreign DELETE, and isolate local/external Live events by owner.

The Redis fault kills the real process after SAVE and restarts its retained
directory. Readiness keeps SQL ready while reporting coordination unavailable;
confirmed fanout rejects promptly after the local event; unconfirmed offline
events are not replayed on reconnect. Recovery requires an actual publication
observed on both subscribers, followed by new remote worker operations on the
original worker connections. This bounds a short outage; Redis is restored
before application cleanup and does not prove shutdown with Redis still down.

The suite exposed native publication reordering and a 9.46-second unavailable
readiness response. Publication now begins its callback before the next local
publication, and concurrent producers share that ordering boundary. The native
Redis queue observes the actual command driver's state for fail-fast operations
while preserving directory reads through reconnect. The directory suite now
passes 56 groups across four pairings, including queued reads during a real
11-second outage, plus the existing 16 CAS interleavings.

Shutdown admission has a deterministic real-Redis regression:

```sh
node --import tsx scripts/server-rust/coordinated-shutdown-compatibility.mjs \
  --redis-bin /path/to/redis-server \
  --report .qa/rust-coordinated/shutdown.json
```

All four pairings pass 12 groups. A held owner lookup previously resumed after
the bridge's pending-request drain in both implementations, dispatched a command
whose response listener had already been removed, and eventually returned a
command timeout. Both bridges now retain the normal shutdown unavailable error
after directory/owner awaits and reject new post-close requests. Native pending
insertion shares the shutdown drain's state lock. The expanded HTTP suite also
caught this as a process shutdown deadline failure; that assertion remains.

WorkerLink acknowledgments and seeded active job leases are controlled here.
These checks do not establish full worker resource/job execution, job lease
renewal/expiry, complete mixed rolling product behavior, Redis TLS, other
platforms or packaged/deployed artifacts. Existing-data upgrades, post-write
rollback and default server cutover remain separate requirements.

## Full worker and orderly peer replacement

The [shared product suite](RUST_SERVER_SHARED_PRODUCT.md) runs the existing
browser SDK and complete packaged worker on opposite production peers. The
Node comparison uses its real compiled entry point; Rust uses its normal
executable. Each pairing owns a private shared PostgreSQL database and Redis
process. Public model responses are controlled for native execution.

Local macOS ARM64 runs passed 300 recorded steps across all four pairings:
encrypted files, workspace/dirty-document retention, PTYs and WorkerLink,
native Tasks and planning/Goal, retry/paused admission, Agent-to-Task MCP,
Agent Goal tools and canonical history. All 88 worker and 128 server process
exits were clean. Thirty-two orderly peer replacements retained the same full
worker PID during the rolling phase, its credential, the real browser session,
App Live recovery, exact completed conversation/Task state and encrypted file
reads/writes. Managed history is sampled after real terminal native archives
have materialized; synthetic supplements remain in the exact comparison.

Completed native work precedes replacement in this suite. It does not qualify
in-flight execution failover, crash recovery, lease expiry, delayed
acknowledgment, long Redis outage/shutdown, Redis TLS, multi-host networking,
other platforms, performance or complete replacement readiness.
