# Rust Redis coordination

The native `coordination::RedisCoordinator` implements the existing Node
coordinator's Redis directory and message envelopes. The native
`workers::coordinated::CoordinatedBridge` implements shared worker routing.
The authenticated worker socket and resource services accept a local or shared
`WorkerTransport`; production startup still selects the local implementation.
Shared startup, WorkerLink authority and App Live still need integration and
product acceptance.
Setting `REDIS_URL` on the Rust server does not yet enable shared routing.
Node remains the default server and the worker remains Node.

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
