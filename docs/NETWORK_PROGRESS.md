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

| Pass                            | Scope                                                                                      | Status      | Branch                                   | PR      | Validation | Notes or deviations               |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------- | ------- | ---------- | --------------------------------- |
| 1 — Ledger, ADR, protocol       | Create this ledger, ADR 0009, and strict bounded WorkerLink contracts and tests            | In progress | `codex/network-tranche1-pass1-contracts` | Pending | Pending    | Runtime routing remains unchanged |
| 2 — Server/worker lifecycle     | Add the transient coordinator, gateway, grants, expiry, revocation, and generation fencing | Not started | —                                        | —       | —          | —                                 |
| 3 — Client manager and carriers | Add the shared manager and wrap current LOCAL and RELAY paths                              | Not started | —                                        | —       | —          | —                                 |
| 4 — Terminal                    | Move Terminal route ownership beneath WorkerLink                                           | Not started | —                                        | —       | —          | —                                 |
| 5 — Tunnels and project shares  | Move saved/managed tunnels and WebDAV streams behind WorkerLink                            | Not started | —                                        | —       | —          | —                                 |
| 6 — Cantrip Code                | Move Code HTTP/WebSocket acquisition and pooling behind WorkerLink                         | Not started | —                                        | —       | —          | —                                 |
| 7 — Hardening and release gate  | Audit topology branches, complete diagnostics/tests, and run the acceptance matrix         | Not started | —                                        | —       | —          | —                                 |

## Tranche One acceptance checklist

- [ ] A single WorkerLink abstraction owns feature-facing route selection.
- [ ] One logical session is keyed to the exact client/server/worker-process identity.
- [ ] Server-issued resource grants are short-lived, bounded, and independently revocable.
- [ ] Unauthorized, expired, replayed, cross-account, cross-session, and wrong-generation opens fail closed.
- [ ] LOCAL and RELAY implement the same logical channel contract and LOCAL failure falls back automatically.
- [ ] Route generations reject stale replacement-channel frames.
- [ ] Interactive and stream queues and credit cannot starve Terminal input.
- [ ] Terminal uses WorkerLink with Tauri LOCAL and hosted RELAY parity.
- [ ] Generic tunnels and project shares use WorkerLink without changing encryption, listeners, mounts, or lifecycle.
- [ ] Cantrip Code uses WorkerLink without changing HTTP/WebSocket behavior, protection, or pooling.
- [ ] Browser and Capacitor RELAY behavior remains functional.
- [ ] Durable application state remains server-authoritative.
- [ ] Metrics distinguish LOCAL and RELAY without sensitive or high-cardinality labels.
- [ ] Focused validation and the final repository check pass.
- [ ] Every pass PR is squash-merged, `origin/main` contains the tranche, Primary is synchronized, and goal worktrees are removed.

## Blockers and known risks

- No current blocker.
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

## Next expected pass

Pass 1 validation and merge, followed by Pass 2: server/worker session and
grant lifecycle.
