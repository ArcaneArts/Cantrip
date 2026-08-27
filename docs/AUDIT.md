# Cantrip performance and reliability audit

- Date: 2026-08-27
- Audit baseline: origin/main at ad6cc1b4bbb54dd27078dabed028654d700b7beb
- Reconciliation updated through: origin/main at a5fe041d62447876e94134289e92385799a79756
- Status: third independent audit complete; T0-01 through T0-08 fixed and removed from the active inventory
- Scope: cantrip_app, cantrip_server, cantrip_worker, packages/protocol, and their cross-layer paths

## Executive result

The architecture is healthier than the prior report implied. Supported interactive transports now
converge on WorkerLink, healthy AppLive replaces ordinary resource polling, and several earlier UI
and scheduler hot paths have been fixed. This pass removed every completed record from the active
inventory and audited the replacement architecture rather than carrying legacy evidence forward.

The deeper pass originally found 14 strong new opportunities. T0-01 through T0-08 are now fixed in
PRs #1220, #1221, and #1223 through #1228. Six third-pass opportunities remain active:

- WorkerLink peer signaling still polls and processes nominal batches one signal at a time;
- the worker still rewrites its lifetime-growing routing registry for unchanged protected results;
- Chat archive preparation still performs synchronous bit-at-a-time CRC32;
- observation envelopes still incur repeated parsing, serialization, encoding, and copies;
- ordinary WorkerLink control operations still trigger global expiry scans; and
- each WorkerLink grant still renews through an independent authenticated request and worker command.

There are 49 actionable opportunities after reconciliation: six remaining third-pass findings and
43 still-valid carryovers. Four additional items remain measure-first candidates. The priority table
is intentionally narrower than the full inventory.

| Rank | Opportunity                                               | Gain                      | Risk       | Dominant avoided work                                   |
| ---: | --------------------------------------------------------- | ------------------------- | ---------- | ------------------------------------------------------- |
|    1 | T0-09 make peer signaling waitable and actually batched   | high connection setup     | low-medium | 40 ms HTTP polling and per-signal authority round trips |
|    2 | T0-10 skip unchanged routing-registry snapshots           | high Git/worktree         | low        | full JSON write and rename for warm read-only results   |
|    3 | T0-11 use native or table-driven CRC32                    | high archive preparation  | low        | eight synchronous JavaScript bit steps per byte         |
|    4 | T0-12 encode and parse observation envelopes once         | high streamed observation | low-medium | repeated schema walks, stringify, encode, and copies    |
|    5 | T0-13 remove global WorkerLink sweeps from hot operations | high at scale             | low-medium | scans of all sessions, grants, and peers per renewal    |
|    6 | T0-14 centralize and batch WorkerLink grant renewal       | high multi-resource idle  | low-medium | one authenticated request and worker command per grant  |
|    7 | N0-01 watcher-first Run-configuration reconciliation      | very high idle            | low        | full repository scan every 500 ms while watcher healthy |
|    8 | N0-03 linear, low-copy Browser Code framing               | high interactive          | low-medium | cumulative receive-buffer and fragmentation copies      |
|    9 | P0-04 narrow AppLive subscription authorization           | high reconnect            | low        | full resource hydration for up to 128 scopes            |
|   10 | P0-06 collapse worker-management 1 + 2N queries           | high fleet-wide           | low        | pool-consuming list and mutation fanout                 |
|   11 | N0-15 batch Task dispatch preparation                     | high Task backlog         | low-medium | repeated snapshot/route work and no-op reason writes    |
|   12 | P0-07 coalesce worktree observation                       | high idle                 | low-medium | per-target SQL, Git probes, and duplicate watchers      |

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
inventory.

| ID    | Status | Landed change                                 |
| ----- | ------ | --------------------------------------------- |
| T0-01 | fixed  | #1221 drains the WorkerLink byte window       |
| T0-02 | fixed  | #1220 focuses execution-target resolution     |
| T0-03 | fixed  | #1224 scopes direct-observation recovery      |
| T0-04 | fixed  | #1223 scopes WorkerObservation demand         |
| T0-05 | fixed  | #1225 narrows Task live-routing lookups       |
| T0-06 | fixed  | #1226 reuses validated WorkerLink frame bytes |
| T0-07 | fixed  | #1227 gates worker polling on AppLive health  |
| T0-08 | fixed  | #1228 aggregates WorkerLink client telemetry  |

## Remaining third-pass opportunities

### T0-09 — opportunity — Make WorkerLink peer signaling waitable and actually batched

- Category: N_PLUS_ONE_OR_CHATTER, ALGORITHM_COMPLEXITY
- Expected gain: high for route negotiation, especially with replicated servers
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_app/src/lib/worker-link-peer-carrier.ts:33,349-366 performs an authenticated mailbox POST
  every 40 ms until handshake; cantrip_app/src/lib/api.ts:931-941 implements the request.
- The client sends each signal as a one-entry batch at worker-link-peer-carrier.ts:443-461.
- Protocol accepts 1-256 signals at packages/protocol/src/worker-link.ts:459-475, but
  cantrip_server/src/app.ts:14829-14875 awaits the service once per signal.
- worker-links/service.ts:221-235,411-456,620-646 performs authority lookup/routing per signal;
  cantrip_server/src/worker-links/coordinator.ts:422-485 emits one worker command per signal. Remote authority can multiply Redis
  lookups and pub/sub request/response operations across the batch.
- cantrip_server/src/worker-links/coordinator.ts:1107-1215,1342-1358 also scans sessions and clones/stringifies the growing mailbox
  to enforce byte limits on each append.

Hypothesis: direct route setup can create 25 authenticated mailbox reads per second plus per-candidate
HTTP, authority, Redis, and worker-command round trips. Worst-case mailbox byte checking approaches
quadratic work.

Suggested change: add a waitable mailbox read or AppLive/control notification with bounded long-poll
fallback. Add one internal signal-peer-batch authority operation; validate common authority and
contiguous sequence once. Initially reuse local single-signal semantics to preserve accepted-prefix
behavior. Add peerSessionId indexing and incremental encoded-byte accounting.

Validation: batches of 1/32/256 on local and remote authority plus LAN/WAN negotiation under late ICE,
loss, timeout, and handoff. Count HTTP, Redis, pub/sub, commands, and setup p95; inject failure at k
and preserve accepted-prefix, retry, idempotency, revocation, cursor, and degraded fallback behavior.

### T0-10 — opportunity — Skip unchanged full routing-registry rewrites

- Category: REDUNDANT_COMPUTATION, SYNC_IO_HOT_PATH
- Expected gain: high for Git/worktree operations
- Risk: low
- Complexity: low-medium
- Confidence: high

Evidence:

- cantrip_worker/src/routing-registry.ts:16-39 protects common project, worktree, replica, and Chat
  scratch results. Lines 93-98 and 111-123 persist after every protected result or metadata request.
- routing-registry.ts:188-202 returns an existing token without mutating state, yet 234-255 serializes
  every historical record, writes a complete temporary file, and renames it. There is no record bound
  at 77-82.
- Every protected command result passes through this path at cantrip_worker/src/index.ts:5463-5477.

Hypothesis: warm worktree.list/status and metadata reads rewrite an increasingly large registry while
creating zero tokens, adding synchronous command latency and avoidable filesystem wear.

Suggested change: maintain a mutation revision incremented only when a token is inserted. Persist
only when the caller's required revision exceeds the durable revision, coalescing concurrent callers
onto a latest snapshot while returning only after their tokens are durable. Treat pruning separately.

Validation: after warming tokens, 10,000 identical protected results must produce zero writes and
flat latency as registry size grows. Concurrent new tokens must survive restart; injected write/rename
failure must retain the previous snapshot and retry safely; token stability and fail-closed resolution
must remain exact.

### T0-11 — opportunity — Replace synchronous bit-at-a-time ZIP CRC32

- Category: ALGORITHM_COMPLEXITY
- Expected gain: high for Chat archive preparation
- Risk: low with a runtime guard
- Complexity: low
- Confidence: high, measured

Evidence:

- cantrip_worker/src/chat-scratch-files.ts:38-43 permits 128 MiB archives and four concurrent
  preparations. Lines 176-185 perform eight JavaScript bit iterations per byte; 238-268 reads each
  file fully and runs that checksum on the worker event loop.
- The repository root ./package.json:6-8 declares Node 22 or newer. Installed Node typings document node:zlib.crc32 from
  22.2, so the broad floor requires feature detection, a table fallback, or a slightly narrower floor.

Focused benchmark: a 16 MiB Buffer filled with 0x5a, five runs per implementation on Node v24.14.0.
The exact current function measured median 482.493 ms (range 476.217-576.822); node:zlib.crc32
measured median 0.545 ms (range 0.538-0.591). Both returned 3382484216, an approximately 885 times
median reduction for this input.

Hypothesis: a maximum-size archive can monopolize the worker event loop for seconds before writing,
and four concurrent preparations compound latency for unrelated services.

Suggested change: use native crc32 when available with a table-driven fallback, without changing ZIP
layout or full-file ownership. Streaming ZIP/data-descriptor work is a separate memory optimization.

Validation: golden-compare empty, random, all-byte, and chunk-boundary inputs; open archives with
platform readers; verify names, bytes, timestamps, and CRC rejection. Benchmark 1/16/128 MiB while
recording event-loop delay, and test the declared minimum-runtime/fallback path.

### T0-12 — opportunity — Stop reparsing and reserializing every observation envelope

- Category: REGEX_OR_PARSING_HOT_PATH, REDUNDANT_COMPUTATION, HOT_PATH_ALLOCATION
- Expected gain: high for streamed and multi-subscriber workers
- Risk: low-medium
- Complexity: low-medium
- Confidence: high

Evidence:

- packages/protocol/src/index.ts:15937-15957 validates envelope size by serializing and encoding the
  complete value.
- cantrip_worker/src/worker-observation-worker-link-adapter.ts:100-136 validates payload, then 151-168
  reparses it inside every subscriber envelope and serializes it twice.
- cantrip_app/src/lib/worker-observation-client.ts:201-234 copies, decodes, parses, and triggers size
  validation that serializes the value again.

Hypothesis: one event times many subscribers performs repeated deep schema walks and full-payload
serialization; accumulated Codex messages make this progressively more expensive.

Suggested change: separate structural validation from raw wire-size enforcement. Validate producer
payload once, build a trusted envelope, encode once, and check actual bytes. On receive, reject raw
bytes above 512 KiB before JSON parse, then structurally parse once. Reuse codecs.

Validation: test 512 KiB minus one, exact, and plus one with Unicode; malformed nested payloads; 10,000
streaming events; and many subscribers. Preserve continuity, credit accounting, type isolation, and
malformed rejection.

### T0-13 — opportunity — Remove global WorkerLink expiry scans from ordinary operations

- Category: ALGORITHM_COMPLEXITY, STATE_OR_CACHE_STRATEGY
- Expected gain: high at many active sessions
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/worker-links/coordinator.ts:44-49 permits 1,024 sessions; protocol permits 128
  grants per session at packages/protocol/src/worker-link.ts:20.
- cantrip_server/src/worker-links/coordinator.ts:143-150 installs an unguarded five-second sweep. Session open, grant issue, peer
  open, session renew, route replacement, and grant renew also await a full sweep at
  153-190,298-303,557-663.
- cantrip_server/src/worker-links/coordinator.ts:855-892 scans every session, grant, and peer, parses each deadline, and revokes
  expired records sequentially through worker commands. readySession at 1074-1085 does not enforce
  only the addressed session's deadline.
- The worker gateway and peer gateway also run fixed global sweeps at
  cantrip_worker/src/worker-link-gateway.ts:159-168,662-710 and
  worker-link-peer-gateway.ts:68-76,158-168.

Hypothesis: otherwise constant-time control operations become proportional to all authority state;
one renewal can inspect more than 131,000 configured grants, and concurrent timer/request sweeps can
repeat the work.

Suggested change: make each watchdog single-flight, validate only the addressed session/grant/peer
on hot operations, and keep the full watchdog for durable cleanup. Run a global pre-capacity sweep
only when an open would hit the session cap. Add next-deadline indexing only after measurement.

Validation: 1/100/1,024 sessions with 1/128 grants and 1,000 renewals. Count scans, concurrent sweeps,
commands, p95, and event-loop delay; preserve exact deadline rejection, capacity reclamation,
revocation order, fences, restart recovery, and the five-second watchdog bound.

### T0-14 — opportunity — Centralize and batch WorkerLink grant renewal

- Category: N_PLUS_ONE_OR_CHATTER, STATE_OR_CACHE_STRATEGY
- Expected gain: high with many active resources
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- Each grant has a 60-second lease at cantrip_server/src/worker-links/coordinator.ts:44-47.
- Terminal, tunnel, remote-surface, and observation clients independently renew 20 seconds early at
  cantrip_app/src/lib/terminal-worker-link.ts:230-243,
  tunnel-worker-link.ts:303-316, remote-surface-worker-link.ts:610-623, and
  worker-observation-client.ts:268-286.
- cantrip_app/src/lib/api.ts:1005-1011 sends one HTTP request per grant.
  cantrip_server/src/app.ts:15099-15138 authenticates and renews one grant;
  cantrip_server/src/worker-links/coordinator.ts:656-690 performs a full sweep and one worker command for it.
- Protocol permits 128 grants per session. The demand-scoping work in #1223 reduces unnecessary
  observation grants but does not remove renewal churn for legitimate Terminal, Code, surface, and
  tunnel resources.

Hypothesis: multi-surface sessions produce synchronized idle HTTP/auth/schema/sweep/worker-command
waves every roughly 40 seconds.

Suggested change: centralize client lease ownership per WorkerLink session and batch due grant IDs
into one endpoint and worker command with per-entry results. Jitter deadlines and preserve individual
revocation, generation fencing, and failure handling. Consider session-renew piggyback only if it
does not weaken per-grant expiry.

Validation: run 1/10/128 grants through renewal, partial failure, route replacement, offline worker,
revocation, and session expiry. Compare requests, sweeps, commands, and p95; prove no grace widening
and exact per-grant failure behavior.

## Revalidated priority opportunities

### N0-01 — opportunity — Replace 500 ms Run-configuration rescans with watcher-first reconciliation

- Category: SYNC_IO_HOT_PATH, N_PLUS_ONE_OR_CHATTER
- Expected gain: very high idle-worker reduction
- Risk: low
- Complexity: low-medium
- Confidence: high

Evidence: cantrip_worker/src/run-configuration-repository.ts:44-46,595-672,924-940 keeps a watcher
and a full scan every 500 ms; run-configuration-definition-service.ts:401-455 permits 256 observed
projects. Suggested change: use watcher events while healthy, a slower integrity sweep, and the fast
poll only during watcher degradation. Validation: count reads/parses over ten idle minutes and prove
create/edit/delete/rename plus watcher-loss recovery within documented bounds.

### N0-03 — opportunity — Make Browser Code tunnel framing linear and low-copy

- Category: HOT_PATH_ALLOCATION, ALGORITHM_COMPLEXITY
- Expected gain: high interactive
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_app/src/lib/browser-code-tunnel.ts:1991-2008 reallocates the complete receive
buffer for each chunk; 2067-2072 and 2173-2175 copy frames and compact tails; 2105-2124 reassembles
fragments and posts without transfer; 492-494 adds a decrypted-payload copy. Suggested change: use a
segmented/ring buffer, one payload ownership boundary, and transferable binary posts. Validation:
fragment 1/8 MiB messages and compare allocations, GC, latency, byte identity, congestion, credit,
and close behavior.

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
db/repository.ts:18136-18176 duplicates request-path expiry and restores affected chats sequentially;
workflows/executor.ts:529-544 hydrates full runs for notification. Suggested change: a shared guarded
runner, narrow expiry return projections, and batched restoration, with durable bounded watchdogs.
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

### N0-19 — opportunity — Pre-index workflow detail joins in the UI

- Category: ALGORITHM_COMPLEXITY
- Expected gain: medium-high
- Risk: low
- Complexity: low
- Confidence: high

Evidence: cantrip_app/src/components/workflows/workflow-center.tsx:1444-1460 filters all attempts and
searches revision nodes inside every node render; packages/protocol/src/workflows.ts:2221-2226 permits
1,000 nodes and 10,000 attempts. Suggested change: memoize attemptsByNodeId and revisionNodeByKey per
run revision. Validation: 100/1,000 nodes with 1,000/10,000 attempts and exact order, status,
selection, and actions.

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
cantrip_server/src/app.ts:4727-4746 still uses full project lists, chat execution context, and workflow details.
Suggested change: group project/chat/workflow IDs and use narrow ownership/existence queries while
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

## Revalidated follow-on inventory

These remain actionable but rank below the frontier above. Each row includes current proof and the
minimum safe next step; implementation should retain the detailed equivalence tests already named in
prior audits.

| ID    | Category and assessment                                                                                  | Current evidence                                                                                                                                                                                                             | Suggested change and validation gate                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | REDUNDANT_COMPUTATION; medium; low risk; low complexity; high confidence                                 | relay-coordinator.ts:273-296 measures coordination bytes by stringify; 935-939 stringifies again for Redis                                                                                                                   | serialize once and carry bytes/length; assert exact quotas and wire payloads                                                |
| P1-02 | N_PLUS_ONE_OR_CHATTER; medium-high fleet; low-medium risk; medium complexity; high confidence            | coordinated-bridge.ts:121-132 has an unguarded presence interval; 1115-1177 refreshes sequentially; relay-coordinator.ts:587-625 scans then GETs serially                                                                    | guarded bounded concurrency and Redis bulk read; test disconnect/revoke/order and large fleets                              |
| P1-03 | N_PLUS_ONE_OR_CHATTER; medium-high recovery; low risk; medium complexity; high confidence                | db/workflow-runs.ts:5573-5655 selects up to 500 attempts and sequentially loads full runs plus revision nodes                                                                                                                | memoize/bulk recovery projections; compare SQL and outcomes for shared runs                                                 |
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
- Waitable bounded mailbox: cursor-based long poll or live notification, explicit timeout, replay,
  and HTTP fallback. Use for peer signaling before inventing another transport.
- Session lease manager: keyed grant deadlines, jitter, per-entry batch results, lifecycle flush, and
  individual revocation. Use across Terminal, tunnel, surface, and observation grants.
- Head-index byte deque: O(1) push/evict/read, exact byte accounting, stable order, and occasional
  compaction. Use for replay and command queues.
- Ordered bounded mapper: deterministic order with a concurrency cap. Use for discovery, validation,
  presence, and startup probes.
- Coalesced durable revision writer: immediate in-memory revision, callers wait for required durable
  revision, latest-snapshot coalescing, and atomic replace. Use for the routing registry.
- Incremental bounded stream accumulator: immutable chunks, exact bytes, O(1) head trim, and
  materialization only at delivery. Use for Browser Code and Codex output.

These should remain small internal utilities tied to the listed callers, not a generic framework.

## Recommended delivery sequence

### Wave 0 — add proof counters and deterministic fixtures

- WorkerLink: HTTP/Redis signaling operations, renewal requests, sweep scans, and observation-envelope
  parse, encode, and copied-byte counts.
- Database: statements and pool occupancy for workload listing, AppLive authorization, worker
  management, and Task dispatch.
- Worker: routing-registry writes/bytes, CRC/event-loop delay, Run-configuration reads, Git children,
  attachment handles/bytes, and Codex clone/materialization counts.
- UI: React commits, overlay copies/sorts, anchor layout reads, CSV parses, DOM nodes, and bundle
  chunks.

### Wave 1 — local and mechanically verifiable

Implement T0-10, T0-11, N0-19, P0-06, P0-08, P1-01, P1-06, P1-07, P1-11,
P1-15, and P1-18. These primarily remove invisible work, replace an equivalent local primitive, or
make an existing batching contract effective.

### Wave 2 — bounded batching, routing, and ownership

Implement T0-09, T0-12 through T0-14, N0-01, N0-03, N0-07 through N0-18, N0-20,
P0-03, P0-04, P0-07, P0-10, P0-13, P0-14, and P1-02 through P1-05, P1-08 through
P1-10, P1-12 through P1-14, P1-16, P1-17, and P1-20. Land each behind its equivalence,
security, deadline, and bounded-cache/queue tests.

### Wave 3 — conditional architecture

Use Wave 0 telemetry to decide P2-01 through P2-04. Do not change database indexing, command
admission, coordination transport, or global DOM architecture without production-shaped evidence.

## Success metrics

| Surface                  | Primary metric                                                  | Guardrail                                   |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------- |
| WorkerLink authority     | HTTP/Redis/commands per negotiation or renewal; records scanned | deadline, revocation, idempotency, fallback |
| Task workload            | SQL per workload cycle and dashboard p95                        | FIFO, fencing, encryption                   |
| Run configurations       | reads/parses per minute and detect/list p95                     | watcher-loss recovery                       |
| Codex/Browser Code       | copied bytes, allocations, event-loop delay                     | UTF-8, truncation, framing, ordering        |
| Routing registry         | writes and serialized bytes per protected result                | durability, token stability, atomic failure |
| Chat archives            | checksum time and event-loop delay at 1/16/128 MiB              | identical CRC and ZIP compatibility         |
| Project/worker inventory | HTTP, commands, SQL, p95 by fleet size                          | exact fail-closed protected metadata        |
| UI rendering             | commits, parses, layout reads, DOM/heap, cold TTI               | focus, scroll, actions, visual parity       |
| Failure/shutdown         | retry distribution, cleanup completion, bounded exit            | manual immediacy; every cleanup attempted   |

The desired end state is behavioral: idle clients and workers should become quiet; WorkerLink
authority paths should batch signaling and leases without scanning global state; routing reads should
not rewrite unchanged registries; archive preparation should not block the worker event loop; long
chats should type like short chats; and degraded services should recover without creating their own
load spike.
