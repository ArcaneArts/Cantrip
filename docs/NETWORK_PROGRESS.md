# Client-worker network fabric progress

- Tranche One: In progress
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

| Pass                            | Scope                                                                                      | Status      | Branch                                        | PR                                                       | Validation                                                                                                                                                  | Notes or deviations                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1 — Ledger, ADR, protocol       | Create this ledger, ADR 0009, and strict bounded WorkerLink contracts and tests            | Complete    | `codex/network-tranche1-pass1-contracts`      | [#1163](https://github.com/ArcaneArts/Cantrip/pull/1163) | Protocol typecheck and 349 focused tests; workspace typecheck; Code/Codex source verification; CLI check; changed-file formatting; diff check               | Runtime routing remains unchanged; repository-wide baseline failures are recorded below                          |
| 2 — Server/worker lifecycle     | Add the transient coordinator, gateway, grants, expiry, revocation, and generation fencing | Complete    | `codex/network-tranche1-pass2-lifecycle`      | [#1168](https://github.com/ArcaneArts/Cantrip/pull/1168) | Workspace/package typechecks; WorkerLink protocol 8, server 38, worker 37; source/CLI verification; changed-file format and diff checks                     | Exact generation fencing is wired; the path stays dormant until an adapter is registered                         |
| 3 — Client manager and carriers | Add the shared manager and wrap current LOCAL and RELAY paths                              | Complete    | `codex/network-tranche1-pass3-client-manager` | [#1171](https://github.com/ArcaneArts/Cantrip/pull/1171) | Workspace/package typechecks; focused protocol 9, app 8, worker 11, server 41; full app 1,571; source/CLI verification; changed-file format and diff checks | Shared transient claims and authority RPC remove sticky-session dependence; baseline failures are recorded below |
| 4 — Terminal                    | Move Terminal route ownership beneath WorkerLink                                           | Complete    | `codex/network-tranche1-pass4-terminal`       | Pending                                                  | Workspace typecheck; focused protocol 9, app 11, worker 13, server 21; full app 1,580; source/CLI verification; changed-file format and diff checks         | Server-authorized PTY bootstrap and encrypted I/O now use WorkerLink; compatibility endpoints remain             |
| 5 — Tunnels and project shares  | Move saved/managed tunnels and WebDAV streams behind WorkerLink                            | Not started | —                                             | —                                                        | —                                                                                                                                                           | —                                                                                                                |
| 6 — Cantrip Code                | Move Code HTTP/WebSocket acquisition and pooling behind WorkerLink                         | Not started | —                                             | —                                                        | —                                                                                                                                                           | —                                                                                                                |
| 7 — Hardening and release gate  | Audit topology branches, complete diagnostics/tests, and run the acceptance matrix         | Not started | —                                             | —                                                        | —                                                                                                                                                           | —                                                                                                                |

## Tranche One acceptance checklist

- [ ] A single WorkerLink abstraction owns feature-facing route selection.
- [x] One logical session is keyed to the exact client/server/worker-process identity.
- [x] Server-issued resource grants are short-lived, bounded, and independently revocable.
- [x] Unauthorized, expired, replayed, cross-account, cross-session, and wrong-generation opens fail closed.
- [x] LOCAL and RELAY implement the same logical channel contract and LOCAL failure falls back automatically.
- [x] Route generations reject stale replacement-channel frames.
- [x] Interactive and stream queues and credit cannot starve Terminal input.
- [x] Terminal uses WorkerLink with Tauri LOCAL and hosted RELAY parity.
- [ ] Generic tunnels and project shares use WorkerLink without changing encryption, listeners, mounts, or lifecycle.
- [ ] Cantrip Code uses WorkerLink without changing HTTP/WebSocket behavior, protection, or pooling.
- [ ] Browser and Capacitor RELAY behavior remains functional.
- [ ] Durable application state remains server-authoritative.
- [ ] Metrics distinguish LOCAL and RELAY without sensitive or high-cardinality labels.
- [ ] Focused validation and the final repository check pass.
- [ ] Every pass PR is squash-merged, `origin/main` contains the tranche, Primary is synchronized, and goal worktrees are removed.

## Blockers and known risks

- No current blocker.
- The repository-wide `pnpm check` currently stops at the pre-existing
  `audit:server-boundaries` failure: “Client-control notification E2EE boundary
  regressed: client: protected notification path is missing.” Root formatting
  reports six unmodified files:
  `cantrip_app/src/components/ui/dialog.test.ts`,
  `cantrip_app/src/lib/client-session.ts`,
  `cantrip_app/src/lib/desktop-tunnel.test.ts`,
  `cantrip_app/src/lib/desktop-tunnel.ts`,
  `cantrip_app/src/lib/server-connections.ts`, and
  `cantrip_server/test/chat-turn-retry-repository.test.ts`.
- The full protocol suite has 356 passing tests and one unrelated failure: the
  read-only permission result omits `web.session.snapshot` even though the
  exported read catalog includes it. The exact failure was reproduced in a
  detached worktree at current `origin/main`; the WorkerLink protocol suite is
  9/9. Later passes must continue running focused validation and recheck these
  repository gates.
- The current full app suite passes 1,580 tests with three skipped. The full
  worker suite has 872 passing, two skipped, and one unrelated packaged MCP
  catalog-order failure; the same failure reproduces on the synchronized
  Primary checkout. The full server suite continues to report broad
  pre-existing schema/test drift; a representative `local-foundation.test.ts`
  failure reproduces on Primary. Pass-specific server and worker surfaces
  remain green.
- The migration crosses TypeScript browser/server/worker code and the native
  Tauri forwarder. Later passes must keep compatibility adapters until every
  supported client uses the WorkerLink-facing boundary.
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

## Next expected pass

Pass 5: migrate saved tunnels, managed Browser tunnels, and protected project
shares behind WorkerLink while preserving native listeners, mounts, encryption,
and lifecycle behavior.
