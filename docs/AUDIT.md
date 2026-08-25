# Cantrip performance and reliability audit

- Date: 2026-08-24
- Baseline: origin/main at 77216a0224b354b9e4b7f94495b94ba5c1254980
- Status: second independent audit complete; pending inventory reconciled to current source

## Executive result

The live architecture remains sound: AppLive eliminates repeating project-resource HTTP
while healthy, workers own local filesystem/process observation, and bounded recovery
polling protects degraded and restart paths. The deeper second pass found the largest safe
gains one layer below that architecture:

- healthy Run-configuration watchers still accompany a 500 ms full repository rescan;
- the durable one-second Task scheduler executes logically impossible resume/claim work for
  running-only owners;
- Browser Code tunnel framing repeatedly copies accumulated byte streams and can grow
  quadratically with fragmentation;
- every accepted AppLive event synchronously persists its cursor and wakes status-only React
  subscribers;
- closed inspection UI, disabled provider queries, and diagnostic capture still build or
  parse expensive data that the user cannot see;
- project, Task, worker-metadata, session-validation, and attachment-maintenance paths retain
  avoidable N+1 request/query patterns;
- attachment ranges and command streams reread or recopy data already in memory or on disk.

Five completed findings were removed from the active report: former P0-01, P0-05, P0-09,
P0-11, and P0-12. Their current implementations and focused tests were rechecked before
removal. P0-06 was marked fixed only by a status-only documentation change; current source
still contains its original `1 + 2N` query pattern, so this pass restores it as pending.

The priority frontier now mixes the strongest new findings with still-valid carryovers:

| Rank | Opportunity                                              | Gain             | Risk       | Dominant avoided work                                   |
| ---- | -------------------------------------------------------- | ---------------- | ---------- | ------------------------------------------------------- |
| 1    | N0-01 watcher-first Run-configuration reconciliation     | very high idle   | low        | up to 128 rereads/parses every 500 ms per repository    |
| 2    | N0-02 state-gate the durable Task scheduler              | high fleet-wide  | low        | impossible resume/claim transactions every second       |
| 3    | N0-03 linear, low-copy Browser Code tunnel framing       | high interactive | low-medium | cumulative buffer copies and repeated payload copies    |
| 4    | N0-04 coalesce AppLive cursor persistence/subscriptions  | high during live | low-medium | synchronous storage plus React fanout per event         |
| 5    | N0-05 cache provider catalogs outside transcript renders | high interaction | low        | repeated multi-megabyte storage parse/schema validation |
| 6    | N0-06 unmount hidden inspection trajectory work          | high long-chat   | low        | invisible projections and thousands of retained rows    |
| 7    | N0-07 batch project/worker routing metadata hydration    | high fleet-wide  | low-medium | per-project HTTP and per-worker protected commands      |
| 8    | N0-08 make attachment transfer genuinely ranged          | high transfer    | low-medium | full-file reads for every requested range               |
| 9    | N0-09 disable routine full-payload diagnostic cloning    | high streaming   | low-medium | recursive clone/redaction of every Codex RPC            |
| 10   | N0-10 batch Codex stream accumulation at 100 ms          | high streaming   | low-medium | complete-buffer encode/copy on every small delta        |
| 11   | N0-11 bulk-read Project Task workloads                   | high dashboard   | low-medium | approximately `3 + 3N` SQL plus oversized invalidation  |
| 12   | N0-12 consolidate authenticated socket validation        | high at scale    | low        | duplicate per-session/per-frame database reads          |
| 13   | N0-13 add a live-message wire discriminator              | high Task chat   | low-medium | failed wrong-key decrypt and repeated schema passes     |
| 14   | N0-14 batch retained-attachment maintenance              | high at scale    | low-medium | up to `6N` authenticated heartbeat requests per minute  |
| 15   | P0-02 remove redundant remote-frame work end to end      | high interactive | low-medium | frame-sized copies and repeated encoding                |
| 16   | P0-04 batch narrow AppLive authorization                 | high reconnect   | low        | full resource hydration per subscribed scope            |
| 17   | P0-06 collapse worker-management `1 + 2N` queries        | high fleet-wide  | low        | pool-consuming list and mutation fanout                 |
| 18   | P0-07 coalesce worktree observation                      | high idle        | low-medium | per-target SQL, Git probes, watchers, and overlap       |

## Scope and method

The audit inspected cantrip_app, cantrip_server, cantrip_worker, packages/protocol, and their
cross-layer call paths. It deliberately did not spend time inside cantrip_code,
cantrip_codex, or cantrip_site. Generated and vendored candidates were discarded.

Three fresh independent source passes covered UI/rendering, server/netcode/database
behavior, and worker/service management. A fourth cross-layer pass followed Browser Code,
project hydration, AppLive, attachment, and command-stream paths. Automated static scouting
was used only to locate candidates; generated/minified matches were discarded and every
retained finding was manually re-read at the cited current-source lines.

This is a static audit, not a production profile. Every item is therefore labeled
opportunity rather than confirmed bottleneck. Expected gain estimates combine call
frequency, bounded worst-case work, and user-facing position in the critical path. The
validation plan is part of each finding and must precede any claim of measured improvement.

Taxonomy categories are ALGORITHM_COMPLEXITY, HOT_PATH_ALLOCATION, SYNC_IO_HOT_PATH,
REGEX_OR_PARSING_HOT_PATH, N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION, and
STATE_OR_CACHE_STRATEGY.

## Architecture findings to preserve

The existing polling audits materially change the answer to “use more WebSockets”:

- docs/LIVE_TRANSPORT_AUDIT.md:42 records zero project-resource HTTP requests during a
  healthy steady-state AppLive run.
- docs/APP_LIVE_POLLING_AUDIT.md:9-10 documents HTTP as the initial snapshot and bounded
  degraded fallback rather than the normal repeating path.
- docs/APP_LIVE_POLLING_AUDIT.md:61-66 explains why pending MCP OAuth/external import
  observation is not a low-risk bare-notification conversion.
- docs/APP_LIVE_POLLING_AUDIT.md:68-74 retains the worker automation scheduler for durable
  execution, crash recovery, and missed-run correctness.
- docs/LIVE_TRANSPORT_AUDIT.md:133-134 explicitly retains recovery polling while disabling
  it when live transport is healthy.

Do not restore aggressive client polling, remove degraded recovery, or replace those two
durability-sensitive loops without correlated ownership, replay, fencing, and missed-run
recovery. The opportunities below optimize work that remains after those successful
migrations.

## New second-pass opportunities

### N0-01 — opportunity — Replace 500 ms Run-configuration rescans with watcher-first reconciliation

- Category: SYNC_IO_HOT_PATH, N_PLUS_ONE_OR_CHATTER
- Expected gain: very high idle-worker reduction
- Risk: low
- Complexity: low-medium
- Confidence: high

Evidence:

- cantrip_worker/src/run-configuration-repository.ts:44-46 sets a 500 ms poll, and lines
  924-940 keep it active even after the filesystem watcher is armed successfully.
- cantrip_worker/src/run-configuration-repository.ts:595-672 rereads, hashes, parses, and
  schema-validates as many as 128 files per scan; lines 141-170 open and read each file.
- cantrip_worker/src/run-configuration-definition-service.ts:37 and 401-455 retain
  persistent observation for as many as 256 projects.

Hypothesis: one inactive repository containing 128 definitions can perform roughly 256
complete file reads/parses each second. The configured static upper bound is 65,536 file
reads per second before directory, stat, hash, and schema work.

Suggested change: when the watcher is healthy, reconcile from events and retain a 30-60
second integrity sweep. Use the existing fast poll only while watching is unavailable or
degraded. Optionally lower the 256-project observation cap based on active attachment.

Validation: count readdir/open/read/hash/schema work for 1, 32, and 256 repositories at 0
and 128 files. Exercise initially missing directories, create/edit/rename/delete, watcher
errors, silently missed events, and eviction. The slow sweep must repair missed events.

### N0-02 — opportunity — Gate the durable Task scheduler by actual cycle state

- Category: N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION
- Expected gain: high fleet-wide
- Risk: low
- Complexity: low-medium
- Confidence: high

Evidence:

- cantrip_server/src/app.ts:1028 and 24335-24340 run the durable Task scheduler every second.
- cantrip_server/src/db/task-dispatch.ts:211-224 returns owners with any queued, claimed,
  running, or paused cycle.
- cantrip_server/src/app.ts:23902-23999 unconditionally performs lease reconciliation,
  paused eligibility/resume, and queued eligibility/claim for each owner.
- cantrip_server/src/db/task-dispatch.ts:742-805 locks and scans for paused work, while lines
  404-499 lock and issue four claim queries. The active-lane query at 490-499 is not scoped
  to the owner.

Hypothesis: a single long-running Task keeps logically impossible resume and claim queries
running every second for its entire duration, competing through the five-connection pool.

Suggested change: preserve the one-second durability watchdog, but return per-state flags or
counts from the owner scan. Run paused preparation only when paused work exists, queued
preparation only when queued work exists, and lease expiry only for claimed/running work.
Scope active-lane reads to the owner/candidate chats.

Validation: count SQL for 60 seconds with none, queued, claimed, running, paused, and mixed
states. Running-only owners must perform no pause/claim hydration, while expiration,
fencing, restart recovery, and the current recovery bound remain identical.

### N0-03 — opportunity — Make Browser Code tunnel framing linear and low-copy

- Category: HOT_PATH_ALLOCATION, ALGORITHM_COMPLEXITY
- Expected gain: high for embedded Code interaction
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_app/src/lib/browser-code-tunnel.ts:209-222 copies decrypted payloads before
  delivery. Lines 810-820 allocate `old buffer + chunk` and recopy all retained bytes for
  every incoming chunk.
- cantrip_app/src/lib/browser-code-tunnel.ts:823-885 copies parsed frame payloads and then
  copies completed fragmented messages again.
- cantrip_app/src/lib/browser-code-tunnel.ts:924-933 posts the final ArrayBuffer without a
  transfer list, permitting another structured-clone copy.
- packages/protocol/src/tunnel-data-plane.ts:7 permits 64 KiB plaintext frames, while the
  browser HTTP tunnel path accepts responses up to 64 MiB.

Hypothesis: extension-host, LSP, and asset traffic pays several full payload copies; repeated
concatenation makes a fragmented large message quadratic and increases GC/input latency.

Suggested change: replace monolithic append with a chunk deque/head offset or amortized
growable buffer, establish payload ownership so each boundary copies at most once, and
transfer final binary buffers through `postMessage`. Preserve source sequence ordering and
ensure destination-credit return cannot sit behind a source-credit wait.

Validation: replay 1 KiB, 64 KiB, 1 MiB, and 8 MiB fragmented traffic both directions.
Measure bytes copied, allocations, GC, throughput, and latency; require exact framing,
sequence/credit behavior, bounds, malformed rejection, and linear scaling.

### N0-04 — opportunity — Coalesce AppLive cursor persistence and split status subscriptions

- Category: SYNC_IO_HOT_PATH, REDUNDANT_COMPUTATION
- Expected gain: high during live bursts
- Risk: low-medium
- Complexity: low-medium
- Confidence: high

Evidence:

- cantrip_app/src/lib/app-live-client.ts:732-735 advances the cursor for every accepted
  event; lines 1041-1059 emit a new snapshot and synchronously call
  `storage.setItem(JSON.stringify(...))` on every advance.
- cantrip_app/src/lib/app-live-react.tsx:36-48 makes status-only consumers subscribe to the
  full snapshot and set React state on every emit. Status is consumed throughout App, chat,
  settings, Tasks, Git, workflows, and projects.

Hypothesis: streaming traffic performs synchronous localStorage I/O, snapshot allocation,
listener fanout, and status-only React updates on the main thread for every live event.

Suggested change: keep the in-memory cursor immediate, persist the latest cursor on a
bounded 100-250 ms trailing schedule, and flush on stop/pagehide/visibility/shutdown. Add a
status selector/subscription that emits only on status transitions while retaining the full
diagnostic snapshot API.

Validation: inject 10,000 sequential events and count storage writes/status callbacks.
Require exact final cursor after every explicit lifecycle flush, safe replay from an
intentionally lagged persisted cursor, no event loss, and identical status transitions.

### N0-05 — opportunity — Remove provider-cache parsing from ordinary transcript renders

- Category: SYNC_IO_HOT_PATH, REGEX_OR_PARSING_HOT_PATH
- Expected gain: high with a populated catalog cache
- Risk: low
- Complexity: low
- Confidence: high

Evidence:

- cantrip_app/src/components/settings/provider-catalog-cache.ts:8-12 permits eight entries
  and three million stored characters. Lines 34-60 perform localStorage read, JSON parse,
  and schema validation for every stored entry on each load.
- cantrip_app/src/components/settings/provider-catalog-cache.ts:74-115 rereads on lookup and
  rereads/revalidates/reserializes on write without an in-memory hydration layer.
- cantrip_app/src/components/settings/use-provider-catalog.ts:16-34 computes placeholder
  data even when the query is disabled.
- cantrip_app/src/App.tsx:1430-1449 constructs those options during ChatTranscript renders
  while image-attachment state only controls `enabled`.

Hypothesis: ordinary text-chat updates can synchronously parse and validate megabytes of
catalog data once per provider, directly in the typing/render path.

Suggested change: skip placeholder lookup when disabled; hydrate a server/user-scoped
module/session cache once, update it on writes, and persist only actual changes.

Validation: seed the maximum three-megabyte cache and simulate 100 keystrokes across
multiple providers. Require zero reads while image queries are disabled, one hydration on
first enable, and identical expiry, corrupt-cache, and server/user isolation behavior.

### N0-06 — opportunity — Do not retain full trajectory UI while Inspect is closed

- Category: REDUNDANT_COMPUTATION
- Expected gain: high for long chats
- Risk: low
- Complexity: low-medium
- Confidence: high

Evidence:

- cantrip_app/src/App.tsx:3544-3595 always renders the Inspect shell and content.
- cantrip_app/src/components/ui/resizable-panel.tsx:345-379 closes via width, inert, and
  opacity but leaves children mounted.
- cantrip_app/src/components/chat/agent-inspect-content.tsx:438-559 has no hidden
  short-circuit for expensive content.
- cantrip_app/src/components/chat/agent-trajectory.tsx:237-268 rebuilds projections,
  and lines 730-755 map the full trajectory into DOM rows.

Hypothesis: a closed panel retains/reconciles a large invisible event tree and duplicates
agent projection work during composer/live updates. This is distinct from the completed
transcript-row memoization.

Suggested change: lazily mount or short-circuit expensive content while closed, preserve
intentional controlled tab/filter state, and reuse the parent's computed projection when
open. Windowing visible rows can remain a measured follow-up.

Validation: with 1,000 events and the panel closed, projection calls and trajectory rows
must remain zero across 100 draft and 100 live updates. Opening must preserve exact order,
selection, filtering, and the explicitly chosen reopen-state policy.

### N0-07 — opportunity — Batch project and worker routing-metadata hydration

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high for larger project/fleet lists
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_app/src/lib/project-encryption.ts:143-205 resolves protected project metadata and
  calls `listWorktrees(project.id)` separately for every project.
- cantrip_app/src/lib/project-encryption.ts:211-273 groups replicas by worker but still
  issues a separate protected metadata-resolution command for each worker/project group.
- cantrip_app/src/lib/api.ts:996-1024 similarly resolves worker-source metadata once per
  source after the management list response.
- cantrip_app/src/lib/api.ts:1770-1772 and 2379-2382 show the one initial project list plus a
  distinct worktree HTTP request per project; lines 2297-2322 route each protected metadata
  resolution through server and worker.

Hypothesis: opening project or worker management fans one logical list into N HTTP requests
and many protected server-worker round trips, increasing remote latency and encryption work.

Suggested change: include public worktree records in a bulk project response or add a batch
endpoint. Batch protected metadata inputs by worker while preserving per-scope associated
data and fail-closed behavior; a short-lived keyed single-flight is a safe intermediate.

Validation: use 1, 20, and 100 projects/sources across multiple workers. Count HTTP and
worker commands; assert exact decrypted/fail-closed routing metadata and AppLive freshness.

### N0-08 — opportunity — Make attachment transfer truly ranged and incremental

- Category: SYNC_IO_HOT_PATH
- Expected gain: high for upload, download, and relocation
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_worker/src/attachment-store.ts:15-16 permits 25 MiB files in 256 KiB chunks.
- cantrip_worker/src/attachment-store.ts:109-179 reopens with `appendFile` for each chunk and
  rereads the entire completed file solely to verify its digest.
- cantrip_worker/src/attachment-store.ts:200-225 calls `readFile` for every requested range
  and only then returns a subarray. Reading a 25 MiB file in 100 ranges can read about 2.5
  GiB from disk.
- cantrip_worker/src/chat-relocation-store.ts:121-169 repeats per-chunk append opens and the
  final digest pass; cantrip_worker/src/external-chat-attachments.ts:326-380 already contains
  a safe positioned ranged-reader shape.

Hypothesis: transfers create avoidable open/close traffic, full-file allocations, and
quadratic aggregate reads.

Suggested change: retain a bounded upload FileHandle plus incremental SHA-256 state, close
before rename/removal, and use positioned FileHandle reads for ranges. Extract the proven
ranged-reader shape; preserve relocation's necessary final JSON parse.

Validation: empty, maximum-size, concurrent, abort, shutdown, stale-upload, checksum-error,
out-of-order, EOF, and Windows handle-before-rename cases. Count handles, bytes read, RSS,
and syscalls; require byte-identical output.

### N0-09 — opportunity — Stop cloning every routine Codex RPC payload for diagnostics

- Category: REDUNDANT_COMPUTATION, HOT_PATH_ALLOCATION
- Expected gain: high during streaming and thread hydration
- Risk: low-medium
- Complexity: low-medium
- Confidence: high

Evidence:

- cantrip_worker/src/codex/app-server.ts:7065-7088 records a full diagnostic before
  dispatching every parsed RPC message, including streaming deltas.
- cantrip_worker/src/codex/app-server.ts:8758-8777 redacts and retains each payload in a
  count-bounded but not byte/node/string-bounded ring.
- cantrip_worker/src/codex/diagnostic-redaction.ts:10-38 recursively clones objects and
  arrays; every string runs bearer-token regex and registered-secret scans.
- Normal construction at cantrip_worker/src/index.ts:1277-1336 supplies no diagnostic
  consumer, and no production caller consumes the retained payload ring.

Hypothesis: high-volume deltas and large thread responses are synchronously copied and
scanned on the worker event loop even though routine diagnostics are unused.

Suggested change: always retain compact correlation/method/kind/time metadata, but capture
bounded redacted payloads only for malformed, unknown, unmatched, unsupported, error, or
explicitly enabled diagnostic cases. Add byte/node/string caps.

Validation: replay 100,000 deltas and one 10 MiB response. Measure CPU, heap, and event-loop
delay; preserve unique correlations, error/unknown visibility, protected diagnostic mode,
and all secret-redaction tests.

### N0-10 — opportunity — Batch Codex stream accumulation at the existing 100 ms boundary

- Category: HOT_PATH_ALLOCATION, ALGORITHM_COMPLEXITY
- Expected gain: high for long responses and verbose commands
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_worker/src/codex/app-server.ts:314-323 and 524-608 retain complete streaming text,
  a second complete last-emitted text, and append every small agent delta.
- cantrip_worker/src/codex/app-server.ts:2625-2676 strips each command delta character by
  character, then converts both complete current output and the delta to Buffers.
- cantrip_worker/src/codex/app-server.ts:7411-7444 performs that complete bounded-output
  rebuild per raw delta even though delivery is coalesced at lines 505-515.
- packages/protocol/src/index.ts:6704 permits 256 KiB of retained command output.

Hypothesis: small verbose deltas repeatedly encode/copy the growing buffer before the
coalescing boundary, approaching quadratic work and duplicating the agent response in
multiple accumulators.

Suggested change: collect immutable pending chunks, sanitize/bound once per scheduled flush
or completion, maintain O(1) head trimming, and keep one authoritative agent accumulator.
Only consider append-only wire events if transport-byte measurement still justifies them.

Validation: replay one-byte, 64-byte, and 4 KiB chunks to 10 KiB, 256 KiB, and 1 MiB. Require
identical final text, truncation, UTF-8/control handling, message order/classification, and
100 ms semantics; measure allocation, CPU, event-loop delay, and transport bytes.

### N0-11 — opportunity — Collapse the Project Task workload endpoint's `3 + 3N` fanout

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high for Task-heavy projects
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/app.ts:24421-24456 lists Tasks, then loads one plan and a 100-message
  page for each Task.
- cantrip_server/src/db/repository.ts:15494-15520 implements the plan query; lines
  16576-16673 implement two queries per message page, for roughly `3 + 3N` SQL statements.
- cantrip_app/src/components/projects/project-tasks-dashboard.tsx:481-487 consumes the
  endpoint, while cantrip_app/src/lib/app-live-query.ts:201-275 invalidates the whole project
  workload on Task, message, goal, plan, and interaction events.

Hypothesis: one Task update can reread, parse, serialize, transfer, and decrypt plans plus up
to 100 protected messages for every historical Task in the project.

Suggested change: bulk-read all plans by chat ID, partition page headers by chat in one
query, and load selected message rows in one query while preserving exact order/page
boundaries. Patch only the affected Task after the bulk path is proven.

Validation: exact presentation/wire parity and SQL/payload/p95 at 1, 25, and 100 Tasks with
10, 100, and 10,000 messages. Replay one plan/message invalidation and verify unaffected
item identity and content.

### N0-12 — opportunity — Consolidate authenticated WebSocket session validation

- Category: N_PLUS_ONE_OR_CHATTER, STATE_OR_CACHE_STRATEGY
- Expected gain: high at connection scale
- Risk: low
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/app.ts:3845-3851 and 4286-4312 already group sockets by session, but
  lines 4349-4364 launch one database validation per session every 30 seconds without a
  sweep guard.
- cantrip_server/src/app.ts:4401-4412 provides another direct database-backed AppLive
  validator; cantrip_server/src/live/hub.ts:515-524 calls it for every inbound frame and
  lines 1081-1104 call it again for every heartbeat connection.
- cantrip_server/src/db/repository.ts:2836-2854 executes a user/session join each time. Local
  logout already eagerly revokes the hub and grouped sockets at app.ts:12699-12739.

Hypothesis: normal heartbeats and generic sweeps duplicate queries, while subscribe/control
bursts multiply them and a slow database can overlap sweeps.

Suggested change: create one single-flight coordinator keyed by owner/session, batch all due
IDs in one status query, and share results no longer than the existing interval. Explicitly
invalidate on logout/revoke and preserve the cross-instance revocation bound.

Validation: 1, 100, and 1,000 sessions with one/four sockets plus ping/subscribe bursts.
Count SQL/p95, then revoke locally and from a peer; closure latency and security decisions
must remain identical.

### N0-13 — opportunity — Add a live-message wire discriminator

- Category: REGEX_OR_PARSING_HOT_PATH, REDUNDANT_COMPUTATION
- Expected gain: high for Task streaming/history
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/app.ts:2669-2749 emits plaintext, Task-encrypted, and chat-encrypted
  live messages without an explicit wire-kind discriminator.
- cantrip_app/src/lib/app-live-query.ts:616-640 schema-parses all possibilities, attempts
  chat decryption first, catches failure, and then attempts Task decryption.
- cantrip_app/src/lib/chat-message-encryption.ts:150-177 and
  cantrip_app/src/lib/task-message-encryption.ts:104-146 reparse opaque/nested/parent data.
- cantrip_app/src/lib/api.ts:6155-6197 parses wire collections and later parses every clear
  message again.

Hypothesis: structurally compatible Task ciphertext pays a guaranteed wrong-key AES-GCM
authentication plus repeated Zod passes before the correct Task-key path succeeds.

Suggested change: publish an explicit `plaintext|chat-encrypted|task-encrypted` kind and
select exactly one opener. Use typed already-parsed summaries internally, retain an old-shape
fallback during rolling deployment, and validate clear output once.

Validation: instrument schema/decrypt counts for 100 events/pages of each kind. Target one
opaque parse, one decrypt, and one clear parse per encrypted record with identical malformed,
wrong-key, and mixed-version behavior.

### N0-14 — opportunity — Batch retained-attachment telemetry and lease heartbeats

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high with many retained attachments
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_app/src/lib/direct-transport-telemetry.ts:14-18 and 46-90 run every ten seconds,
  enumerate forwards, and issue one telemetry or lease call per attachment.
- cantrip_app/src/lib/api.ts:794-806 and 961-972 send each entry as a separate authenticated
  POST. N retained surfaces therefore produce as many as `6N` requests per minute before
  relay maintenance.

Hypothesis: retained Code, tunnel, terminal, and browser attachments create periodic
HTTP/auth/schema/database herds; eight retained views alone can produce 48 requests/minute.

Suggested change: add one authenticated batch maintenance endpoint with per-entry results
and a jittered cadence. Keep leases as durable recovery rather than replacing them with
AppLive-only liveness.

Validation: run 1, 10, and 50 attachments for ten minutes; request count should approach six
per minute rather than `6N`. Verify deltas, expiry, retry/revoke, unauthorized entries,
partial failure, offline recovery, and timeout behavior.

### N0-15 — opportunity — Batch Task dispatch eligibility and suppress no-op reason writes

- Category: ALGORITHM_COMPLEXITY, N_PLUS_ONE_OR_CHATTER
- Expected gain: high with Task backlog
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/app.ts:23733-23813 sequentially loads chat context and physical worker
  for every queued cycle, then resolves routes for every cycle by Task-worker pair.
- cantrip_server/src/db/task-dispatch.ts:413-499 reloads workers, counts, all candidates, and
  active lanes on each claim attempt. Lines 509-650 scan worker by candidate and write every
  ineligible cycle even when its reason is unchanged.
- cantrip_server/src/app.ts:23980-23999 calls `claimNext` repeatedly until no claim remains.

Hypothesis: backlog work trends toward cycles times workers, repeats full snapshots, and
writes permanent no-op eligibility reasons every second.

Suggested change: batch contexts/grants, memoize route resolution for the scheduler tick,
reuse one candidate snapshot across claims while retaining compare-and-swap fencing, and
bulk-update only eligibility codes distinct from stored values.

Validation: queued cycles 1/25/100 by Task workers 1/4/16. Measure SQL, route calls, writes,
and duration; preserve FIFO, requested-worker, continuity, encryption, and two-scheduler
fencing behavior.

### N0-16 — opportunity — Share and parallelize Run-configuration discovery and validation

- Category: N_PLUS_ONE_OR_CHATTER, REDUNDANT_COMPUTATION
- Expected gain: high for large repositories/configuration sets
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_worker/src/run-configuration-definition-service.ts:230-314 awaits Node, Java,
  Dart, Flutter, and Rust discovery sequentially when no provider is selected.
- Provider bounds in run-configuration-node-provider.ts:27-30,
  run-configuration-java-provider.ts:35-41, run-configuration-dart-provider.ts:27-33,
  run-configuration-flutter-provider.ts:31-37, and run-configuration-rust-provider.ts:31-36
  permit more than 4,500 aggregate directory visits. Dart and Flutter independently traverse
  the same manifests and sources.
- cantrip_worker/src/run-configuration-definition-service.ts:171-189 then validates as many
  as 128 ready documents strictly serially.

Hypothesis: detect-all latency is the sum of five bounded tree walks followed by the sum of
all filesystem/toolchain validation latencies.

Suggested change: use an ordered bounded mapper for providers and document validation, then
extract a bounded immutable project inventory—especially shared Dart/Flutter traversal—for
provider-specific interpretation.

Validation: compare candidates, order, diagnostics, caps, symlink exclusion, malformed-file
tolerance, and provider-failure behavior. Count directory/file reads and wall time at 1, 32,
and 128 definitions under a slow-disk fixture with a fixed concurrency bound.

### N0-17 — opportunity — Make expiration maintenance single-flight and deadline-aware

- Category: N_PLUS_ONE_OR_CHATTER, STATE_OR_CACHE_STRATEGY
- Expected gain: medium-high database relief
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/app.ts:1023-1024 and 5065-5079 run agent-interaction sweeps every second
  and workflow-gate sweeps every 500 ms without in-flight guards.
- cantrip_server/src/db/repository.ts:15977-16234 performs global expiry updates; several
  resolve/validate paths expire and then call getters that expire again, and affected chats
  are restored sequentially.
- cantrip_server/src/db/workflow-runs.ts:6611-6677 runs two scans and sequential expiry;
  cantrip_server/src/workflows/executor.ts:529-544 fully hydrates each run merely to recover
  projectId for notification.

Hypothesis: idle servers issue constant write/read probes, request paths duplicate them, and
slow sweeps overlap. Expiry bursts add sequential full-run hydration.

Suggested change: add shared single-flight, remove duplicate request-path sweeps, return
`runId/projectId` from expiry, and batch chat restoration. A nearest-known-deadline scheduler
may complement—but must not replace—a bounded durable watchdog.

Validation: ten idle minutes, 1,000 simultaneous expirations, and concurrent resolution at
the deadline. Compare SQL/writes, event-loop delay, winner semantics, restoration,
notifications, and restart recovery.

### N0-18 — opportunity — Shard AppLive replay by owner

- Category: STATE_OR_CACHE_STRATEGY, ALGORITHM_COMPLEXITY
- Expected gain: high resume reliability; medium CPU
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/live/hub.ts:189-209 stores every owner's events in one replay array and
  one aggregate event/byte budget despite owner-specific cursors.
- cantrip_server/src/live/hub.ts:422-453 appends and evicts globally. Lines 890-929 scan the
  global array for replay and first owner cursor.

Hypothesis: one noisy tenant evicts quiet tenants' resume history and forces unrelated full
resyncs; resume work scans other owners' events.

Suggested change: store a per-owner head-index replay ring with its own oldest cursor, plus
an aggregate byte cap and fair global eviction. This subsumes the server half of P1-15 while
preserving bounded memory.

Validation: owner A must be able to overflow its traffic while disconnected owner B retains
the documented replay window. Verify isolation, exact order/cursors, aggregate cap, and
resume CPU across 1,000 owners.

### N0-19 — opportunity — Pre-index workflow detail joins in the UI

- Category: ALGORITHM_COMPLEXITY
- Expected gain: medium-high on large/live workflows
- Risk: low
- Complexity: low
- Confidence: high

Evidence: cantrip_app/src/components/workflows/workflow-center.tsx:1444-1460 filters all
attempts and searches revision nodes inside every node render. packages/protocol/src/workflows.ts:2219-2226
permits 1,000 nodes and 10,000 attempts.

Hypothesis: detail rendering approaches nodes times attempts plus nodes times revision nodes
on each live update.

Suggested change: memoize `attemptsByNodeId` and `revisionNodeByKey` maps per run revision.

Validation: profile 100/1,000 nodes with 1,000/10,000 attempts; preserve exact row order,
status, selection, and control actions.

### N0-20 — opportunity — Make Code-settings polling transport-aware

- Category: N_PLUS_ONE_OR_CHATTER, STATE_OR_CACHE_STRATEGY
- Expected gain: medium fleet-wide idle reduction
- Risk: low-medium
- Complexity: medium
- Confidence: medium-high

Evidence:

- cantrip_worker/src/code-settings-sync.ts:40 and 354-363 run full synchronization every 30
  seconds; lines 457-470 and 664-787 perform HTTP plus local/state work on each pass.
- cantrip_server/src/app.ts:12141-12177 already pushes `code.settings.invalidate` revisions,
  reconnect synchronizes at cantrip_worker/src/index.ts:4690-4696, and transport keepalive
  detects failure at cantrip_worker/src/transport.ts:620-675.

Hypothesis: healthy workers repeatedly fetch and parse unchanged settings despite live
invalidation and reconnect reconciliation.

Suggested change: keep polling as durability fallback, but slow it while the command channel
is healthy and synchronize immediately on reconnect/degradation. Never remove the fallback.

Validation: count healthy idle HTTP/file work and exercise local edits, remote/dropped
invalidations, socket loss/reconnect, conflict, outage, and watcher failure. Document the
maximum missed-invalidation recovery bound.

## Revalidated carryover opportunities

### P0-02 — opportunity — Remove redundant remote-surface frame work end to end

- Category: HOT_PATH_ALLOCATION
- Expected gain: high
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_app/src/lib/use-remote-surface-transport.ts:189-192 and
  cantrip_app/src/lib/remote-surface-webrtc.ts:193-196 copy each encoded frame with
  Uint8Array.from even though the protocol encoder already returns a Uint8Array accepted by
  WebSocket and RTCDataChannel.
- cantrip_app/src/lib/remote-surface-webrtc.ts:228-242 decodes/validates an incoming frame,
  then cantrip_app/src/lib/use-remote-surface-transport.ts:436-439 decodes it again.
- cantrip_app/src/components/remote-surface/remote-surface-canvas.tsx:74-84 clones the
  payload on enqueue and 165-169 clones it again for decode. Lines 144-146 reassign canvas
  dimensions on every frame even when unchanged.
- packages/protocol/src/index.ts:6334-6400 permits frames up to 4 MiB and creates a new
  TextEncoder/TextDecoder per frame. packages/protocol/src/tunnel-data-plane.ts:193 and 229
  repeat that codec allocation pattern for tunnel frames.
- cantrip_server/src/remote-surfaces/relay.ts:83-93 encodes a frame before checking whether
  its surface and attachment match the subscriber. The bridge subscription fans worker
  frames to worker-level listeners at cantrip_server/src/workers/bridge.ts:367-381 and
  619-624.

Hypothesis: interactive 1080p frames can create tens or hundreds of MiB/s of avoidable
allocation, plus duplicate JSON parsing/schema validation and canvas backing-store churn.
Unrelated surface subscribers also encode frames they immediately discard.

Suggested change, in safe order:

1. Send the protocol encoder's Uint8Array directly and centralize browser decode/validation.
2. Establish one payload-ownership boundary, enqueue the view without cloning, avoid
   Uint8Array.from before Blob creation, and change canvas dimensions only when necessary.
3. Move server encoding after the existing surface/attachment match without changing usage
   accounting or sequence semantics.
4. Reuse module-level TextEncoder/TextDecoder instances.

Validation: replay fixed 1080p JPEG frames at 30 FPS through WebSocket and WebRTC. Compare
allocation rate, GC, main-thread time, server encode count, frame latency, and dropped
frames. Preserve malformed-frame rejection, byte identity, usage accounting, sequence
rejection, and rendered canvas snapshots.

### P0-03 — opportunity — No-op unchanged worker-encryption bootstraps

- Category: SYNC_IO_HOT_PATH
- Expected gain: high
- Risk: low
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_worker/src/index.ts:4766-4889 and 4975-4979 tie encryption refresh to the
  five-second heartbeat/bootstrap path.
- cantrip_worker/src/worker-encryption.ts:495-515 and 645-755 unwrap grants and export key
  material.
- cantrip_worker/src/worker-encryption.ts:771-800 persists the refreshed identity, while
  247-255 uses synchronous write/chmod behavior.

Hypothesis: a healthy idle worker performs 12 crypto-and-disk refreshes per minute even when
the server identity and every component revision are unchanged. Synchronous persistence
also blocks the worker event loop.

Suggested change: preserve the five-second security refresh cadence, but compare server and
owner identity plus component revision sets before unwrap/export/persist. Treat unchanged
revisions as a successful freshness update. A later protocol improvement may use an
ETag/revision token to avoid the unchanged POST.

Validation: count bootstrap requests, unwraps, record writes, and event-loop delay over ten
idle minutes. After initial bootstrap, unchanged unwrap/write counts should be zero. Rotate
and revoke every component key and verify installation remains within the existing refresh
bound.

### P0-04 — opportunity — Replace full AppLive authorization hydration with batched ownership checks

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high
- Risk: low
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/live/hub.ts:700-732 and 750-805 authorize each subscribe/resync scope,
  up to 128 scopes.
- cantrip_server/src/app.ts:4366-4384 authorizes projects via listProjects(...).some, chats
  via full getChatExecutionContext, and workflows via full getRun.
- cantrip_server/src/db/repository.ts:7983-8064 shows project listing also loading
  replica/source/worktree data; 15557-15636 shows chat context loading settings, worktree,
  runtime, and lane state.
- cantrip_server/src/db/workflow-runs.ts:996-1069 shows getRun plus six detail queries.
- cantrip_server/src/db/index.ts:229-234 caps the PostgreSQL pool at five connections.

Hypothesis: reconnecting with many scopes can issue hundreds of queries and allocate
resource graphs unused by authorization, delaying the live path and unrelated requests.

Suggested change: group requested IDs by project/chat/workflow and authorize with at most
three ownership/existence IN queries, preserving owner, archival, and lifecycle predicates.

Validation: assert identical decisions and count SQL plus subscribe/resync p50/p95 at 1, 16,
and 128 scopes against large fixtures.

### P0-06 — opportunity — Collapse worker-management 1+2N queries

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high
- Risk: low
- Complexity: low
- Confidence: high

Current evidence:

- cantrip_server/src/db/repository.ts:6916-6972 still loads workers, then issues two queries
  per worker for credentials and source/project assignments.
- cantrip_server/src/app.ts:14773, 14821, and 14851 still load the complete management list
  and `.find` one worker for restart, rename, and delete.
- cantrip_server/src/db/index.ts:229-234 caps the pool at five connections.

Hypothesis: fleet listing and even single-worker mutation latency grow linearly with fleet
size and can monopolize the database pool.

Reconciliation note: the earlier fixed marker was a status-only documentation change. No
corresponding implementation exists on the current baseline, so this is restored to the
pending inventory.

Suggested change: use one workers query, one credential aggregate grouped by worker ID, and
one source/project query for all IDs; group in memory. Add a focused single-worker loader
for mutations.

Validation: require three constant list queries and one focused mutation lookup, with exact
response parity and p95 measurements at 1, 10, 100, and 1,000 workers.

### P0-07 — opportunity — Coalesce worktree observation across server and worker

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_server/src/app.ts:1931-1962 calls getActiveGitOperation per observed target, and
  cantrip_server/src/db/repository.ts:9636-9665 executes one query per call.
- cantrip_server/src/app.ts:1974-1990 clears the debounce marker before asynchronous
  configuration finishes, allowing overlapping runs during mutation bursts.
- cantrip_worker/src/worktrees.ts:38, 385-390, and 527-550 launch git rev-parse HEAD every
  two seconds for every target—30 child processes per minute per idle worktree.
- cantrip_worker/src/worktrees.ts:418-505 installs per-target watchers for both worktree and
  common Git directories; multiple worktrees therefore duplicate the common .git watcher.
- cantrip_worker/src/worktrees.ts:606-629 schedules full status work after those events.

Hypothesis: one source with many worktrees multiplies database calls, Git subprocesses,
watchers, and refreshes; bursts may also apply overlapping or briefly stale configuration.

Suggested change:

1. Batch active-operation state for all server targets and use one in-flight promise plus a
   latest-state rerun flag per worker.
2. Reference-count one common-Git-directory watcher per source and fan out coalesced events.
3. Replace per-target two-second HEAD probes with one git worktree list --porcelain per
   source, or run the fast probe only when a watcher is degraded while retaining the
   existing slower reconciliation fallback.

Validation: use 1, 5, 20, and 128 worktrees plus a 100-mutation burst. Count SQL, worker
configuration commands, watchers, and Git children. Simulate watcher failure and branch
changes; the final applied state and recovery bound must remain unchanged.

### P0-08 — opportunity — Collapse redundant Git status subprocesses

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_worker/src/git.ts:1700-1731 and 1759-1783 show readGitStatus starting five Git
  commands in parallel and a sixth for ahead/behind.
- The for-each-ref output already includes current marker, branch, object hash, and upstream,
  duplicating branch/HEAD/upstream commands for normal attached branches.
- cantrip_worker/src/worktrees.ts:606-643 reads Git status during managed-operation
  observation, then cantrip_worker/src/git.ts:6087-6094 and 6123-6135 cause
  listGitConflicts to read the full status again.

Hypothesis: common status refreshes pay for redundant child processes, while merges/rebases
pay for the whole pipeline twice.

Suggested change: derive attached branch, HEAD, and upstream from ref records, retaining
narrow detached/unborn fallbacks. Let conflict grouping consume the already-fresh GitStatus
or expose an index-only conflict helper.

Validation: golden-compare results and invocation counts for attached with/without upstream,
detached, unborn, dirty, renamed, many-ref, merge, rebase, cherry-pick, and revert cases.

### P0-10 — opportunity — Make live chat overlay merging incremental

- Category: ALGORITHM_COMPLEXITY
- Expected gain: high
- Risk: medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_app/src/lib/chat-message-history.ts:3-5 permits 10,000 messages.
- Lines 57-65 copy the whole overlay on each upsert; 81-109 rebuild a Map from all pages,
  clone/reverse arrays, scan values, fully sort, and slice.
- cantrip_app/src/lib/use-chat-message-history.ts:71-78 reruns this merge whenever the live
  overlay changes.
- cantrip_app/src/lib/app-live-query.ts:587-668 continuously decrypts/upserts message events,
  followed by downstream projection at cantrip_app/src/App.tsx:1808-1818.

Hypothesis: repeated streaming updates to the same message pay O(N log N) history work and
several full-sized allocations per event.

Suggested change: cache an indexed immutable base until pages change, use a linear ordered
merge as the safe first step, incrementally apply live upserts/deletes, and prune overlay
records once refreshed pages contain them.

Validation: compare exact output for 10k base messages plus 1k same-ID, new-ID, deletion,
and out-of-order events, including AppLive replay and resync.

### P0-13 — opportunity — Add capped jittered backoff to worker reconnects and crashing services

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high during outage/failure
- Risk: low
- Complexity: low
- Confidence: high

Evidence:

- cantrip_worker/src/transport.ts:49-52 and 400-417 reconnect the command channel at a fixed
  one-second interval.
- cantrip_worker/src/terminal-manager.ts:189-204, 601-692, and 716-728 restart a broken
  service every five seconds forever. restartCount does not change delay or reset.

Hypothesis: a server outage synchronizes worker connection attempts; one broken service can
spawn 720 times per hour plus PTY/log churn.

Suggested change: share a capped exponential-backoff-with-full-jitter primitive. Reset the
transport after ready and services after a stable-uptime window. Preserve terminal auth
rejection and immediate explicit/manual service restart.

Validation: fake-timer growth/cap/reset/auth-stop tests; distribute attempts from 100 workers
during an outage; crash a fake service ten times, recover stably, disable it, and issue a
manual restart.

### P0-14 — opportunity — Make worker shutdown failure-tolerant and dependency-parallel

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: high reliability; medium normal shutdown latency
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence:

- cantrip_worker/src/index.ts:4896-4963 awaits independent shutdown stages sequentially.
- One rejection prevents later cleanup, archive closure, and resolveShutdown.
- cantrip_worker/src/mcp/broker.ts:590-603 includes a close path that can wait on a server
  close.

Hypothesis: a rejected or hanging subsystem close can wedge a requested restart and leave
children, ports, or listeners alive.

Suggested change: stop intake/timers first, then close independent subsystems in
dependency-aware Promise.allSettled groups with bounded timeouts. Put archive closure and
resolveShutdown in an outer finally and log each failure.

Validation: inject one rejection and hang at every close stage. All other cleanup must run,
the outcome must resolve within a bound, and no child/port/listener may leak.

## P1: strong follow-on opportunities

### P1-01 — opportunity — Serialize multi-instance coordination messages once

- Category: REDUNDANT_COMPUTATION
- Expected gain: high in multi-instance deployments
- Risk: low
- Complexity: low
- Confidence: high

Evidence: cantrip_server/src/coordination/relay-coordinator.ts:194-216 stringifies each
message to measure bytes, then 725-728 stringifies it again for Redis. Remote frame messages
contain base64 payloads at cantrip_server/src/workers/coordinated-bridge.ts:937-956.

Suggested change: create the serialized string once, enforce the byte limit on it, and pass
it to the Redis backend while retaining the object for the in-memory backend.

Validation: assert byte-identical Redis payload and oversize rejection; benchmark 64 KiB and
1 MiB messages for CPU, allocation, and throughput.

### P1-02 — opportunity — Make worker-presence refresh single-flight and bounded-concurrent

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high for larger fleets or delayed Redis
- Risk: low
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/workers/coordinated-bridge.ts:114-125 starts async interval
refreshes without an in-flight guard; 1040-1102 handles observed workers sequentially.
cantrip_server/src/coordination/relay-coordinator.ts:560-601 performs GET, parse, EVAL, and
publish per worker, while startup scans then GETs sequentially at 480-495.

Suggested change: add single-flight first, then bounded concurrency or pipelining while
preserving generation/fencing. Batch startup GETs by scan page.

Validation: test 1, 50, and 500 workers with Redis latency; require at most one sweep,
unexpired live presence, and lower commands/tick and p95 duration.

### P1-03 — opportunity — Remove workflow recovery's per-attempt full run hydration

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high during restart/recovery
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_server/src/db/workflow-runs.ts:5573-5629 selects up to 500 stale attempts;
5631-5655 sequentially calls full getRun plus a revision lookup for each. getRun fans into
six detail collections at 996-1069.

Suggested change: memoize run hydration per owner/run inside a sweep and batch revision-node
lookup. Follow with a recovery-specific projection only if measurement warrants it.

Validation: compare SQL count and outcomes for 1, 50, and 500 attempts, including many
sharing one run; preserve ordering and interruption semantics.

### P1-04 — opportunity — Single-flight and briefly cache project statistics

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: high on large repositories
- Risk: low-medium
- Complexity: medium
- Confidence: medium-high

Evidence: cantrip_worker/src/project-repository-stats.ts:12-16 and 37-95 allow scanning
50,000 files and reading 256 MiB. cantrip_worker/src/project-folder-stats.ts:34-42 and
132-286 perform a similarly bounded tree walk. The UI has only a 30-second freshness window
at cantrip_app/src/App.tsx:4682-4699, and broad invalidation passes through
cantrip_app/src/lib/app-live-query.ts:418-439.

Suggested change: add per-canonical-root single-flight and a roughly 30-second bounded
worker cache, invalidated/coalesced by relevant filesystem and Git changes.

Validation: 100 concurrent requests must cause one scan; frequent project events must cause
no more than one scan per freshness window; mutations must appear within the documented
bound.

### P1-05 — opportunity — Reuse Explorer directory listings for commit metadata

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium-high
- Risk: low
- Complexity: low
- Confidence: high

Evidence: cantrip_app/src/components/explorer/use-explorer-directory.ts:29-55 requests the
directory before commits. cantrip_worker/src/explorer.ts:183-243 lists and stats up to 1,000
entries; 442-467 lists the same directory again for commit metadata.

Suggested change: share a short-lived, mutation-invalidated single-flight listing keyed by
canonical root/path, and run listing plus HEAD-availability probe concurrently.

Validation: simultaneous list/commit requests on a delayed 1,000-entry fixture should
perform one listing with identical symlink containment and fresh post-mutation results.

### P1-06 — opportunity — Avoid root application rerenders during sidebar pointer movement

- Category: REDUNDANT_COMPUTATION
- Expected gain: high during resize
- Risk: low
- Complexity: low
- Confidence: high

Evidence: cantrip_app/src/App.tsx:3849 owns sidebar state in the root; 4045-4047 stores
width in React state; 6760-6764 updates it; 6792-6797 invokes that update on every pointer
move. The value is principally consumed by layout styles at 8138 and 8165.

Suggested change: update a CSS custom property or element style through a ref, coalesced by
requestAnimationFrame, then commit/persist React state once on pointer-up/cancel. Keep the
React path for keyboard resize.

Validation: profile a two-second drag for root commit count, long tasks, and FPS; verify
cancel, keyboard, min/max, and persisted width.

### P1-07 — opportunity — Parse and search CSV data once per content revision

- Category: REGEX_OR_PARSING_HOT_PATH
- Expected gain: medium
- Risk: low
- Complexity: low-medium
- Confidence: high

Evidence: cantrip_app/src/components/explorer/tabular-file-visual.tsx:164-186 parses and
filters in CsvVisual, while 502-526 parses and searches the same content again in the
parent; 567-573 still passes raw content/query down, and 230-250 mounts all matching cells.

Suggested change: parse once, normalize search once, pass the parsed document and matching
row indexes/count to the child, and use deferred input. Add content-visibility or
fixed-height virtualization if the one-pass profile still shows DOM cost.

Validation: a 10k-by-20 CSV should invoke the parser once per revision while typing; preserve
editing, counts, and saved output.

### P1-08 — opportunity — Share chat-anchor layout measurements

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_app/src/components/chat/chat-history-rail.tsx:224-295 scans, measures, and
sorts all anchors with its own observer.
cantrip_app/src/components/chat/chat-turn-prompt-overlay.tsx:94-171 repeats the geometry
pass and observer; 38-51 linearly scans anchors on scroll. Both mount around
cantrip_app/src/App.tsx:2793-2805 and 3117.

Suggested change: first use binary search in the overlay, then expose one frame-coalesced
anchor-layout store/hook for both widgets.

Validation: on 1,000 turns, instrument querySelectorAll/getBoundingClientRect during
streaming and scrolling; expect one measurement pass and logarithmic active lookup with
unchanged jumps and overlay position.

### P1-09 — opportunity — Bound deeply paged Git-history DOM

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: medium
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_app/src/lib/api.ts:2545-2556 fetches 100 commits per page;
cantrip_app/src/components/git/git-history.tsx:680-697 flattens all pages, 808-821
auto-fetches at an intersection sentinel, and 1187-1477 keeps every fixed-height SVG-heavy
row mounted.

Suggested change: start with content-visibility: auto and a 32px intrinsic size. If
profiling warrants it, window rows with spacers while retaining query data and the sentinel.

Validation: load 5,000 commits and compare DOM, heap, scroll FPS, and update time; preserve
menus, drawer selection, focus, WIP/worktree rows, and pagination.

### P1-10 — opportunity — Split the authenticated application shell into smaller startup chunks

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: medium-high cold startup
- Risk: low-medium
- Complexity: medium
- Confidence: medium-high

Evidence: cantrip_app/src/main.tsx:111-123 delays ApplicationSession until server
initialization, but cantrip_app/src/components/auth/application-session.tsx statically
imports the router, and cantrip_app/src/router.tsx:8 and 15 statically import/mount the large
App shell. Only some heavy surfaces are lazy inside cantrip_app/src/App.tsx:594-619.

Suggested change: keep the unauthenticated/session gate independent of App, then lazy-load
the authenticated shell. Split settings, Git history, project administration, and other
rare routes/panels at stable feature boundaries.

Validation: use the bundler report and cold-cache browser traces for initial transferred/
parsed JS, sign-in first paint, authenticated shell TTI, and route-transition regressions.

### P1-11 — opportunity — Narrow always-on native-tooltip DOM observation

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium during DOM-heavy streaming
- Risk: low-medium
- Complexity: low
- Confidence: medium-high

Evidence: cantrip_app/src/main.tsx:19-25 installs suppression at process startup.
cantrip_app/src/lib/native-tooltip-suppression.ts:1-7 observes title attributes,
characterData, childList, and the entire document subtree; 22-30 scans added subtrees;
41-60 handles every mutation; 64-72 also walks hovered ancestors.

Suggested change: remove characterData observation, restrict work to added elements and
title mutations, and move SVG-title suppression into shared icon/component boundaries
where practical.

Validation: count mutation records, scans, and callback time during a long streamed chat and
log burst, then exercise native-title suppression for dynamic icons and hovered ancestors.

### P1-12 — opportunity — Batch client log persistence across native bridges

- Category: SYNC_IO_HOT_PATH
- Expected gain: high on mobile; medium on desktop
- Risk: low-medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_app/src/lib/client-log-relay.ts:117-133 invokes the Tauri relay per
deliberate record and 175-187 persists every captured console call on mobile.
cantrip_app/src/lib/mobile-log-archive.ts:225-229 appends each record, while 104-109 crosses
Capacitor Filesystem.appendFile with base64 data. packages/logging/src/archive.ts:168-190
persists every append.

Suggested change: batch records by bytes and a short time bound, preserving order. Flush on
fatal/error, export, visibility/lifecycle transitions, and shutdown.

Validation: compare native bridge/filesystem operations during a 10k-log burst; verify
ordering, rotation, crash/fatal flush, backgrounding, export, and bounded-loss behavior.

### P1-13 — opportunity — Bound idle Codex app-server runtimes

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: high in long configuration-switching sessions
- Risk: medium
- Complexity: medium
- Confidence: high

Evidence: runtime keys and storage live at cantrip_worker/src/index.ts:829-830 and
1262-1349. cantrip_worker/src/codex/app-server.ts:2180-2215 and 6490-6558 show retained
runtime/process state. Unique model catalog/provider/account/API-key/subagent configurations
remain until account close or worker shutdown.

Suggested change: track last use plus a safe-idle predicate covering turns, RPCs, and
interactions. Apply TTL/LRU limits, shorter for catalog-only runtimes, and never evict busy
instances.

Validation: cycle 50 configurations and assert bounded process/RSS counts; active turns must
survive and durable threads must resume after recreation.

### P1-14 — opportunity — Parallelize proven-independent worker startup probes

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium-high cold startup
- Risk: medium
- Complexity: medium
- Confidence: high

Evidence: cantrip_worker/src/index.ts:523-584, 609-655, and 4960-4963 serialize Codex,
CodeGraph, desktop, Code discovery/supervisor, direct broker, and encryption preparation
before heartbeat/command readiness.

Suggested change: add phase timing, prove dependency boundaries, then parallelize only
independent discovery/preparation groups and join before dependents or environment
publication.

Validation: compare startup on healthy, permission-denied, and missing-optional-runtime
hosts; fault-inject every probe and preserve fail-fast/degraded semantics and ordering.

### P1-15 — opportunity — Replace hot Array.shift queues with O(1) deques

- Category: ALGORITHM_COMPLEXITY
- Expected gain: medium during bursts/reconnect
- Risk: low
- Complexity: low
- Confidence: high

Evidence: cantrip_worker/src/transport.ts:726-828 uses Array.shift for an 8 MiB command
queue and recomputes byte lengths. N0-18 replaces the former server-side replay-array half
with an owner-sharded head-index ring.

Suggested change: standardize a tested head-index deque/ring holding precomputed byte sizes,
with occasional compaction.

Validation: benchmark 100k publications and 10k small queued envelopes; preserve exact replay
order/cursors, byte limits, drops, flush order, and backpressure tests.

### P1-16 — opportunity — Guard periodic recovery and back off replica completion reads

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: medium; high during datastore stalls
- Risk: low
- Complexity: low
- Confidence: high

Evidence: unguarded asynchronous 30-second sweeps exist at
cantrip_server/src/chat-imports/executor.ts:152-167,
cantrip_server/src/project-replicas/executor.ts:56-71,
cantrip_server/src/chat-relocations/executor.ts:157-172,
cantrip_server/src/project-folders/executor.ts:51-66, and
cantrip_server/src/project-github-conversions/executor.ts:53-68. The guarded pattern already
exists at cantrip_server/src/workflows/executor.ts:164-190.
cantrip_server/src/chat-relocations/executor.ts:669-685 polls replica completion every
250 ms for up to five minutes—about 1,200 reads for one slow job.

Suggested change: extract a guarded interval runner that skips while in flight. For replica
completion, keep fast initial checks then exponentially back off with jitter to 2-5 seconds,
retaining polling as the durable fallback.

Validation: fake timers must show maximum concurrency one and later recovery after
settlement. Compare completion detection and query counts for 1-second, 30-second, and
five-minute jobs.

### P1-17 — opportunity — Suppress demonstrably redundant post-create list refreshes

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: medium
- Risk: low-medium
- Complexity: medium
- Confidence: medium

Evidence: successful create flows set authoritative cache and immediately invalidate the
same resource for chats at cantrip_app/src/App.tsx:4754-4770, terminals at 4839-4860,
Explorer at 4940-4951 and 5015-5025, and browser/code/project views at 5159-5233. AppLive may
then add another invalidation.

Suggested change: network-trace first. Where the response is complete, patch list/layout
cache and suppress only the initiator's same-resource refresh. Retain refresh for degraded
transport, incomplete responses, and uncertain ordering.

Validation: count POST/GET/AppLive traffic while live and degraded; test concurrent clients,
replay/resync, ordering, and flicker.

### P1-18 — opportunity — Coalesce duplicate browser screenshot captures

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium during navigation
- Risk: low
- Complexity: low
- Confidence: medium-high

Evidence: cantrip_worker/src/browser/browser-adapter.ts:478-493 has no in-flight capture
coalescing, while 630-641 triggers full Page.captureScreenshot from both
frameStoppedLoading and loadEventFired despite continuous screencast.

Suggested change: share an in-flight manual capture and debounce adjacent lifecycle
captures, retaining explicit first-attachment capture.

Validation: count CDP screenshot commands on redirect-heavy navigation and preserve one
bounded final still, screencast delivery, and attachment behavior.

### P1-19 — opportunity — Index direct tunnel sessions and share socket backpressure waiters

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium in tunnel-heavy workloads
- Risk: medium
- Complexity: medium
- Confidence: medium

Evidence: cantrip_worker/src/direct-broker.ts:327-339 allocates an array and linearly scans
all active sessions for every return frame; 413-420 repeats a scan then polls bufferedAmount
every 5 ms. cantrip_worker/src/tunnel-tcp-adapter.ts:56-68 creates safe subarray views, but
327-342 copies every view before cantrip_worker/src/transport.ts:853-867 encodes it again;
lines 345-383 also create per-stream backpressure polling.

Suggested change: maintain synchronized attachment/route/connection indexes. Share one
low-water waiter/timer per WebSocket or use adaptive polling; do not assume unsupported
WebSocket drain events.

Validation: route frames through 1, 10, and 128 active sessions and drain congestion with
1, 10, and 50 streams. Preserve routing, close/error semantics, fairness, and throughput
while measuring allocations, timer wakeups, and CPU.

### P1-20 — opportunity — Avoid duplicate relay-quota serialization

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium on hosted relays
- Risk: low-medium
- Complexity: medium
- Confidence: medium

Evidence: cantrip_server/src/workers/limited-command-bus.ts:31-36 JSON-serializes for byte
measurement, called for commands at 153-165, events at 204-220, and results at 224-239.
The delegate later encodes the worker envelope at cantrip_server/src/workers/bridge.ts:681-686
through the protocol encoder.

Suggested change: carry encoded bytes/length through the limiter and bridge, or expose a
single protocol serialization result used for both quota and transmission. Preserve exact
quota accounting.

Validation: assert quota boundaries and transmitted bytes, then compare CPU/allocation for
large commands and high-frequency streamed events.

## P2: measure before changing architecture

### P2-01 — opportunity — Add worker-leading database indexes only after EXPLAIN

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: medium if fleet tables are large
- Risk: low
- Complexity: low
- Confidence: medium

Evidence: worker management filters at cantrip_server/src/db/repository.ts:6811-6822 lack a
matching owner-leading index in cantrip_server/src/db/schema.ts:1123-1186. Observation
filters at cantrip_server/src/db/repository.ts:9373-9445 are not matched by worker-leading
indexes at cantrip_server/src/db/schema.ts:1980-1990. Source assignment filters worker ID at
cantrip_server/src/db/repository.ts:6868-6887 while
cantrip_server/src/db/schema.ts:1922-1924 is project-first.

Suggested change: do not add a migration yet. Evaluate owner/worker-leading partial or
compound indexes against production-shaped data.

Validation: run EXPLAIN (ANALYZE, BUFFERS) for the current and candidate plans. Retain only
indexes that materially reduce reads without unacceptable write amplification.

### P2-02 — opportunity — Instrument command admission before adding concurrency limits

- Category: STATE_OR_CACHE_STRATEGY
- Expected gain: potentially high under bursts
- Risk: medium
- Complexity: high
- Confidence: medium

Evidence: cantrip_worker/src/transport.ts:313-316 and 900-938 start asynchronous command
handlers independently. Bursts can launch Git, filesystem, and child-process work without a
transport-level bound, although some subsystems already serialize internally.

Suggested change: instrument in-flight work by command family first. If saturation is
confirmed, add per-resource single-flight and a bounded priority queue only for heavy reads;
never block interactive turns, frames, or control traffic behind bulk scans.

Validation: replay production-shaped invalidation/request bursts and record in-flight work,
child processes, RSS, and interactive p95 before choosing limits. Re-run the same trace after
any admission policy and require lower resource peaks without worse interactive latency.

### P2-03 — opportunity — Measure Redis bulk-frame cost before replacing the data plane

- Category: HOT_PATH_ALLOCATION
- Expected gain: potentially high
- Risk: high
- Complexity: high
- Confidence: medium

Evidence: cantrip_server/src/workers/coordinated-bridge.ts:937-956 base64-encodes surface
and tunnel payloads into JSON coordination messages.
cantrip_server/src/coordination/relay-coordinator.ts:725-728 publishes JSON strings and
470-478 parses them on receipt.

Suggested change: instrument before redesigning. If the bulk path dominates, keep Redis for
ownership/presence/control and design a direct binary instance relay. This is explicitly not
a first-pass “switch to WebSocket” task.

Validation: record frame-size distributions, throughput, Redis egress, allocation, and
encode/decode CPU under representative local and multi-instance remote-surface/tunnel loads.
Require evidence that transport work, rather than the endpoints, dominates.

### P2-04 — opportunity — Narrow Elite-mode global DOM effects only if profiles justify it

- Category: REDUNDANT_COMPUTATION
- Expected gain: medium when enabled
- Risk: medium
- Complexity: medium
- Confidence: low-medium

Evidence: cantrip_app/src/components/elite/elite-global-effects.tsx:17-52 contains broad
selectors; 128-147 scans added subtrees; 222-293 performs geometry, sorting, computed-style,
and timer work; 295-338 drives it from a document-wide observer.

Suggested change: only if the profile is material, observe explicit boundaries, batch once
per frame, reject hidden subtrees early, and cap timers.

Validation: compare mutation time, candidates, timers, long tasks, and visual output during
chat streaming/log viewing with Elite mode on/off and after the narrowed observer.

## Shared primitives that reduce duplication safely

Several opportunities become smaller and more reliable if implemented as narrow internal
primitives rather than one-off fixes:

- Guarded interval runner: one in-flight execution, optional latest-state rerun, stop/unref
  semantics, and testable fake-clock behavior. Use for server recovery and presence sweeps.
- Capped jittered backoff: reset predicate, stable-uptime reset, terminal-error predicate,
  and injectable clock/randomness. Use for worker transport and terminal services.
- Head-index byte deque: O(1) push/evict/read, exact byte accounting, ordered iteration, and
  occasional compaction. Use for AppLive replay and worker command envelopes.
- Keyed single-flight with bounded TTL: explicit invalidation and maximum entry/byte limits.
  Use for repository stats and Explorer listings; do not introduce unbounded caches.
- Ordered bounded mapper: concurrency cap plus deterministic result order. Use for snapshot
  lstat and presence/startup batches.
- Remote-frame ownership contract: define where a received byte view becomes immutable and
  where a copy is required. Use it for remote surfaces, Browser Code, attachments, and TCP
  tunnel framing.
- Watcher-aware reconciler: fast event-driven refresh while healthy, slower integrity sweep,
  degraded fast retry, and a single latest-dirty rerun. Use for Run configurations,
  worktrees, and Code settings without weakening durable recovery.
- Coalesced durable writer: immediate in-memory value, bounded trailing persistence, and
  explicit lifecycle flush. Use for AppLive cursors; never hide whether persisted state may
  lag.
- Bounded stream accumulator: immutable chunks, incremental byte accounting, O(1) head
  trimming, and materialization only at delivery boundaries. Use for Codex command and
  Browser Code byte streams.
- Batch result envelope: one authenticated request with per-entry success/failure and stable
  ordering. Use for attachment leases, protected routing metadata, and catalog refresh.

These are code-sharing opportunities, not a recommendation to build a generic framework.
Each primitive should stay small, locally testable, and tied to the listed callers.

## Recommended delivery sequence

### Wave 0 — add proof harnesses

Before behavior changes, add or reuse focused counters and deterministic fixtures:

- delayed-filesystem counters for Run-configuration repository scans, provider discovery,
  validation, attachment ranges, Explorer, and repository statistics;
- byte-copy/allocation traces for Browser Code, remote surfaces, TCP tunnels, and Codex
  one-byte/realistic streaming deltas;
- SQL/request counters for Task scheduler states/backlogs, Project Task workloads, AppLive
  scopes/sessions/replay owners, project hydration, worker fleets, and attachment counts;
- React render/projection/storage spies for closed Inspect, disabled provider catalogs,
  AppLive status consumers, workflow details, and 10,000 cursor advances;
- child-process counters for idle worktrees and Git status plus fake clocks for reconnect,
  restart, expiration, guarded recovery, watcher degradation, and lifecycle cursor flush.

### Wave 1 — local and mechanically verifiable

Implement N0-01, N0-04 through N0-06, N0-09, N0-19, P0-08, P0-13, P1-01, P1-06, P1-07,
P1-15, P1-16, and P1-18. These gate work that is provably invisible/impossible, add bounded
coalescing, or replace an equivalent data structure.

### Wave 2 — bounded batching, memoization, and ownership

Implement N0-02, N0-03, N0-07, N0-08, N0-10 through N0-18, P0-02 through P0-04, P0-06,
P0-07, P0-10, P0-14, P1-02 through P1-05, P1-08 through P1-13, and P1-17. Land each behind
equivalence, ownership, security, and bounded cache/queue tests.

### Wave 3 — conditional tuning

Use Wave 0/1 telemetry to decide N0-20, P1-14, P1-19, P1-20, and all P2 items. Avoid
architectural transport, eviction, or admission-control work without production evidence.

## Success metrics

Track the following before and after each wave:

| Surface                     | Primary metric                                   | Guardrail                                          |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Run configurations          | file reads/parses/minute and detect/list p95     | watcher-loss integrity recovery                    |
| Task scheduler/workload     | SQL, route calls, writes/tick and dashboard p95  | FIFO, fencing, eligibility, durable recovery       |
| Chat typing/Inspect         | React commits, projections, hidden DOM rows      | exact open-state and live-message behavior         |
| Provider catalog            | storage reads, parsed bytes, schema calls/render | expiry/corruption/scope isolation                  |
| Browser Code/remote surface | copied bytes, allocation, GC, frame/stream p95   | byte-identical framing, sequence, credits, usage   |
| AppLive event/replay        | storage writes, callbacks, SQL, replay scan p95  | cursor, owner isolation, auth/revocation parity    |
| Project/worker lists        | HTTP, worker commands, SQL and p95 by list size  | exact protected metadata/fail-closed projection    |
| Attachments                 | requests, handles, bytes read, RSS, throughput   | digest, lease, EOF, abort, platform parity         |
| Codex streaming             | allocations, payload scans, event-loop delay     | diagnostics, UTF-8, truncation, ordering parity    |
| Idle worktrees/workers      | Git children, watchers, crypto/disk work/minute  | watcher failure and key rotation/revocation bounds |
| Failure/shutdown            | attempt distribution, completion bound, leaks    | manual immediacy; every cleanup attempted          |
| Database recovery           | statements, writes, duration, pool occupancy     | exact job/run/expiry outcomes                      |

The expected end state is not merely lower benchmark numbers: long chats should type like
short chats, remote surfaces should remain smooth under sustained frames, idle projects
should stop doing visible background work, fleet growth should not consume the database
pool, and degraded services should recover without creating their own load spike.
