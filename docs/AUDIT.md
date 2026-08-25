# Cantrip performance and reliability audit

- Date: 2026-08-24
- Baseline: origin/main at 02d39bb6898a498a0dd30121af1758a6b1c2bfb5
- Status: inspection complete; implementation fixes are tracked inline

## Executive result

Cantrip already has the right high-level live architecture. AppLive eliminates repeating
project-resource HTTP requests while healthy, the worker owns local filesystem and process
observation, and bounded recovery polling remains available when a live path is degraded.
The largest safe gains are therefore not another transport rewrite. They are the repeated
work surrounding the live paths:

- historical chat and root application trees reconcile for local UI changes that should be
  isolated;
- remote-surface frames are copied, decoded, validated, and encoded more than once;
- common server reads hydrate entire resources or issue per-resource queries when they need
  only ownership or preference fields;
- healthy workers repeat Git subprocesses, cryptography, and filesystem writes when nothing
  changed;
- several recovery/reconnect/service loops lack single-flight guards or bounded jittered
  backoff;
- bounded buffers use full sorting, rebuilding, or Array.shift eviction in their hot paths.

P0-05, P0-06, P0-09, and P0-12 have since been fixed and are retained below as completed
historical context. The first implementation wave should target the remaining P0 items.
They are source-evident, high-upside, and can be validated without changing product
semantics. P1 items should follow with focused benchmarks. P2 items require
production-shaped measurement before design work.

| Rank | Opportunity                                                  | Expected gain       | Risk       | Why it should move first                                                  |
| ---- | ------------------------------------------------------------ | ------------------- | ---------- | ------------------------------------------------------------------------- |
| 1    | P0-01 isolate chat composer and memoize transcript rows      | high                | low        | directly improves every keystroke in long chats                           |
| 2    | P0-02 remove redundant remote-frame work end to end          | high                | low-medium | removes frame-sized copies and repeated validation at interactive rates   |
| 3    | P0-03 no-op unchanged encryption bootstraps                  | high                | low        | removes synchronous disk and crypto work every five seconds               |
| 4    | P0-04 batch narrow AppLive authorization                     | high                | low        | turns reconnect hydration from potentially hundreds of queries into a few |
| 5    | P0-05 [fixed] use focused settings loaders                   | fixed               | —          | preference decisions now use one history-independent query                |
| 6    | P0-06 [fixed] collapse worker-management 1+2N queries        | fixed               | —          | reported fixed after the audit; retained for traceability                 |
| 7    | P0-07 coalesce worktree observation across server and worker | high                | low-medium | removes per-target DB calls, Git probes, duplicate watchers, and overlap  |
| 8    | P0-08 collapse redundant Git status pipelines                | high                | low-medium | removes several child processes from common status/operation refreshes    |
| 9    | P0-09 [resolved] incremental log ingestion and lazy export   | resolved            | —          | equivalent 10k-buffer benchmarks improved ordered and mixed batches       |
| 10   | P0-10 make live chat overlay merging incremental             | high                | medium     | avoids O(N log N) history rebuilds on streamed message updates            |
| 11   | P0-11 parallelize bounded workspace snapshot metadata reads  | high                | low        | removes one filesystem round trip per changed path from turn boundaries   |
| 12   | P0-12 [resolved] skip proven no-op CodeGraph syncs           | resolved            | —          | clean reconciliation now performs status only                             |
| 13   | P0-13 add capped jittered reconnect and crash backoff        | high during failure | low        | prevents worker herds and endless five-second service crash loops         |
| 14   | P0-14 make worker shutdown failure-tolerant                  | high reliability    | low-medium | prevents one failed close from wedging restart and later cleanup          |

## Scope and method

The audit inspected cantrip_app, cantrip_server, cantrip_worker, packages/protocol, and their
cross-layer call paths. It deliberately did not spend time inside cantrip_code,
cantrip_codex, or cantrip_site. Generated and vendored candidates were discarded.

Three independent source passes covered UI/rendering, server/netcode/database behavior, and
worker/service management. A fourth cross-layer pass followed remote-surface, tunnel,
logging, project-statistics, AppLive, and command paths across packages. Automated static
scouting was used only to locate candidates; each retained finding below was manually
re-read at the cited source lines.

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

## P0: high-upside candidates and completed work

### P0-01 — opportunity — Isolate composer updates from the full chat transcript

- Category: REDUNDANT_COMPUTATION
- Expected gain: high
- Risk: low
- Complexity: low-medium
- Confidence: high

Evidence:

- cantrip_app/src/App.tsx:1245 and 1322-1377 keep transcript, composer draft, caret,
  attachment, scroll, and other UI state in ChatTranscript.
- cantrip_app/src/App.tsx:2836-3030 maps and renders every transcript entry.
- cantrip_app/src/App.tsx:3539-3573 updates transcript-level state on textarea keystrokes
  and scrolling.
- cantrip_app/src/App.tsx:646-700 and
  cantrip_app/src/components/chat/markdown.tsx:29-52 show non-memoized message/Markdown
  rendering and recreated Markdown configuration.

Hypothesis: a composer keystroke or textarea scroll can reconcile historical messages and
re-enter Markdown components. The cost grows with conversation length and is paid on the
IDE's most frequent interaction.

Suggested change: extract the composer into a state-owning child. Extract immutable
transcript rows, MessageContent, and Markdown into memoized components; hoist stable plugin
and component tables; keep only the active streaming row mutable.

Validation: React Profiler on a 500-message chat while typing 100 characters, resizing the
composer, and scrolling it. Historical Markdown render count should remain zero and commit
time should no longer grow materially with transcript length.

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

- cantrip_worker/src/index.ts:455, 4753-4756, and 4960-4963 tie encryption refresh to the
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
- cantrip_server/src/app.ts:4339-4357 authorizes projects via listProjects(...).some, chats
  via full getChatExecutionContext, and workflows via full getRun.
- cantrip_server/src/db/repository.ts:7910-7991 shows project listing also loading
  replica/source/worktree data; 15484-15563 shows chat context loading settings, worktree,
  runtime, and lane state.
- cantrip_server/src/db/workflow-runs.ts:996-1069 shows getRun plus six detail queries.
- cantrip_server/src/db/index.ts:229-234 caps the PostgreSQL pool at five connections.

Hypothesis: reconnecting with many scopes can issue hundreds of queries and allocate
resource graphs unused by authorization, delaying the live path and unrelated requests.

Suggested change: group requested IDs by project/chat/workflow and authorize with at most
three ownership/existence IN queries, preserving owner, archival, and lifecycle predicates.

Validation: assert identical decisions and count SQL plus subscribe/resync p50/p95 at 1, 16,
and 128 scopes against large fixtures.

### P0-05 — fixed — Stop using aggregate settings hydration for preference decisions

- Status: fixed 2026-08-24
- Category: REDUNDANT_COMPUTATION
- Expected gain: high
- Original risk: low
- Original complexity: low-medium
- Confidence: high

Original evidence on the audited baseline:

- cantrip_server/src/db/repository.ts:3023-3131 performs roughly nine settings-related
  queries, including token and agent-time analytics.
- cantrip_server/src/db/repository.ts:3205-3231 reads lifetime token intervals and
  groups/sorts them in application code.
- A focused preference loader already exists at
  cantrip_server/src/db/repository.ts:3652-3683.
- Preference-oriented callers use the aggregate loader at
  cantrip_server/src/app.ts:8487-8501 and 13597-13609,
  cantrip_server/src/chat-imports/executor.ts:693-708,
  cantrip_server/src/chat-relocations/executor.ts:612-620 and 825-843, and
  cantrip_server/src/workflows/executor.ts:1325-1338.

Original hypothesis: routine model/runtime resolution pays for unrelated provider,
credential, routing, and lifetime-analytics work, with cost growing alongside telemetry
history.

Resolution:

- Preference-only decisions in the app, chat import/relocation, and workflow executors now
  call `getUserSettings`, which selects only the preference row.
- Provider catalog reconciliation and worker-scoped catalog refresh use dedicated provider
  projections. Provider deletion checks route existence with a bounded joined lookup rather
  than hydrating and scanning every model.
- `getSettings` now composes the same focused preference loader and remains available for
  settings UI responses that intentionally need provider, model, credential, routing, and
  analytics data.

Validation:

- A PGlite query-count regression test verifies exact preference parity, one query for the
  focused preference loader, nine queries for the aggregate loader, and one query for each
  provider projection and route-existence lookup.
- With 10, 10,000, and 1,000,000 token-interval rows, focused and aggregate preference
  results, selected model IDs, and resolved model runtimes were identical. Focused hydration
  remained one query and measured 0.39 ms, 0.47 ms, and 0.67 ms respectively; aggregate
  hydration remained nine queries and measured 4.73 ms, 57.46 ms, and 4,707.38 ms in the
  same local PGlite validation run. These timings are directional local measurements; the
  query counts and output-equivalence assertions are the regression contract.

Regression guardrail: keep routine preference and provider decisions off `getSettings`.
Require exact result-parity tests when adding a focused projection, retain the one-query
regression test, and rerun the history-scale comparison when changing settings or analytics
hydration.

### P0-06 — fixed — Collapse worker-management 1+2N queries

- Status: fixed after the audit (reported 2026-08-24)
- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high
- Original risk: low
- Original complexity: low
- Confidence: high

Original evidence on the audited baseline:

- cantrip_server/src/db/repository.ts:6843-6899 loads workers, then issues two queries per
  worker for credentials and source/project assignments.
- cantrip_server/src/app.ts:14745-14752, 14789-14800, and 14823-14829 load the whole fleet
  only to find one worker for restart, rename, and delete.
- cantrip_server/src/db/index.ts:229-234 caps the pool at five connections.

Original hypothesis: fleet listing and even single-worker mutation latency grow linearly
with fleet size and can monopolize the database pool.

Resolution: marked fixed after the audit and removed from the pending delivery waves. The
fixing implementation was not present on origin/main when this status-only documentation
update was prepared, so this report does not attribute an implementation PR or commit.

Regression guardrail: retain the original acceptance target of three queries for the list
and one focused lookup for mutation; compare response parity and p95 at 1, 10, 100, and
1,000 workers.

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

### P0-09 — resolved — Make log ingestion incremental and export formatting lazy

- Status: resolved 2026-08-24
- Category: ALGORITHM_COMPLEXITY
- Expected gain: high
- Original risk: low
- Original complexity: low-medium
- Confidence: high

Original evidence:

- cantrip_app/src/components/settings/log-viewer-model.ts previously rebuilt and fully
  sorted the complete bounded collection, recomputed all bytes, and repeatedly shifted the
  head on every append.
- cantrip_app/src/components/settings/log-settings.tsx previously memoized the complete
  newline-delimited export string on every visible-record update.

Original hypothesis: high-volume logs paid O(N log N) plus several O(N) passes per batch and
retained a large derived string even when the user was only viewing.

Resolution:

- cantrip_app/src/components/settings/log-viewer-model.ts:192-251 now associates immutable
  record snapshots with incremental byte/cursor metadata and trims through one head index
  and slice.
- cantrip_app/src/components/settings/log-viewer-model.ts:254-383 takes a direct ordered
  append path for normal stream batches and a linear merge path for backfill or replacement,
  while retaining a defensive normalization fallback for noncanonical input.
- cantrip_app/src/components/settings/log-viewer-model.ts:162-175 returns the original
  collection for an inactive filter; lines 385-405 preserve incremental metadata when
  visible records are cleared.
- cantrip_app/src/components/settings/log-settings.tsx:870-887 uses the metadata-preserving
  removal path, while lines 990-1026 build visible text only inside copy/export actions.
- cantrip_app/src/components/settings/log-viewer-model.test.ts:232-355 covers cross-transport
  deduplication, last-write replacement, ordered and out-of-order merging, record and byte
  limits, inactive-filter identity, export equivalence, and clear-then-append behavior.

A/B benchmark proof on a full 10,000-record buffer, with 5 warmups and 20 measured
process-isolated runs per variant:

- 150 ordered 50-record batches produced stable equivalent output. Median command time fell
  from 425.096 ms to 301.382 ms: 1.410x, or 29.10% faster.
- 100 mixed 50-record batches containing ordered records, an existing-key replacement, and
  an out-of-order backfill produced stable equivalent output. Median command time fell from
  381.534 ms to 337.270 ms: 1.131x, or 11.60% faster.

Regression guardrail: retain focused model/UI tests and the baseline-equivalence helper.
Require exact ordering, transport/cursor deduplication, last-write replacement, byte and
record limits, filtered/exported text, and clear behavior to remain unchanged.

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

### P0-11 — opportunity — Parallelize bounded workspace-snapshot metadata reads

- Category: SYNC_IO_HOT_PATH
- Expected gain: high for large dirty worktrees
- Risk: low
- Complexity: low
- Confidence: high

Evidence:

- cantrip_worker/src/codex/app-server.ts:2690-2717 and 2724-2729 await one lstat per
  dirty/untracked file sequentially.
- Snapshot creation sits on turn/workflow baseline and completion paths at lines 3898, 4088,
  7947, and 8182.

Hypothesis: turn start and completion latency grows by one filesystem round trip per changed
path.

Suggested change: use an ordered concurrency-limited mapper of roughly 16-32 reads; bypass
lstat for statuses that unambiguously mean deletion.

Validation: compare snapshot bytes for 1, 100, and 5,000 changed paths with delayed lstat.
Assert bounded descriptors/concurrency and lower wall time.

### P0-12 — resolved — Skip CodeGraph sync when fresh status proves no work exists

- Status: resolved 2026-08-24
- Category: REDUNDANT_COMPUTATION
- Expected gain: high for enabled idle projects
- Original risk: low
- Original complexity: low
- Confidence: high

Original evidence:

- cantrip_worker/src/codegraph/supervisor.ts:29-31 and 479-485 schedule each project every
  two minutes.
- Lines 798-831 and 896-932 perform status, sync, then status even when the first fresh
  status says pendingChanges is zero; logging recognizes the no-change case.

Original hypothesis: idle indexed projects repeatedly invoke an unnecessary external sync.

Resolution:

- cantrip_worker/src/codegraph/supervisor.ts:807-841 now returns through the normal success
  path after the fresh status when the action is sync, the project is initialized,
  pendingChanges is zero, and reindex is not recommended.
- cantrip_worker/test/codegraph-supervisor.test.ts:186-244 proves a clean sync performs only
  status while unknown pending state retains status/sync/status and a reindex recommendation
  retains status/index/status.
- cantrip_worker/test/codegraph-supervisor.test.ts:246-274 disables the filesystem watcher,
  advances the two-minute reconciliation interval, and proves a pending change still
  performs status/sync/status.

Deterministic work-count proof: the clean fake-executor path falls from three external
operations (status, sync, status) to one (status), eliminating the sync and verification
status calls while preserving the ready state and completed job acknowledgement.

Regression guardrail: retain the focused CodeGraph supervisor test and require unknown,
changed, uninitialized, rebuild, and reindex paths to continue executing their existing
fallback commands.

### P0-13 — opportunity — Add capped jittered backoff to worker reconnects and crashing services

- Category: N_PLUS_ONE_OR_CHATTER
- Expected gain: high during outage/failure
- Risk: low
- Complexity: low
- Confidence: high

Evidence:

- cantrip_worker/src/transport.ts:49-51, 279-305, and 388-405 reconnect the command channel
  at a fixed one-second interval.
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

- cantrip_worker/src/index.ts:4881-4948 awaits independent shutdown stages sequentially.
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

Evidence: cantrip_server/src/live/hub.ts:419-453 uses Array.shift to evict from a replay
buffer of up to 2,048 events/32 MiB. cantrip_worker/src/transport.ts:195-196, 633-669, and
721-735 uses shift for an 8 MiB command queue and recomputes byte lengths.

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

Evidence: cantrip_worker/src/browser/browser-adapter.ts:463-493 has no in-flight capture
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
every 5 ms. cantrip_worker/src/transport.ts:796-803 and
cantrip_worker/src/tunnel-tcp-adapter.ts:345-383 can create similar per-stream polling.

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

Evidence: cantrip_worker/src/transport.ts:301-304 and 807-845 start asynchronous command
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
  where a copy is required. Use the same contract for WebSocket and WebRTC.

These are code-sharing opportunities, not a recommendation to build a generic framework.
Each primitive should stay small, locally testable, and tied to the listed callers.

## Recommended delivery sequence

### Wave 0 — add proof harnesses

Before behavior changes, add or reuse focused counters and deterministic fixtures:

- React Profiler harness for 500-message typing and 1,000-turn anchor layout;
- prerecorded remote-frame replay for browser/server allocation and encode counts;
- SQL counter fixtures for AppLive scopes, worker fleets, and workflow recovery;
- child-process counters for idle worktrees and Git status;
- fake clocks for reconnect, service restart, and guarded recovery;
- delayed-filesystem fixtures for snapshot, Explorer, and repository stats.

### Wave 1 — local and mechanically verifiable

Implement the safe slices of P0-02, P0-08, P0-11, P0-13, P1-01, P1-06, P1-07,
P1-15, P1-16, and P1-18. These mostly remove duplicate work or replace an equivalent data
structure.

### Wave 2 — bounded batching, memoization, and ownership

Implement P0-01, P0-03, P0-04, P0-07, P0-10, P0-14, P1-02 through P1-05, P1-08 through
P1-13, and P1-17. Land each behind equivalence tests and bounded cache/queue policies.

### Wave 3 — conditional tuning

Use Wave 0/1 telemetry to decide P1-14, P1-19, P1-20, and all P2 items. Avoid architectural
transport or admission-control work without production evidence.

## Success metrics

Track the following before and after each wave:

| Surface                  | Primary metric                                   | Guardrail                                             |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| Chat typing/streaming    | React commit time and historical row renders     | no lost/reordered live messages                       |
| Remote surfaces          | allocations/s, GC, frame latency, dropped frames | byte-identical framing and usage accounting           |
| AppLive subscribe/resync | SQL count and p50/p95                            | identical scope authorization and replay              |
| Worker fleet management  | SQL count and p95 by fleet size                  | identical credential/source projection                |
| Idle worktrees           | Git child processes/minute and watchers/source   | unchanged watcher-failure recovery                    |
| Git status               | subprocesses/refresh and latency                 | detached/unborn/conflict parity                       |
| Worker idle              | event-loop delay, crypto unwraps, disk writes    | key rotation/revocation refresh bound                 |
| Logs                     | CPU/allocation per 10k records                   | exact ordering, limits, filters, export               |
| Turn boundaries          | snapshot wall time by changed paths              | deterministic snapshot contents                       |
| Failure recovery         | reconnect/spawn attempt distribution             | terminal errors stop; manual actions remain immediate |
| Shutdown                 | completion bound and leaked resources            | every close attempted and errors retained             |
| Database recovery        | statements and recovery duration                 | identical job/run outcomes                            |

The expected end state is not merely lower benchmark numbers: long chats should type like
short chats, remote surfaces should remain smooth under sustained frames, idle projects
should stop doing visible background work, fleet growth should not consume the database
pool, and degraded services should recover without creating their own load spike.
