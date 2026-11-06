# Rust Redis coordination

The native `coordination::RedisCoordinator` implements the existing Node
coordinator's Redis directory and message envelopes. Production startup does
not yet construct it: coordinated worker routing, WorkerLink authority routing
and App Live distribution still need integration and product acceptance.
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
deployment, TLS operation, Linux/Windows artifacts or packaging acceptance.

All development validation runs locally. GitHub Actions remains reserved for
releases and deployments.
