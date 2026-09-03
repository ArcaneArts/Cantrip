# Cantrip performance and reliability audit

> Historical static-audit snapshot. Findings, counts, rankings, source
> locations, and “current evidence” were last reconciled through commit
> `42ebb4988e6a401671493e47bd799dfa0a7745d2`; they are not a current
> optimization inventory.

- Date: 2026-08-29
- Audit baseline: origin/main at ad6cc1b4bbb54dd27078dabed028654d700b7beb
- Reconciliation updated through: origin/main at a5fe041d62447876e94134289e92385799a79756
- Cleanup updated through: origin/main at 42ebb4988e6a401671493e47bd799dfa0a7745d2
- Status: priority items 1 through 8 are fixed and removed from the active inventory
- Scope: cantrip_app, cantrip_server, cantrip_worker, packages/protocol, and their cross-layer paths

## Executive result

The architecture is healthier than the prior report implied. Supported interactive transports now
converge on WorkerLink, healthy AppLive replaces ordinary resource polling, and several earlier UI
and scheduler hot paths have been fixed. This pass removed every completed record from the active
inventory and audited the replacement architecture rather than carrying legacy evidence forward.

The deeper pass originally found 14 strong new opportunities. T0-01 through T0-14 are now fixed,
along with N0-01 and N0-03. At this baseline, 41 actionable carryover
opportunities remained after cleanup.
Four additional items remain measure-first candidates. The priority table is intentionally narrower
than the full inventory.

| Rank | Opportunity                                     | Gain              | Risk       | Dominant avoided work                                |
| ---: | ----------------------------------------------- | ----------------- | ---------- | ---------------------------------------------------- |
|    1 | P0-04 narrow AppLive subscription authorization | high reconnect    | low        | full resource hydration for up to 128 scopes         |
|    2 | P0-06 collapse worker-management 1 + 2N queries | high fleet-wide   | low        | pool-consuming list and mutation fanout              |
|    3 | N0-15 batch Task dispatch preparation           | high Task backlog | low-medium | repeated snapshot/route work and no-op reason writes |
|    4 | P0-07 coalesce worktree observation             | high idle         | low-medium | per-target SQL, Git probes, and duplicate watchers   |

## Scope and method

Three independent passes audited UI/rendering, server/netcode/database behavior, and worker/service
management. A fourth cross-layer pass followed WorkerLink, AppLive, Browser Code, Task, attachment,
and routing paths end to end. cantrip_code, cantrip_codex, and cantrip_site were deliberately excluded.

The optimization scout was run as a locator only. Its output was dominated by generated, minified,
vendored, and patched-upstream files, so it was discarded. Every opportunity retained by the
third-pass audit was manually reread against the audit baseline. No product source was changed.

This is a static audit plus one focused microbenchmark, not a production profile. Findings are
therefore labeled opportunity. Each actionable item states category, gain, risk, complexity,
confidence, current evidence, hypothesis, suggested change, and validation. Expected gain combines
call frequency, configured bounds, and position on an interactive or reliability-critical path.

Taxonomy categories are ALGORITHM_COMPLEXITY, HOT_PATH_ALLOCATION, SYNC_IO_HOT_PATH,
REGEX_OR_PARSING_HOT_PATH, N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION, and
STATE_OR_CACHE_STRATEGY.

## Architecture and correctness constraints to preserve

- Healthy AppLive already eliminates repeating project-resource HTTP. HTTP snapshots and bounded
  recovery polling remain necessary when live transport is degraded or stopped.
- Durable expiry watchdogs must remain. The optimization is to make them single-flight and avoid
  redundant global scans on ordinary request paths, not to weaken deadline enforcement.
- Direct WorkerObservation is an accelerator; canonical AppLive and durable queries remain the
  recovery source. Its scoped demand and recovery paths must continue to preserve background chats,
  Tasks, failover, and gaps.
- WorkerLink sequence, route generation, grant, identity, credit, usage accounting, and replay
  checks are security and correctness boundaries. Low-copy paths may reuse bytes only after those
  checks and must retain explicit ownership.
- Legacy transport endpoints remain during compatibility soak. Do not spend broad optimization
  effort there, but preserve them until the documented removal gate is met.
- Polling tied to durable automation, replica completion, watcher degradation, and missed-event
  recovery must remain bounded and testable.

## Reconciliation with the prior report

Completed findings no longer occupy the active inventory. Superseded findings are removed; later
work that resolved their replacement architecture is recorded below.

| Prior ID | Disposition                        | Current proof                                                                                                                               |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| N0-02    | resolved; removed                  | cantrip_server/src/db/task-dispatch.ts:87-110,237-284 and cantrip_server/src/app.ts:25485-25588 gate scheduler phases by actual owner state |
| N0-04    | resolved; removed                  | app-live-client.ts:333-341,1071-1086 separates status fanout and coalesces cursor persistence; tests cover 10,000 advances                  |
| N0-05    | resolved; removed                  | use-provider-catalog.ts:21-35 and provider-catalog-cache.ts:32,74-94 avoid disabled-query parsing and hydrate once per scope                |
| N0-06    | resolved; removed                  | agent-trajectory.tsx:242-264 and agent-inspect-content.tsx:452-484 stop hidden projection/render/clock work                                 |
| P0-02    | supported path superseded; removed | legacy client modules are gone; Browser and Remote Desktop use WorkerLink; #1226 addressed the remaining active frame copies                |
| P1-19    | common path superseded; removed    | old direct-tunnel scans are compatibility-only; #1221 addressed the active WorkerLink tunnel window                                         |

P0-03 remains active: the encryption work landed in #1136 coalesces concurrent readiness but does
not skip an unchanged heartbeat bootstrap. P1-04 remains active with narrower wording: #1137 removed
heartbeat-triggered statistics scans, while filesystem and Git bursts can still trigger repeated
large scans. P1-10 also remains active: source files were split, but the authenticated shell is not
meaningfully lazy-loaded.

## Fixed after the third-pass audit

The detailed descriptions for these completed opportunities have been removed from the active
inventory. Items T0-09 through T0-14 and N0-01/N0-03 were former priority ranks 1 through 8.

| ID    | Status | Resolution note                                |
| ----- | ------ | ---------------------------------------------- |
| T0-01 | fixed  | #1221 drains the WorkerLink byte window        |
| T0-02 | fixed  | #1220 focuses execution-target resolution      |
| T0-03 | fixed  | #1224 scopes direct-observation recovery       |
| T0-04 | fixed  | #1223 scopes WorkerObservation demand          |
| T0-05 | fixed  | #1225 narrows Task live-routing lookups        |
| T0-06 | fixed  | #1226 reuses validated WorkerLink frame bytes  |
| T0-07 | fixed  | #1227 gates worker polling on AppLive health   |
| T0-08 | fixed  | #1228 aggregates WorkerLink client telemetry   |
| T0-09 | fixed  | Former priority rank 1; detailed entry removed |
| T0-10 | fixed  | Former priority rank 2; detailed entry removed |
| T0-11 | fixed  | Former priority rank 3; detailed entry removed |
| T0-12 | fixed  | Former priority rank 4; detailed entry removed |
| T0-13 | fixed  | Former priority rank 5; detailed entry removed |
| T0-14 | fixed  | Former priority rank 6; detailed entry removed |
| N0-01 | fixed  | Former priority rank 7; detailed entry removed |
| N0-03 | fixed  | Former priority rank 8; detailed entry removed |

## Baseline revalidated priority opportunities

### N0-07 — opportunity — Batch project and worker routing-metadata hydration

- Category: N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION
- Expected gain: high fleet-wide
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_app/src/lib/project-encryption.ts:128-323 resolves metadata and lists worktrees per
project, issues protected calls per project/worker, and repeatedly scans lists. cantrip_app/src/lib/api.ts:2757-2815
separately loads workers and performs a protected status command per ready worktree. Suggested
change: return one authorized routing projection and reuse indexed worker/project maps, preserving
fail-closed redaction. Validation: 1/50/500 projects with exact HTTP/command and confidentiality
parity.

### N0-08 — opportunity — Make attachment transfer genuinely ranged and incremental

- Category: SYNC_IO_HOT_PATH, HOT_PATH_ALLOCATION
- Expected gain: high transfer throughput and RSS reduction
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/attachment-store.ts:109-179,200-225 and
chat-relocation-store.ts:121-169 retain per-chunk opens or full reads. project-export-manager.ts:
591-639 repeats appendFile and then reads the completed file. Suggested change: retain bounded file
handles, use positioned reads/writes, and stream hashing/verification where the format permits.
Validation: 1 MiB/1 GiB transfers, parallel ranges, EOF/abort/change races, digest parity, handle
caps, Windows behavior, and RSS.

### N0-09 — opportunity — Stop cloning routine Codex RPC payloads for unused diagnostics

- Category: REDUNDANT_COMPUTATION, HOT_PATH_ALLOCATION
- Expected gain: high during Codex streaming
- Risk: low-medium
- Complexity: low
- Confidence: high

Evidence: cantrip_worker/src/codex/app-server.ts:7246-7286 sends routine RPCs through diagnostics;
8956-8983 and codex/diagnostic-redaction.ts:10-38 recursively clone/redact every payload. Normal
construction supplies no consumer. Suggested change: gate expensive capture by an enabled bounded
diagnostic sink while keeping cheap counters/error summaries. Validation: one-byte and realistic
streams with diagnostics off/on, redaction, truncation, ordering, and failure capture.

### N0-10 — opportunity — Batch Codex stream accumulation at the 100 ms boundary

- Category: HOT_PATH_ALLOCATION, ALGORITHM_COMPLEXITY
- Expected gain: high during long streamed output
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/codex/app-server.ts:588-608 appends every agent delta; 2760-2811
sanitizes character-by-character and rebuilds as much as 256 KiB per raw command delta, called at
7609-7643, despite 100 ms delivery batching at 505-515. Suggested change: retain bounded chunks and
sanitize/materialize once per delivery boundary with incremental UTF-8 state. Validation: one-byte,
split-surrogate, ANSI, truncation, long-output, ordering, and memory tests.

### N0-11 — opportunity — Collapse Project Task workload fanout

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high Task-dashboard latency
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/app.ts:26009-26044 still loads workload plans/pages per Task after the
base list, retaining the prior approximately 3 + 3N shape. Suggested change: bulk-read workload,
latest page, plan/goal, and activity by chat IDs, then assemble in stable order. Validation: 1/25/100
Tasks, fixed statement count, response parity, pool occupancy, archival, encryption, and pagination.

### N0-12 — opportunity — Consolidate authenticated WebSocket session validation

- Category: N_PLUS_ONE_OR_CHATTER, STATE_OR_CACHE_STRATEGY
- Expected gain: high at connection scale
- Risk: low
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/app.ts:4647-4725 retains one validation query per grouped session every
30 seconds; live/hub.ts:515-524,1081-1104 also validates inbound frames and maintained connections.
Suggested change: one revocation-aware session-validation authority with short bounded single-flight
and explicit account/session invalidation. Validation: connection counts, DB reads, revoke/logout,
expiry, multi-tab, multi-instance, and maximum stale authorization bound.

### N0-13 — opportunity — Add a live-message wire discriminator

- Category: REGEX_OR_PARSING_HOT_PATH
- Expected gain: high Task-chat streaming
- Risk: low-medium
- Complexity: low-medium
- Confidence: high

Evidence: cantrip_server/src/app.ts:2918-2999 publishes plaintext, chat-encrypted, and Task-encrypted
payloads without a live kind. app-live-query.ts:1130-1165 parses multiple shapes and tries chat
decryption before Task decryption; cantrip_app/src/lib/chat-message-encryption.ts:150-176 and
task-message-encryption.ts:104-138 reparse nested data. Suggested change: add the existing list/page
wire kind to live payloads with a rolling old-shape fallback. Validation: parse/decrypt counters and
exact clear/encrypted/delete/malformed/mixed-version behavior.

### N0-14 — opportunity — Batch retained legacy-desktop attachment maintenance

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: medium for retained native desktop forwards
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_app/src/lib/direct-transport-telemetry.ts:100-171,215-228 lists generic native
forwards every ten seconds and issues one telemetry, WorkerLink attachment refresh, or lease request
per forward. Shared Code forwards are excluded at 103-109, and WorkerLink route telemetry is separate.
Suggested change: one batch maintenance endpoint or deadline scheduler with per-entry results.
Validation: 1/100 forwards, route/lease/credential expiry, partial failure, window/account isolation,
and degraded recovery.

### N0-15 — opportunity — Batch Task dispatch eligibility and suppress no-op reason writes

- Category: N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION
- Expected gain: high under Task backlog
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/app.ts:25303-25408 prepares eligibility sequentially by cycle and Task
worker; db/task-dispatch.ts:446-704 reloads snapshots and scans workers times candidates per claim;
711-720 writes every reason. Suggested change: share a scheduler-cycle snapshot, batch contexts and
grants, memoize route resolution, and update only changed reason codes while preserving compare-and-
swap fencing. Validation: 1/25/100 cycles by 1/4/16 workers, FIFO, continuity, requested-worker,
encryption, and two-scheduler races.

### N0-16 — opportunity — Share and parallelize Run-configuration discovery and validation

- Category: N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION
- Expected gain: high for large repositories/configuration sets
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/run-configuration-definition-service.ts:171-189 validates documents
serially and 230-314 discovers Node/Java/Dart/Flutter/Rust providers sequentially. Suggested change:
use an ordered bounded mapper and a shared immutable project inventory, especially for Dart/Flutter.
Validation: candidates, order, diagnostics, caps, symlink exclusion, failure isolation, read counts,
and wall time for 1/32/128 definitions.

### N0-17 — opportunity — Make general expiration maintenance single-flight and deadline-aware

- Category: N_PLUS_ONE_OR_CHATTER, STATE_OR_CACHE_STRATEGY
- Expected gain: medium-high database relief
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/app.ts:5426-5440 retains unguarded one-second and 500 ms expiry loops;
db/repository.ts:18136-18176 duplicates request-path expiry and restores affected chats sequentially.
Suggested change at
the baseline: a shared guarded runner, narrow expiry return projections, and batched restoration,
with durable bounded watchdogs.
Validation: ten idle minutes, 1,000 simultaneous expirations, concurrent deadline requests, restart,
winner semantics, notification, and recovery.

### N0-18 — opportunity — Shard AppLive replay by owner

- Category: STATE_OR_CACHE_STRATEGY, ALGORITHM_COMPLEXITY
- Expected gain: high resume reliability; medium CPU
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/live/hub.ts:419-453 retains one global replay array, aggregate budgets,
and shift eviction; replay scans the global structure for owner-specific cursors. Suggested change:
use bounded per-owner deques plus an aggregate cap and explicit fair eviction. Validation: many
owners, hot/cold isolation, exact cursor/replay-too-old semantics, byte caps, reconnect, and memory.

### N0-20 — opportunity — Make Code-settings polling transport-aware

- Category: N_PLUS_ONE_OR_CHATTER, STATE_OR_CACHE_STRATEGY
- Expected gain: medium fleet-wide idle reduction
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/code-settings-sync.ts:39-42,421-427,605-635 retains 30-second network
reconciliation while cantrip_worker/src/index.ts:5491-5505 already handles reconnect/invalidation. Authorization
gating does not make healthy polling transport-aware. Suggested change: slow the durable fallback
while the command channel is healthy and reconcile immediately on reconnect/degradation. Validation:
idle HTTP/file work, local edits, dropped invalidations, reconnect, conflict, outage, watcher failure,
and documented maximum recovery bound.

### P0-03 — opportunity — No-op unchanged worker-encryption bootstraps

- Category: SYNC_IO_HOT_PATH
- Expected gain: high idle reduction
- Risk: low
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/index.ts:488,5601-5640,5804 retains five-second heartbeat refresh;
worker-encryption.ts:684-794,810-839 still unwraps and synchronously persists ready material, with
sync filesystem work at 247-255. Suggested change: compare server/owner identity and component
revisions before unwrap/export/persist while retaining refresh security cadence. Validation: ten idle
minutes with zero unchanged unwrap/write after initial bootstrap; every rotation/revocation remains
within the current bound.

### P0-04 — opportunity — Replace full AppLive authorization hydration with batched ownership checks

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high reconnect
- Risk: low
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/live/hub.ts:694-805 authorizes as many as 128 scopes independently;
cantrip_server/src/app.ts:4727-4746 still uses full project lists and chat execution context.
Suggested change: group project and chat IDs and use narrow ownership/existence queries while
preserving archival and lifecycle predicates. Validation: identical decisions and SQL plus p50/p95 at
1/16/128 scopes, including revoke and reconnect races.

### P0-06 — opportunity — Collapse worker-management 1 + 2N queries

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high fleet-wide
- Risk: low
- Complexity: low
- Confidence: high

Evidence: cantrip_server/src/db/repository.ts:7251-7307 loads workers and performs two queries per
worker; cantrip_server/src/app.ts:16104-16196 loads the whole management list for single-worker mutations. Suggested
change: three constant list queries grouped in memory and a focused single-worker mutation loader.
Validation: 1/10/100/1,000 workers, fixed query count, exact projection, mutation authorization, and
pool occupancy.

### P0-07 — opportunity — Coalesce worktree observation across server and worker

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high idle reduction
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/app.ts:2142-2201 performs one active-operation query per target and can
overlap configuration. cantrip_worker/src/worktrees.ts:37-40,375-390,527-550 starts a two-second HEAD
probe per target; 418-469 duplicates common Git watchers; 553-643 runs full status/operation scans.
Suggested change: batch server state, single-flight configuration with a latest rerun, reference-count
one common Git watcher, and use watcher-first probes with slower integrity recovery. Validation:
1/5/20/128 worktrees, mutation bursts, watcher failure, SQL, commands, watchers, Git children, and
final-state parity.

### P0-08 — opportunity — Collapse redundant Git status subprocesses

- Category: N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION
- Expected gain: high on Git-heavy worktrees
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/git.ts:1700-1731 launches five base commands plus ahead/behind even
though 1759-1783 already returns branch/current/hash/upstream; conflict observation rereads status at
6087-6135. Suggested change: use one porcelain/status/ref projection and share a short mutation-bound
snapshot between status/conflict consumers. Validation: unborn/detached/ahead/behind/dirty/conflict,
worktrees, submodules, exact status parity, child-process count, and latency.

### P0-10 — opportunity — Make live chat overlay merging incremental

- Category: ALGORITHM_COMPLEXITY, HOT_PATH_ALLOCATION
- Expected gain: high streaming
- Risk: medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_app/src/lib/chat-message-history.ts:61-69 clones the full overlay per upsert and
96-128 rebuilds/maps/sorts loaded history; use-chat-message-history.ts:79-92 reruns on every live or
provisional update. app-live-query.ts:571-586,974-988,1033-1059 fingerprints complete direct-observed
content. Suggested change: ordered/indexed overlays and observation identity/sequence reconciliation
instead of full-content serialization. Validation: 10,000-message chats, long streaming output,
copied bytes, sorts/stringifies, commits, ordering, decryption, pagination, and provisional/canonical
parity.

### P0-13 — opportunity — Add capped jittered backoff to reconnecting and crashing services

- Category: STATE_OR_CACHE_STRATEGY, N_PLUS_ONE_OR_CHATTER
- Expected gain: high failure reliability
- Risk: low-medium
- Complexity: low-medium
- Confidence: high

Evidence: cantrip_worker/src/transport.ts:61,391-442 reconnects every second; terminal-manager.ts:
557-613,617-744 restarts indefinitely at fixed delay while restartCount does not tune/reset it.
Suggested change: one capped jittered backoff primitive with manual-immediate retry, stable-uptime
reset, terminal-error classification, and injectable clock/randomness. Validation: outage fleets,
crash loops, retry distribution, stable reset, manual retry, shutdown, and no timer leaks.

### P0-14 — opportunity — Make worker shutdown failure-tolerant and dependency-parallel

- Category: REDUNDANT_COMPUTATION, STATE_OR_CACHE_STRATEGY
- Expected gain: high shutdown reliability and bounded exit
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/index.ts:5717-5790 is a long sequential shutdown chain without an outer
finally, allSettled, or stage deadlines; mcp/broker.ts:600-613 can wait indefinitely. Suggested
change: order true dependencies but all-settle independent cleanup groups under bounded deadlines,
always attempting credential/session revocation and final transport close. Validation: inject one
failure/hang per stage and prove every later cleanup runs, resources close, and exit stays bounded.

## Baseline revalidated follow-on inventory

These remain actionable but rank below the frontier above. Each row includes current proof and the
minimum safe next step; implementation should retain the detailed equivalence tests already named in
prior audits.

| ID    | Category and assessment                                                                                  | Current evidence                                                                                                                                                                                                             | Suggested change and validation gate                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | REDUNDANT_COMPUTATION; medium; low risk; low complexity; high confidence                                 | relay-coordinator.ts:273-296 measures coordination bytes by stringify; 935-939 stringifies again for Redis                                                                                                                   | serialize once and carry bytes/length; assert exact quotas and wire payloads                                                |
| P1-02 | N_PLUS_ONE_OR_CHATTER; medium-high fleet; low-medium risk; medium complexity; high confidence            | coordinated-bridge.ts:121-132 has an unguarded presence interval; 1115-1177 refreshes sequentially; relay-coordinator.ts:587-625 scans then GETs serially                                                                    | guarded bounded concurrency and Redis bulk read; test disconnect/revoke/order and large fleets                              |
| P1-04 | STATE_OR_CACHE_STRATEGY; medium-high large repos; low-medium risk; medium complexity; high confidence    | project-workspace-resources.ts:222-239 gates visible stats, but app-live-query.ts:330-340,602-625 invalidates on filesystem/Git; worker scans reach 50k files/256 MiB                                                        | canonical-root single-flight plus short dirty debounce; 100 concurrent/burst requests cause one scan with bounded freshness |
| P1-05 | REDUNDANT_COMPUTATION; medium-high; low risk; low complexity; high confidence                            | use-explorer-directory.ts:29-55 requests listing; cantrip_worker/src/explorer.ts:183-243 lists/stats, and 442-476 repeats it for commit metadata                                                                             | share a short mutation-invalidated listing and parallelize HEAD; test 1,000 entries, symlinks, immediate mutations          |
| P1-06 | REDUNDANT_COMPUTATION; high during resize; low risk; low complexity; high confidence                     | shell-chrome.ts:28-34,187-223 updates React state per pointer move; application-shell.tsx:319-338 owns it at root                                                                                                            | rAF CSS/ref preview, one React/persistence commit on completion; test FPS, pointer cancel/capture, keyboard                 |
| P1-07 | REGEX_OR_PARSING_HOT_PATH; medium; low risk; low-medium complexity; high confidence                      | tabular-file-visual.tsx:164-186 and 502-526 parse/search twice; 567-573 passes raw content                                                                                                                                   | parse once per revision and pass row indexes/count; verify 10k by 20 edit/search/save parity                                |
| P1-08 | REDUNDANT_COMPUTATION; medium; low-medium risk; medium complexity; high confidence                       | chat-history-rail.tsx:224-295 and chat-turn-prompt-overlay.tsx:94-171 run separate anchor measurement passes; both mount in transcript                                                                                       | shared frame-coalesced anchor store and binary active lookup; test 1,000 turns and layout-read count                        |
| P1-09 | STATE_OR_CACHE_STRATEGY; medium; low-medium risk; medium complexity; high confidence                     | cantrip_app/src/lib/api.ts:2926 pages 100 commits; git-history.tsx:680-697 flattens all, 808-821 auto-pages, 1187-1477 mounts every SVG-heavy row                                                                            | start with content-visibility, window only after profile; test 5,000 commits, focus, menus, scroll, WIP rows                |
| P1-10 | STATE_OR_CACHE_STRATEGY; high cold startup; low-medium risk; medium complexity; high confidence          | cantrip_app/src/main.tsx:111-123 dynamically imports session, but application-session.tsx and router.tsx statically reach App; only surface bodies are lazy; measured authenticated chunk is about 3.61 MB raw/923.5 KB gzip | lazy authenticated shell and feature boundaries; compare bundle and cold sign-in first paint/TTI                            |
| P1-11 | REDUNDANT_COMPUTATION; medium streaming; low-medium risk; low complexity; medium-high confidence         | native-tooltip-suppression.ts:1-7,41-72 observes character/child/title changes across the document                                                                                                                           | drop character-data observation and narrow boundaries; measure mutations and preserve dynamic title suppression             |
| P1-12 | SYNC_IO_HOT_PATH; high mobile/medium desktop; low-medium risk; medium complexity; high confidence        | client-log-relay.ts:117-133,175-187 crosses native persistence per record; mobile-log-archive.ts:104-109,225-229 appends one base64 record at a time                                                                         | byte/time-bounded ordered batches with lifecycle/error flush; test 10k logs, order, rotation, export, bounded loss          |
| P1-13 | STATE_OR_CACHE_STRATEGY; medium-high long-lived workers; medium risk; medium complexity; high confidence | cantrip_worker/src/index.ts:1128-1129 has unbounded runtime maps; 1643-1734 creates; removal occurs only on account close 1736-1764 or shutdown                                                                              | idle TTL/LRU with active-reference fences; test resume, concurrent use, account close, memory over many chats               |
| P1-14 | REDUNDANT_COMPUTATION; medium startup; low-medium risk; medium complexity; medium confidence             | cantrip_worker/src/index.ts:582-724,967-1081 starts independent probes serially; MCP then CLI starts serially at 5556-5565                                                                                                   | parallelize only proven-independent probes with bounded failure semantics; measure critical path and partial failure        |
| P1-15 | ALGORITHM_COMPLEXITY; medium under backlog; low risk; low complexity; high confidence                    | cantrip_worker/src/transport.ts:766-803,856-870 uses shift and recomputes byte length; smaller WorkerLink adapter queues repeat shift                                                                                        | head-index deque with exact byte counters and occasional compaction; benchmark max backlog and order/drop parity            |
| P1-16 | STATE_OR_CACHE_STRATEGY; medium failure load; low risk; medium complexity; high confidence               | unguarded recovery intervals remain across imports/replicas/relocations/folders/conversions; chat-relocations/executor.ts:669-685 polls completion every 250 ms for five minutes                                             | shared guarded interval and capped backoff; fake-clock overlap/outage/recovery tests                                        |
| P1-17 | N_PLUS_ONE_OR_CHATTER; medium create latency; low-medium risk; medium complexity; high confidence        | surface-creation-operations.ts:110-127,312-327,367-388,451-504,531-605,631-655 patches exact caches then immediately invalidates them                                                                                        | trust exact patch while AppLive healthy; retain degraded/delayed invalidation; test concurrent creates and dropped events   |
| P1-18 | REDUNDANT_COMPUTATION; medium browser load; low risk; low complexity; high confidence                    | browser/browser-adapter.ts:483-499 captures on two lifecycle events; 635-646 has no debounce/in-flight sharing                                                                                                               | share in-flight capture and debounce adjacent lifecycle captures; test redirects, screencast, first attachment              |
| P1-20 | REDUNDANT_COMPUTATION; medium hosted relay; low-medium risk; medium complexity; high confidence          | limited-command-bus.ts:33-39,175-262 JSON-serializes commands/events/results; bridge.ts:737-788 encodes again                                                                                                                | carry one encoded result/length through limiter and bridge; assert quota boundaries and transmitted bytes                   |

## Measure-first candidates

### P2-01 — Add database indexes only after production-shaped EXPLAIN

- Category: ALGORITHM_COMPLEXITY
- Expected gain: unknown to high
- Risk: medium
- Complexity: low-medium
- Confidence: medium

Worker-management, observation, and source-assignment filters remain plausible index candidates.
Capture EXPLAIN (ANALYZE, BUFFERS) with realistic row counts and write load before adding indexes;
validate read p95, write amplification, lock time, and migration safety.

### P2-02 — Instrument command admission before adding concurrency limits

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: reliability under overload
- Risk: medium
- Complexity: medium
- Confidence: medium

cantrip_worker/src/transport.ts:957-995,1028-1059 dispatches independent async request handlers
without family-wide admission. First measure active commands, memory, event-loop delay, and family
latency under mixed workloads; only then add fair family limits that preserve cancellation and
interactive priority.

### P2-03 — Measure coordination bulk-frame cost before changing the data plane

- Category: HOT_PATH_ALLOCATION, N_PLUS_ONE_OR_CHATTER
- Expected gain: potentially high multi-instance
- Risk: high
- Complexity: high
- Confidence: medium

cantrip_server/src/workers/coordinated-bridge.ts:281-321 publishes local surface, tunnel, and
WorkerLink frames into coordination; 1004-1023 base64-wraps them; relay-coordinator.ts:599-607,
935-939 JSON parses/serializes through Redis. Measure bytes, CPU, Redis latency, and subscriber
interest first. Interest-aware targeting or a binary instance relay is not a low-risk first change.

### P2-04 — Narrow Elite-mode global DOM effects only if profiles justify it

- Category: REDUNDANT_COMPUTATION
- Expected gain: unknown; medium when enabled
- Risk: medium
- Complexity: medium
- Confidence: medium

cantrip_app/src/components/elite/elite-global-effects.tsx:128-147,222-245,300-338 globally scans,
measures, sorts, and observes candidate DOM. Profile large streaming surfaces with Elite enabled;
only then narrow observation boundaries, batch a frame, and cap timers while preserving visual output.

## Shared primitives that reduce duplication safely

- Guarded interval runner: one in-flight execution, optional latest rerun, unref/stop semantics, and
  fake-clock tests. Use for expiry, presence, and recovery without weakening watchdogs.
- Head-index byte deque: O(1) push/evict/read, exact byte accounting, stable order, and occasional
  compaction. Use for replay and command queues.
- Ordered bounded mapper: deterministic order with a concurrency cap. Use for discovery, validation,
  presence, and startup probes.
- Incremental bounded stream accumulator: immutable chunks, exact bytes, O(1) head trim, and
  materialization only at delivery. Use for Codex output.

These should remain small internal utilities tied to the listed callers, not a generic framework.

## Historical recommended delivery sequence

### Wave 0 — add proof counters and deterministic fixtures

- Database: statements and pool occupancy for workload listing, AppLive authorization, worker
  management, and Task dispatch.
- Worker: Git children, attachment handles/bytes, and Codex clone/materialization counts.
- UI: React commits, overlay copies/sorts, anchor layout reads, CSV parses, DOM nodes, and bundle
  chunks.

### Wave 1 — local and mechanically verifiable

Implement N0-19, P0-06, P0-08, P1-01, P1-06, P1-07, P1-11,
P1-15, and P1-18. These primarily remove invisible work, replace an equivalent local primitive, or
make an existing batching contract effective.

### Wave 2 — bounded batching, routing, and ownership

Implement N0-07 through N0-18, N0-20,
P0-03, P0-04, P0-07, P0-10, P0-13, P0-14, and P1-02 through P1-05, P1-08 through
P1-10, P1-12 through P1-14, P1-16, P1-17, and P1-20. Land each behind its equivalence,
security, deadline, and bounded-cache/queue tests.

### Wave 3 — conditional architecture

Use Wave 0 telemetry to decide P2-01 through P2-04. Do not change database indexing, command
admission, coordination transport, or global DOM architecture without production-shaped evidence.

## Success metrics

| Surface                  | Primary metric                                       | Guardrail                                 |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------- |
| Task workload            | SQL per workload cycle and dashboard p95             | FIFO, fencing, encryption                 |
| Run configurations       | discovery and validation latency                     | exact definitions and failure behavior    |
| Codex streaming          | copied bytes, allocations, event-loop delay          | UTF-8, truncation, and ordering           |
| Project/worker inventory | HTTP, commands, SQL, p95 by fleet size               | exact fail-closed protected metadata      |
| UI rendering             | commits, parses, layout reads, DOM/heap, cold TTI    | focus, scroll, actions, visual parity     |
| Failure/shutdown         | retry distribution, cleanup completion, bounded exit | manual immediacy; every cleanup attempted |

The desired end state is behavioral: idle clients and workers should become quiet; long chats should
type like short chats; large fleets and backlogs should avoid repeated per-item work; and degraded
services should recover without creating their own load spike.
