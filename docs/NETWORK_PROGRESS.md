# Client-worker network fabric progress

- Tranche One: Complete
- Tranche Two: Not started
- Architecture: [NETWORK.md](NETWORK.md)
- Execution started: 2026-08-26

This is the execution ledger for the network fabric. Tranche One builds the
shared WorkerLink session, authorization, routing, and reliable-stream boundary
while preserving the currently operational `LOCAL -> RELAY` behavior.

## Tranche boundary

Tranche One includes the WorkerLink protocol, transient server coordinator,
worker gateway, client manager, LOCAL and RELAY carriers, QoS/flow-control
foundation, and migration of Terminal, saved and managed tunnels, project
shares, and Cantrip Code. The server remains authoritative for durable state.

Tranche Two remains explicitly deferred: LAN candidate gathering and
classification, WAN negotiation, default STUN configuration, VPN runtime
classification, a feature-neutral WebRTC peer carrier, native LAN/WAN tunnels,
browser or Capacitor peer-direct Code/Terminal, Browser and Remote Desktop
migration, direct worker observations, incremental chat and file watcher
events, network-mobility reprobes beyond current transports, TURN, transparent
TCP resumption, and final legacy-relay consolidation.

## Passes

| Pass                            | Scope                                                                                      | Status   | Branch                                         | PR                                                       | Validation                                                                                                                                                                                                                                | Notes or deviations                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Ledger, ADR, protocol       | Create this ledger, ADR 0009, and strict bounded WorkerLink contracts and tests            | Complete | `codex/network-tranche1-pass1-contracts`       | [#1163](https://github.com/ArcaneArts/Cantrip/pull/1163) | Protocol typecheck and 349 focused tests; workspace typecheck; Code/Codex source verification; CLI check; changed-file formatting; diff check                                                                                             | Runtime routing remains unchanged; repository-wide baseline failures are recorded below                                                                 |
| 2 — Server/worker lifecycle     | Add the transient coordinator, gateway, grants, expiry, revocation, and generation fencing | Complete | `codex/network-tranche1-pass2-lifecycle`       | [#1168](https://github.com/ArcaneArts/Cantrip/pull/1168) | Workspace/package typechecks; WorkerLink protocol 8, server 38, worker 37; source/CLI verification; changed-file format and diff checks                                                                                                   | Exact generation fencing is wired; the path stays dormant until an adapter is registered                                                                |
| 3 — Client manager and carriers | Add the shared manager and wrap current LOCAL and RELAY paths                              | Complete | `codex/network-tranche1-pass3-client-manager`  | [#1171](https://github.com/ArcaneArts/Cantrip/pull/1171) | Workspace/package typechecks; focused protocol 9, app 8, worker 11, server 41; full app 1,571; source/CLI verification; changed-file format and diff checks                                                                               | Shared transient claims and authority RPC remove sticky-session dependence; baseline failures are recorded below                                        |
| 4 — Terminal                    | Move Terminal route ownership beneath WorkerLink                                           | Complete | `codex/network-tranche1-pass4-terminal`        | [#1173](https://github.com/ArcaneArts/Cantrip/pull/1173) | Workspace typecheck; focused protocol 9, app 11, worker 13, server 21; full app 1,580; source/CLI verification; changed-file format and diff checks                                                                                       | Server-authorized PTY bootstrap and encrypted I/O now use WorkerLink; compatibility endpoints remain                                                    |
| 5A — Generic tunnel substrate   | Add exact tunnel grants, nested frame transport, worker adapter, and attachment fencing    | Complete | `codex/network-tranche1-pass5-tunnels`         | [#1182](https://github.com/ArcaneArts/Cantrip/pull/1182) | Workspace typecheck; protocol 312; app 1,582; worker 875; focused protocol 10, server 8, app 9, worker 15; source/CLI verification; format and diff checks                                                                                | Pass 5 was split so authorization/data-plane review remains independent from the native listener lifecycle cutover                                      |
| 5B — Tunnel and share cutover   | Move saved/managed tunnels and WebDAV streams behind WorkerLink                            | Complete | `codex/network-tranche1-pass5b-native-tunnels` | [#1183](https://github.com/ArcaneArts/Cantrip/pull/1183) | Workspace typecheck; focused app 120 and full app 1,572; Rust fmt/check and bridge 2; source/CLI verification; changed-file format and diff checks                                                                                        | Native loopback listeners bridge the shared WorkerLink stream; Cantrip Code remains on compatibility transport until Pass 6                             |
| 6A — Hosted and dedicated Code  | Move browser/Capacitor and dedicated desktop Code transport behind WorkerLink              | Complete | `codex/network-tranche1-pass6-code`            | [#1184](https://github.com/ArcaneArts/Cantrip/pull/1184) | Workspace/app typecheck; focused app 97 and full app 1,571; source/CLI verification; changed-file format and diff checks                                                                                                                  | Pass 6 is split so the browser service-worker boundary is reviewed separately from native process-wide pool ownership                                   |
| 6B — Shared desktop Code pool   | Move the process-wide Tauri Code transport pool and handoff behind WorkerLink              | Complete | `codex/network-tranche1-pass6b-code-pool`      | [#1185](https://github.com/ArcaneArts/Cantrip/pull/1185) | Workspace/app typecheck; focused app 70 and full app 1,572; Rust fmt/check and WorkerLink/pool 4; source/CLI verification; changed-file format and diff checks                                                                            | Preserves generation-fenced multi-window leases, carrier handoff, and stable localhost ownership without feature fallback                               |
| 7 — Hardening and release gate  | Audit topology branches, complete diagnostics/tests, and run the acceptance matrix         | Complete | `codex/network-tranche1-pass7-hardening`       | [#1186](https://github.com/ArcaneArts/Cantrip/pull/1186) | Workspace typecheck/build; cutover audit; focused protocol 10, app 154, server 55 plus isolated Browser attachment, worker 54; full protocol 359, app 1,573, worker 880; Rust fmt/check and 4; source/CLI/changed-file format/diff checks | Adds bounded authenticated WorkerLink telemetry, low-cardinality metrics, negative/congestion coverage, and removes the unused Terminal topology helper |

## Tranche One acceptance checklist

- [x] A single WorkerLink abstraction owns feature-facing route selection.
- [x] One logical session is keyed to the exact client/server/worker-process identity.
- [x] Server-issued resource grants are short-lived, bounded, and independently revocable.
- [x] Unauthorized, expired, replayed, cross-account, cross-session, and wrong-generation opens fail closed.
- [x] LOCAL and RELAY implement the same logical channel contract and LOCAL failure falls back automatically.
- [x] Route generations reject stale replacement-channel frames.
- [x] Interactive and stream queues and credit cannot starve Terminal input.
- [x] Terminal uses WorkerLink with Tauri LOCAL and hosted RELAY parity.
- [x] Generic tunnels and project shares use WorkerLink without changing encryption, listeners, mounts, or lifecycle.
- [x] Cantrip Code uses WorkerLink without changing HTTP/WebSocket behavior, protection, or pooling.
- [x] Browser and Capacitor RELAY behavior remains functional.
- [x] Durable application state remains server-authoritative.
- [x] Metrics distinguish LOCAL and RELAY without sensitive or high-cardinality labels.
- [x] Focused validation and the final repository check were run; WorkerLink scopes pass and only independently reproduced repository baseline failures remain.
- [x] Every pass PR is squash-merged, `origin/main` contains the tranche, Primary is synchronized, and goal worktrees are removed when this ledger reaches `main` through PR #1186.

## Blockers and known risks

- No current blocker.
- The repository-wide `pnpm check` currently stops at the pre-existing
  `audit:server-boundaries` failure: “Client-control notification E2EE boundary
  regressed: client: protected notification path is missing.” Root formatting
  reports four unmodified files:
  `cantrip_app/src/components/ui/dialog.test.ts`,
  `cantrip_app/src/lib/client-session.ts`,
  `cantrip_app/src/lib/server-connections.ts`, and
  `cantrip_server/test/chat-turn-retry-repository.test.ts`.
- The final full protocol suite passes 359 tests. The final full app suite
  passes 1,573 tests with three skipped. The final full worker suite passes 880
  tests with two skipped across 141 passing files and one skipped file. The
  broad server suite continues to report pre-existing schema and version
  fixture drift; representative failures reproduce on Primary, while the final
  focused WorkerLink, metrics, placement, Browser attachment, and tunnel
  control surfaces pass.
- Two existing native tunnel-forward tests that launch the real packaged Code
  transport time out under the current Node 24/Rust test harness (44 sibling
  tunnel-forward tests pass). The same recovery-case timeout reproduces on the
  synchronized Primary checkout and its spawned Node harness exits with EPIPE.
  The four WorkerLink bridge tests and `cargo check` pass. App-wide Clippy
  also exposes pre-existing warnings throughout the tunnel forwarder and local
  logging under the current Rust toolchain; the changed Rust code is formatted
  and compiles successfully.
- The migration crosses TypeScript browser/server/worker code and the native
  Tauri forwarder. Compatibility endpoints remain intentionally available for
  older supported clients; the automated Tranche One cutover audit prevents
  migrated feature entry points from reclaiming route selection.
- Existing Code transport authority is process-local in multi-replica
  deployments. WorkerLink must preserve the current fail-closed behavior while
  using the coordination abstraction; Tranche One does not broaden Code
  affinity behavior.

## Implementation decisions

- ADR 0009 generalizes authorization above ADR 0008 rather than replacing the
  loopback proof.
- The protocol reserves all four route names and five QoS lanes; only LOCAL and
  RELAY are operational in Tranche One.
- Existing tunnel-data-plane v1 frames can be nested unchanged in a reliable
  WorkerLink stream.
- Client bearer grant tokens are separated from the hashes installed on the
  worker.
- Telemetry payloads accept only bounded route, lane, event, count, latency,
  and reason vocabularies; tenant and resource identifiers are not labels.
- WorkerLink session state remains transient, but a short-lived session claim
  in the existing relay-coordination abstraction names the authoritative
  server instance. Any authenticated server replica can authorize a request,
  forward mutations to that authority, and carry RELAY frames through the
  existing worker bridge; deployments with shared coordination therefore do
  not require sticky HTTP/WebSocket sessions. The in-memory and Redis backends
  implement the contract, and a future server-to-server backend can implement
  the same abstraction.
- The worker gateway accepts sessions from the authenticated server command
  plane, fences the durable server identity plus the client-facing server
  generation, owner, account session, worker, and worker-process generation,
  and exposes no resource until a feature-specific adapter is registered.
- Route-generation replacement retires active worker channels before the
  replacement is acknowledged. Logout fences are transient around revocation,
  allowing a later authenticated account session to establish fresh authority.
- LOCAL and RELAY carry the identical bounded binary frames. Adapters cannot
  emit before acceptance is delivered, receive credit is returned only after
  the client consumer acknowledges data, and per-lane bounded scheduling gives
  interactive traffic greater service without sharing bulk queue capacity.
- Browser and Capacitor clients intentionally select RELAY in Tranche One;
  Tauri probes the authenticated loopback broker first and automatically
  replaces the route with RELAY when LOCAL setup fails.
- Interactive Terminal sessions now obtain an exact, short-lived grant after
  the server authorizes and starts the PTY through the existing worker command
  plane. The bootstrap attachment discards its output because the WorkerLink
  adapter replays the worker-owned terminal buffer before announcing readiness.
- Terminal input, output, resize, exit, reconnect, grant renewal, and grant
  revocation use the shared WorkerLink stream contract. Existing protected
  Terminal payloads remain end-to-end encrypted, bounded queues return credit
  only after client consumption, and the interactive lane prevents bulk stream
  traffic from starving Terminal input.
- Worker-observed Terminal exit state is generation-fenced before the server
  updates durable status. The legacy Terminal relay and direct endpoints remain
  available as compatibility surfaces, but the supported Terminal view no
  longer selects a topology or opens either endpoint directly.
- Generic tunnel grants bind one existing desktop attachment, protected target,
  worker process, account session, and resource lifetime. The existing tunnel
  data-plane v1 frame remains the inner stream protocol; the client boundary
  performs the same authorized `open` to `connect` transformation previously
  owned by the server relay broker.
- The worker tunnel adapter accepts only protected targets and exact route
  identities, returns outer credit after client consumption, and feeds the
  existing protected TCP, managed Browser, and project-share destination
  router. Attachment deletion or credential rotation revokes only the matching
  WorkerLink grant across coordinated server replicas.
- Tauri continues to own the stable operating-system TCP listener, tunnel v1
  framing, endpoint encryption, credit, and half-close semantics. A bounded,
  token-authenticated loopback WebSocket bridge connects that native engine to
  the feature-neutral WorkerLink stream; a route replacement reconnects the
  bridge stream without rebinding the public listener.
- Long-lived native tunnels rotate the same stable server attachment before its
  hard grant expiration. Revoking the old grant reconnects only the WorkerLink
  stream, while the native listener and its public localhost port remain bound.
- The browser and Capacitor Code adapter keeps its same-origin service-worker
  and WebSocket-shim boundary, but its physical protected tunnel socket is an
  adapter over WorkerLink rather than a feature-owned server-relay WebSocket.
  Endpoint AEAD and the inner tunnel-data-plane v1 protocol remain unchanged,
  and unused legacy relay secrets are wiped immediately after attachment
  allocation.
- The process-wide Tauri Code pool now creates one native WorkerLink-backed
  physical forward per exact pool generation. The native listener and its
  localhost URL remain stable while renderer leases come and go; only an exact
  live window, lease, generation, tunnel, and attachment may claim the stored
  loopback bridge when the carrier is degraded.
- WorkerLink route and attachment-lifetime changes synchronize into the exact
  native Code pool generation before publication. A surviving window can
  attach a replacement carrier after the prior renderer disappears without
  rebinding the listener, while the final exact lease stops the JS carrier,
  native forward, and transient server attachment.
- Shared Code attachment rotation uses the unique physical pool generation as
  its server client identity. Dedicated Code, browser Code, and Capacitor Code
  already use the same WorkerLink abstraction, and the supported Code feature
  no longer performs direct-capability selection or forces its own relay
  fallback.
- WorkerLink clients report bounded best-effort batches for session, channel,
  route, fallback, reconnect, byte, rejection, revocation, and queue-pressure
  events. The server accepts telemetry only for an authenticated exact session,
  rejects future route generations, and permits delayed batches from an older
  generation of that still-live session.
- Prometheus metrics use only the protocol's bounded event, route, lane, reason,
  and direction vocabularies. Session, account, worker, project, resource,
  destination, credential, candidate, and payload values never become labels.
- The obsolete `desktop-terminal.ts` direct-route helper had no supported
  caller and was removed. Public compatibility endpoints and shared direct
  infrastructure remain because older clients may still depend on them.

## Tranche Two handoff

Tranche Two starts from the shared WorkerLink session, grant, QoS, telemetry,
and carrier interfaces delivered here. Its first work should introduce LAN
candidate gathering and classification, WAN direct negotiation with a default
configurable STUN service, VPN classification, and a feature-neutral WebRTC
peer carrier. It can then add native LAN/WAN tunnel carriers and browser or
Capacitor peer-direct Code and Terminal transport before migrating Browser
Remote Surface, Remote Desktop, worker observations, incremental chat, and
filesystem watcher events.

The following remain intentionally unimplemented: LAN/WAN runtime routes,
STUN deployment/configuration, VPN runtime classification, peer WebRTC,
peer-direct browser or Capacitor features, Browser and Remote Desktop
migration, direct observation/chat/watcher delivery, mobility reprobes beyond
current LOCAL/RELAY reconnect, TURN, transparent TCP resumption, and final
legacy-relay consolidation. No Tranche Two runtime behavior is partially
enabled by Tranche One.
