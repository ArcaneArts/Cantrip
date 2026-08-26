# Client-worker network fabric progress

- Tranche One: Stabilized
- Tranche Two: In progress
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

Tranche Two activates the deferred direct-route system in independently
mergeable passes. Its first pass adds bounded peer contracts, deployment policy,
and regression fences without enabling LAN or WAN runtime routing. Candidate
classification, negotiation, carriers, feature migrations, and mobility follow
behind those contracts. TURN and transparent TCP resumption remain intentionally
out of scope.

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

## Stabilization passes

| Pass                          | Scope                                                                                        | Status   | Branch                                   | PR                                                       | Validation                                                                                                                                                                                       | Notes or deviations                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------- | ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 — Code grant regression    | Remove the stale Code-origin grant block and prove exact protected Code attachment authority | Complete | `codex/network-tranche1-stabilize-code`  | [#1187](https://github.com/ArcaneArts/Cantrip/pull/1187) | Workspace typecheck; focused server 43, protocol 17, worker 13; full app 1,573; Rust fmt/check; cutover, formatting, and diff checks                                                             | Tranche One Pass 6 migrated Code clients but left the Pass 5 server migration guard active, causing every Code grant to fail with HTTP 409                                                                      |
| S2 — Route status projection  | Expose feature-neutral current-client WorkerLink lifecycle and route snapshots               | Complete | `codex/network-tranche1-route-status`    | [#1188](https://github.com/ArcaneArts/Cantrip/pull/1188) | Workspace typecheck/build; focused WorkerLink 10; full app 1,575; cutover, changed-file formatting, and diff checks                                                                              | Manager-owned snapshots are exact to client identity and worker; inactive links retain a labeled 30-second last-used route and expose no authority or network secrets                                           |
| S3 — Settings Network Map     | Render truthful control-plane and LOCAL/RELAY data-plane state                               | Complete | `codex/network-tranche1-settings-routes` | [#1190](https://github.com/ArcaneArts/Cantrip/pull/1190) | Workspace typecheck/build; focused Settings 20; full app 1,582; live desktop/narrow browser QA; cutover, formatting, and diff checks                                                             | Current-client worker cards and details consume the shared projection; peer-client data routes remain explicitly unknown and idle presence does not invent a route                                              |
| S4 — Stabilization gate       | Audit the Tranche One cutover and run the final acceptance matrix                            | Complete | `codex/network-tranche1-acceptance`      | [#1191](https://github.com/ArcaneArts/Cantrip/pull/1191) | Workspace typecheck/build; cutover audit; focused protocol 10, app 112, server 79, worker 54; full protocol 359, app 1,582, worker 883; Rust fmt/check and WorkerLink 4; source/CLI verification | All in-scope suites pass; broad repository baseline failures were reproduced from the unchanged `origin/main` base and are recorded below; Tranche Two remains out of scope                                     |
| S5 — WebKit timer receiver    | Preserve the browser receiver when the native WorkerLink bridge schedules or cancels timers  | Complete | `codex/fix-worker-link-window-timers`    | [#1192](https://github.com/ArcaneArts/Cantrip/pull/1192) | Workspace build/typecheck; focused desktop tunnel and Code 73; full app 1,583; WebKit receiver regression; cutover, changed-file formatting, and diff checks                                     | Bare `Window.setTimeout` and `Window.clearTimeout` references were invoked with the dependency object as their receiver, aborting the native Code bridge handshake in WebKit                                    |
| S6 — Tunnel output congestion | Retain and retry nested TCP frames across transient shared WorkerLink backpressure           | Complete | `codex/fix-code-worker-link-congestion`  | [#1193](https://github.com/ArcaneArts/Cantrip/pull/1193) | Workspace typecheck/build; focused tunnel, Code, and WorkerLink 23; full worker 885; cutover, changed-file formatting, and diff checks                                                           | Concurrent Code asset and WebSocket streams could consume shared outer capacity between emission attempts; rejected frames were removed and their logical stream was closed instead of waiting for fresh credit |

## Tranche Two passes

| Pass                                      | Scope                                                                                                                                        | Status   | Branch                                                   | PR                                                       | Validation                                                                                                                                                                                                                                                                                                                                                                                                                   | Notes or deviations                                                                                                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T2.1 — Contracts, config, regression base | Add bounded peer/signaling policy, deployment controls, and LOCAL/RELAY plus Code fences                                                     | Complete | `codex/network-tranche2-pass1-contracts`                 | [#1196](https://github.com/ArcaneArts/Cantrip/pull/1196) | Protocol WorkerLink 12; server config 16; focused app WorkerLink and Code/Explorer 47; full protocol 361; protocol/server/app typechecks; full app 1,584 pass and 3 skip with one order-dependent baseline failure whose isolated file passes 3; formatting/diff check                                                                                                                                                       | LAN/WAN stay non-operational; legacy Remote Surface TURN remains isolated; no Code runtime was changed; default STUN and all peer limits are inert until signaling and PeerCarrier passes consume the policy                                                                  |
| T2.2A — Peer authority and worker gateway | Install exact peer rounds through the worker command plane, fence signaling/lifecycle, and expose a bounded transport-factory boundary       | Complete | `codex/network-tranche2-pass2a-peer-authority`           | [#1197](https://github.com/ArcaneArts/Cantrip/pull/1197) | Focused protocol/server/worker 49; focused coordinated server 59; full protocol 361; full worker 887 pass and 2 skip with two order-dependent baseline failures whose isolated files pass 10; workspace typecheck; changed-file formatting and diff checks                                                                                                                                                                   | No client signaling API or WebRTC transport is activated yet; T2.2B will publish authenticated signaling through CoordinationBus, and T2.3 will register the feature-neutral transport factory                                                                                |
| T2.2B — Replicated signaling mailbox      | Expose authenticated client signaling and bounded candidate delivery through the exact peer authority across coordinated replicas            | Complete | `codex/network-tranche2-pass2b-signaling`                | [#1198](https://github.com/ArcaneArts/Cantrip/pull/1198) | Focused protocol/server/worker 53; full protocol 361; full worker 890 pass and 2 skip; workspace typecheck; changed-file formatting and diff checks                                                                                                                                                                                                                                                                          | Signaling is transient and authority-owned; any authenticated replica forwards through CoordinationBus, while LAN/WAN remain dormant until T2.3 registers the feature-neutral WebRTC transport                                                                                |
| T2.3 — Feature-neutral WebRTC PeerCarrier | Add strict LAN/WAN candidate rounds and carry the shared WorkerLink envelope over authenticated, lane-separated WebRTC DataChannels          | Complete | `codex/network-tranche2-pass3-peer-carrier`              | [#1199](https://github.com/ArcaneArts/Cantrip/pull/1199) | Focused protocol/app/server/worker 46; full protocol 363; full app 1,587 pass and 3 skip; full worker 892 pass, 1 order-dependent baseline failure, and 2 skip with both isolated failures passing 9; workspace typecheck/build; changed-file formatting and diff checks                                                                                                                                                     | The worker transport is registered, but client route selection remains dormant until T2.4; no feature adapter or Code/Explorer lifecycle changed, TURN remains forbidden, and relay-only authority exposes only RELAY                                                         |
| T2.4A — Mixed-carrier route activation    | Activate four-route priority, concurrent RELAY readiness, fixed per-stream routes, promotion, and partial carrier fallback                   | Complete | `codex/network-tranche2-pass4-route-selection`           | [#1200](https://github.com/ArcaneArts/Cantrip/pull/1200) | Protocol 363; focused app/server/worker 47; full app 1,589 pass and 3 skip; workspace typecheck/build; Rust fmt/check; topology and source verification; formatting/diff check                                                                                                                                                                                                                                               | Routine carrier promotion stays within one authority generation and does not kill streams on other carriers; T2.4B retains lifecycle-triggered reprobe, transition projection, bounded mobility metrics, and resubscription work                                              |
| T2.4B — Mobility and route observability  | Reprobe direct carriers on environment/lifecycle/ICE/authority changes, reconnect affected streams, and project bounded transition metrics   | Complete | `codex/network-tranche2-pass4b-mobility`                 | [#1201](https://github.com/ArcaneArts/Cantrip/pull/1201) | Focused WorkerLink and Network Map 25; full app 1,591 pass and 3 skip; workspace typecheck/build; Android/iOS Capacitor sync; topology, Code, and Codex source verification; changed-file formatting and diff checks                                                                                                                                                                                                         | RELAY survives direct mobility reprobes; browser/WebView and native Capacitor signals are coalesced; existing feature controllers safely reopen affected streams without pretending arbitrary TCP survives                                                                    |
| T2.5 — Renderer PeerCarrier parity        | Prove browser, Capacitor, and Tauri renderer consumers inherit LAN/WAN for Terminal, Code, and in-app tunnels without feature route branches | Complete | `codex/network-tranche2-pass5-renderer-parity`           | [#1202](https://github.com/ArcaneArts/Cantrip/pull/1202) | Focused WorkerLink, renderer, and Code/Explorer 182; full app 1,600 pass and 3 skip; workspace typecheck/build; Android/iOS Capacitor sync; packaged macOS plist; Rust fmt/check; Code/Codex source, topology, plist, formatting, and diff verification                                                                                                                                                                      | Preserves the existing Code service-worker/WebSocket shim and Explorer lifecycle; adds Apple local-network usage metadata without adding Bonjour discovery or a general browser/Capacitor localhost listener                                                                  |
| T2.6A — Native Tauri carrier decision     | Benchmark native WebRTC, a server-pinned socket, and the existing bounded WebView bridge, then select the T2.6B architecture                 | Complete | `codex/network-tranche2-pass6a-native-carrier-decision`  | [#1203](https://github.com/ArcaneArts/Cantrip/pull/1203) | Native bridge tests 4; focused native bridge and desktop Code 44; workspace typecheck; network source verification; Rust check/fmt; release spike and five-run benchmark aggregation; Clippy passes with 15 pre-existing tunnel-forward warnings; formatting/diff check                                                                                                                                                      | ADR 0010 selects the bounded WebView bridge; measured local overhead does not justify a second WebRTC stack, while a raw peer socket cannot preserve ICE/STUN WAN reachability without a new protocol                                                                         |
| T2.6B — Native Tauri LAN/WAN transport    | Harden the selected WebView bridge, preserve exact LAN/WAN route identity, and prove generic tunnel and Code listener stability              | Complete | `codex/network-tranche2-pass6b-native-carrier-hardening` | [#1204](https://github.com/ArcaneArts/Cantrip/pull/1204) | Focused app 84; full app 1,601 pass and 3 skip; native bridge 5; portable native tunnel 49; workspace typecheck and app build; Rust check/fmt/Clippy; topology and Code/Codex source verification; formatting/diff check                                                                                                                                                                                                     | Uses one-use 30-second bridge claims and exact native-forward, renderer-claim, WorkerLink authority, grant, and channel fencing; the two documented packaged-Code Rust harness timeouts still reproduce                                                                       |
| T2.7A — Browser Remote Surface authority  | Add exact Browser attachment grants and the worker-side interactive/realtime lane adapter without changing the supported Browser client      | Complete | `codex/network-tranche2-pass7-browser-remote-surface`    | [#1205](https://github.com/ArcaneArts/Cantrip/pull/1205) | Protocol WorkerLink 14; focused worker 15; focused server placement API 14; full protocol 363; full worker 897 pass and 2 skip; full app 1,601 pass and 3 skip; workspace typecheck; app build; topology and Code/Codex source verification; formatting and diff checks                                                                                                                                                      | Raw Chromium CDP remains worker-internal; the legacy Browser client stays operational until T2.7B proves the WorkerLink client adapter and performs the feature cutover                                                                                                       |
| T2.7B — Browser Remote Surface client     | Cut the supported Browser UI over to shared WorkerLink lanes, bounded frame fragmentation, reconnect, and route truth                        | Complete | `codex/network-tranche2-pass7b-browser-client`           | Pending                                                  | Focused protocol 16, worker 5, app 20, and server placement API 14; full protocol 365; full app 1,606 pass and 3 skip; full worker 897 pass, 2 skip, and 2 unrelated failures: the repeatable direct-broker logging race reproduces on unchanged `main`, while the intermittent goal-streaming case passes in isolation; workspace typecheck; app build; topology and Code/Codex source verification; formatting/diff checks | Browser development-service tunnels retain the generic `stream` adapter; the legacy Remote Surface transport remains for Remote Desktop and compatibility clients until later passes; fresh-worktree app build required building the local `@cantrip/glitch` dependency first |

## Stabilization acceptance evidence

| Acceptance surface             | Evidence                                                                                                                                                                                                                                                                                         | Result |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| WorkerLink-owned topology      | The source cutover audit follows Terminal, saved and managed tunnels, project shares, browser/Capacitor Code, dedicated desktop Code, and the shared desktop Code pool to their WorkerLink entry points and rejects the removed feature-owned topology identifiers                               | Pass   |
| Code authorization regression  | The grant endpoint now accepts a valid Code-origin protected attachment and installs its exact bounded worker grant; integration coverage retains account, account-session, placement, resource, attachment, expiry, revocation, replay, worker-generation, and route-generation rejection cases | Pass   |
| Route lifecycle and fallback   | Focused protocol, app, server, and worker tests cover LOCAL-to-RELAY fallback, route replacement, generation fencing, renewal, revocation, logout, worker restart, server reconnect, channel retirement, and reconnect without rebinding native listeners                                        | Pass   |
| Browser and Capacitor behavior | Hosted Code continues to use the service-worker/WebSocket shim over a WorkerLink RELAY carrier; the browser-compatible adapter suite and full app suite pass without enabling peer-direct transport                                                                                              | Pass   |
| Settings observability         | Component coverage proves active LOCAL and RELAY, fallback, connecting, reconnecting, idle, offline, last-used, mixed-route, and unknown peer-route states; live desktop and 390-pixel browser QA verifies responsive worker cards and details                                                   | Pass   |
| Broad validation               | Protocol, app, and worker suites pass in full; workspace build/typecheck, source verification, CLI check, Tauri compile, and the focused native WorkerLink tests pass                                                                                                                            | Pass   |
| Baseline separation            | The acceptance branch was byte-identical to synchronized `origin/main` while the broad server suite, server-boundary audit, and root formatting check were captured; their unrelated failures are listed below                                                                                   | Pass   |

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
- [x] Every implementation and stabilization pass uses its own squash-merged PR; `origin/main`, Primary synchronization, and goal-worktree cleanup are completed as the S4 stabilization PR lands.

## Blockers and known risks

- No current blocker.
- T2.5 validates the browser-compatible renderer path deterministically and
  syncs both Capacitor projects, but no physical iOS or Android device or
  multi-device LAN/WAN topology was available in this pass. The final T2.11
  matrix must record those physical results separately; the current pass does
  not infer them from desktop WebRTC tests.
- Browser/WebView Network Information events remain implementation-dependent.
  Capacitor now supplies native network and app-state signals; browser and
  Tauri WebView clients additionally react to online, page restore, visibility,
  explicit reprobe, and active ICE/carrier failure. The T2.6 native-carrier
  decision must determine whether Tauri also needs an operating-system
  interface notification for proactive promotion while its current route
  remains healthy.
- Under full-suite process load during T2.3, two consecutive worker runs each
  exposed a different pre-existing timing-sensitive Code test:
  `code-settings-sync-lifecycle.test.ts` first and
  `code-supervisor.test.ts` second. The affected isolated cases pass all 9
  assertions, the T2.3 focused worker transport suite passes, and an earlier
  full run passed all 892 then-current worker assertions. Neither failure
  touches WorkerLink peer code.
- The T2.4A full worker run reports 892 passing tests, two skipped, and one
  timing-only DirectBroker log assertion under full-suite load. Its isolated
  file passes all 10 tests, including the new LOCAL physical-boundary fence.
  The broad server run reproduces the existing schema, placement, version, and
  order failure cluster recorded below; the focused replicated service and
  relay suites pass. No failing broad test exercises the mixed-carrier manager.
- The repository-wide `pnpm check` currently stops at the pre-existing
  `audit:server-boundaries` failure: “Client-control notification E2EE boundary
  regressed: client: protected notification path is missing.” Root formatting
  reports four unmodified files:
  `cantrip_app/src/components/ui/dialog.test.ts`,
  `cantrip_app/src/lib/client-session.ts`,
  `cantrip_app/src/lib/server-connections.ts`, and
  `cantrip_server/test/chat-turn-retry-repository.test.ts`.
- The final full protocol suite passes 359 tests. The final full app suite
  passes 1,582 tests with three skipped. The final full worker suite passes 883
  tests with two skipped across 142 passing files and one skipped file. The
  broad server suite, run while the acceptance worktree was still byte-identical
  to synchronized `origin/main` at `51b51702`, passes 690 of 840 tests, with 48
  failures and 102 pending across 319 passing and 52 failing suites. Those
  failures remain pre-existing schema, placement, and version-fixture drift;
  the focused WorkerLink coordinator, service, relay, tunnel control plane,
  bridge, shared coordination, project placement, and metrics suites pass all
  79 tests.
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
- The server peer authority collapses concurrent opens to one exact LAN or WAN
  negotiation round per WorkerLink session and route generation. It releases
  the transient peer record only after the worker acknowledges installation,
  renews it inside the parent session lease, and revokes it on route changes,
  expiry, logout, worker replacement, or shutdown. It emits no reusable worker
  credential; feature channels still require their exact short-lived resource
  grants.
- The worker always installs a feature-neutral peer gateway under the existing
  authenticated command plane. The gateway accepts only exact parent-session
  identities, monotonically sequenced client signaling, configured routes, and
  bounded peer counts; it retires peers that exceed the per-session invalid
  handshake rate. Its transport-factory boundary deliberately remains empty
  until T2.3 supplies WebRTC, so T2.2A cannot accidentally activate LAN or WAN.
- The authenticated peer REST boundary never owns peer state. It authorizes the
  exact account session, then forwards open, signaling, mailbox, and revocation
  operations to the transient server authority named by the existing
  CoordinationBus session claim. Worker notifications follow the coordinated
  worker bridge back to that authority, so client and worker attachment to
  different replicas has identical behavior without sticky sessions.
- Worker-to-client signaling and candidate advertisements use an
  acknowledgement-pruned, per-peer transient mailbox. Both directions require
  exact session, peer, sender, route, generation, lease, and monotonic sequence
  identities; gaps, conflicting duplicates, or the 256-message/4 MiB bounds
  revoke only the affected peer round. No reusable worker credential or raw
  candidate enters logs, metrics, or durable storage.
- T2.3 registers one feature-neutral worker WebRTC transport and exposes a
  matching browser/WebView `PeerCarrier`. The DTLS connection carries the exact
  WorkerLink binary envelope over one reliable control channel and five
  independently bounded QoS DataChannels; realtime is unordered and
  disposable, while the reliable lanes remain ordered. A challenge-response
  handshake binds the connected peer to the exact server, account session,
  client instance, worker process, peer session, route, and route generation
  before any resource frame is accepted.
- LAN and WAN are separate ICE rounds. LAN admits only private IPv4,
  link-local/unique-local IPv6, and mDNS host or peer-reflexive candidates. WAN
  admits public, server-reflexive, peer-reflexive, CGNAT, and VPN candidates.
  Relay candidates and TURN are rejected in both rounds, and no subnet scan is
  performed. WAN uses the bounded configured STUN list; LAN does not contact
  STUN.
- Worker interface names enforce allow/deny and VPN classification on the
  worker-owned side of each ICE pair. Browser ICE intentionally withholds
  interface names, so private or mDNS browser candidates remain possible VPN
  candidates only in the WAN round; the worker's named local interface, exact
  authority, DTLS handshake, and selected-pair checks still fail closed.
  Tailscale and ZeroTier therefore default to WAN without weakening the LAN
  classification on the worker.
- The relay-only emergency policy now emits a session whose only enabled and
  preferred route is RELAY, even if individual direct-route toggles are also
  set. T2.3 widens transport contracts to represent operational LAN/WAN but
  deliberately leaves client selection on the existing LOCAL/RELAY behavior
  until T2.4 can add concurrent fallback and mobility as one coherent change.
- T2.4A treats `routeGeneration` as the installed authority-policy epoch.
  Preparing, promoting, or demoting enabled carriers does not rewrite server
  authority: existing streams remain pinned to their physical route, new
  streams choose the best ready `LOCAL -> LAN -> WAN -> RELAY` carrier, and a
  failed carrier retires only its streams. Explicit authority replacement still
  increments the generation, retires every stream, and rejects stale frames.
- RELAY now prepares concurrently as a warm, authenticated standby. LOCAL,
  server RELAY, LAN peer, and WAN peer ingress each independently require their
  matching physical route in the frame, while the worker gateway authorizes
  any route enabled in the exact session. Terminal and tunnel adapters consume
  the route fixed on the opened WorkerLink stream and contain no carrier choice.
- T2.4B coalesces browser/WebView online, Network Information, page restore,
  and visibility signals with native Capacitor network and app-state events.
  Mobility reprobes retain RELAY, retire only direct carriers and their fixed
  streams, and restart the priority chain. Terminal, Remote Surface, native
  tunnel, and Code transport owners use their existing reconnect controllers to
  reacquire grants and streams without rebuilding unrelated feature state.
- A same-session higher route generation is adopted before reconnecting; a
  stale generation or changed server, worker, account-session, client, or
  session identity fails closed and creates new authority. Transition
  projection distinguishes mobility, promotion/demotion, carrier/ICE failure,
  authority replacement, and reconnect failure independently from fallback.
- Bounded telemetry now records negotiation start/completion/failure, route
  promotion/demotion, realtime queue drops, stale/invalid frame drops, and
  direct bytes that avoided RELAY. Metrics retain only the protocol route,
  lane, reason, direction, latency, and counter vocabularies.
- Route-generation replacement retires active worker channels before the
  replacement is acknowledged. Logout fences are transient around revocation,
  allowing a later authenticated account session to establish fresh authority.
- LOCAL and RELAY carry the identical bounded binary frames. Adapters cannot
  emit before acceptance is delivered, receive credit is returned only after
  the client consumer acknowledges data, and per-lane bounded scheduling gives
  interactive traffic greater service without sharing bulk queue capacity.
- Browser, Capacitor, and Tauri renderer consumers use the same active
  WorkerLink carrier chain. Tauri can select the authenticated loopback broker;
  every renderer can select LAN/WAN PeerCarrier or the server RELAY according
  to authority and reachability. T2.5 proves Terminal, Code, and in-app tunnel
  parity across LAN, WAN, and RELAY without adding a feature-owned topology
  branch or changing the Code/Explorer lifecycle.
- ADR 0010 selects the existing bounded localhost WebSocket bridge as Tauri's
  native carrier boundary. The stable Rust listener remains process-owned while
  the renderer supplies the shared LAN/WAN PeerCarrier or RELAY stream. A
  repeatable lower-bound spike shows that the extra local hop adds tens of
  microseconds for interactive-size frames and sustains over 2 GiB/s for 1 MiB
  frames on the measured Apple M4 Max; it does not claim to model WAN, DTLS,
  SCTP, or JavaScript execution.
- Tauri native WorkerLink claims are one-use and expire after 30 seconds. Every
  accepted bridge handshake binds the exact native-forward and renderer-claim
  generations plus WorkerLink session, account session, client instance,
  worker process, route generation, resource grant, channel, connection,
  tunnel, and attachment. A stale renderer cannot rotate a newer claim.
- Generic desktop tunnels and the process-wide Tauri Code pool retain their
  process-owned `127.0.0.1` listener while a failed LAN or WAN stream rotates
  the bridge claim and re-enters `LOCAL -> LAN -> WAN -> RELAY`. The native
  summary now preserves the exact effective route instead of collapsing LAN and
  WAN into the legacy `local-direct` state.
- Browser Remote Surface authority now issues one short-lived, exact
  attachment grant with separate `interactive` and `realtime` channels. The
  worker adapter queues bounded control and clipboard output across channel
  replacement, treats frames and cursor images as disposable, and gives the
  shared WorkerLink scheduler—not the Browser feature—physical route
  ownership. Grant expiry, session revocation, resource deletion, and logout
  detach the worker attachment even if a client never opens a channel.
- The WorkerLink Browser attachment explicitly suppresses the legacy
  feature-specific WebRTC attachment; raw Chromium CDP remains bound to worker
  loopback and never enters WorkerLink. T2.7A leaves the supported Browser UI
  on its compatibility transport until the T2.7B client adapter proves
  reconnect, encryption, lane separation, and RELAY fallback.
- The supported Browser UI now receives a topology-free Remote Surface client
  with separate `interactive` and `realtime` WorkerLink streams. It exposes
  each stream's effective route for truthful diagnostics, reacquires exact
  attachment authority after a lane failure, and contains no WebRTC-versus-
  WebSocket decision. Browser-owned development-service tunnels continue
  through the generic WorkerLink `stream` adapter.
- Protected Remote Surface frames use bounded, restartable chunks beneath the
  lane abstraction because screenshots may exceed one WorkerLink message. The
  reliable lane resumes a partial frame across credit and route replacement;
  the realtime lane finishes its current frame while retaining only the newest
  successor. After both Browser lanes are ready, the viewport message causes
  the worker to republish current state and capture a fresh frame, eliminating
  attachment-before-stream startup races.
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
- The client WorkerLink manager now owns a subscribable current-client route
  projection keyed internally by exact authenticated identity and worker. It
  reports lifecycle, preferred and effective routes, generation, latency,
  fallback, consumer/link/channel counts, and a four-route channel-count shape
  without exposing session authority, credentials, resource IDs, projects,
  private addresses, or peer candidates. LAN and WAN remain representational
  values only.
- Active carriers report live state while a released or initially failed link
  retains only a clearly labeled last-used snapshot for 30 seconds. Logout,
  server identity changes, and manager shutdown clear that projection
  immediately; Terminal, tunnels, shares, and Code remain unaware of Settings
  and continue to obtain all routing behavior from WorkerLink itself.
- The Settings Network Map subscribes directly to that shared projection and
  models route as a current-client-to-worker relationship. Worker presence
  without a snapshot renders `IDLE` (or `OFFLINE`), while active, connecting,
  reconnecting, fallback, last-used, and future mixed-route values retain their
  distinct labels, counts, latency, generation, and freshness. Other account
  clients expose only their known server control-plane presence; their data
  routes remain explicitly unknown.
- Thin server edges now represent authentication, commands, settings, and
  durable state independently of WorkerLink. LOCAL data draws directly from
  the current client to its worker, RELAY data draws client-to-server and
  server-to-worker segments, and inactive last-used data is visually muted.
  LAN/WAN colors, direct edges, mixed-count rendering, fallback state, and
  transition cause consume the live current-client projection. Earlier desktop
  and 390-pixel browser QA confirmed the responsive card/dialog layout and led
  to wrapping compact route counts instead of truncating them.
- Prometheus metrics use only the protocol's bounded event, route, lane, reason,
  and direction vocabularies. Session, account, worker, project, resource,
  destination, credential, candidate, and payload values never become labels.
- The obsolete `desktop-terminal.ts` direct-route helper had no supported
  caller and was removed. Public compatibility endpoints and shared direct
  infrastructure remain because older clients may still depend on them.

## Tranche Two remaining work

After T2.5, four-route selection, concurrent RELAY preparation, per-channel
mixed routing, lifecycle mobility, renderer Terminal/Code/tunnel parity,
generation replacement, reconnect-owned stream reopening, truthful transition
projection, and bounded transport metrics are active beneath WorkerLink.

The native Tauri bridge now has generation-scoped, one-use claims, exact
WorkerLink authority fencing, truthful effective routes, per-channel fallback,
and stable localhost listeners. Browser Remote Surface server/worker authority
and supported client routing are implemented through T2.7B. Remote Desktop,
worker observations, incremental chat, filesystem watcher migration, relay
consolidation, and the final acceptance gate follow. TURN and transparent TCP
resumption remain explicitly deferred, and the restored Code/Explorer lifecycle
remains a mandatory regression boundary.
