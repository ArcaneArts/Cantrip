# Provider inference concurrency

Provider configuration stores `maxConcurrentInference` (positive PostgreSQL
integer, default 8) and `inferenceConfigRevision` (initially 0). The database
advances the revision atomically only when the limit changes. Mutation inputs
keep the limit optional so updates from older clients preserve it. Provider
summaries and resolved model runtimes carry the configuration through both the
Node and Rust server implementations.

## Worker timing in provider telemetry

The existing private `inference.command-state` event carries exclusive monotonic
command counters: provider queue wait, command preparation, admitted execution,
and confirmed suspension. State transitions and command completion emit the
counters; streamed tokens and idle time do not generate timing traffic. Commands
that never observe inference do not emit a new completion event. Counters are
correlated with the existing request and rejected by per-attempt sequence order.
They do not own, grant, release or prove settlement of a provider ticket.

Both servers persist the optional `inference_timing` object on the existing model
behavior observation. A command that closes with an observed operation still
unsettled is incomplete. Lost final events, old workers, and legacy observations
remain unknown. Complete terminal samples feed separate execution, queue, and
suspension statistics; latency change detection uses only their execution time.
Historical wall-clock samples are deliberately not mixed into this new execution
metric. Execution includes ordinary tools within the admitted turn and must not
be described as model sampling time or tokens per second.

Existing `durationMs`, first-activity/visible-response timestamps, and total
elapsed metrics retain their wall-clock meaning. The provider telemetry dialog
labels these totals and displays the new worker medians separately. Exports
include the optional worker evidence. A delayed attribution snapshot that omits
timing preserves existing evidence. Private timing stays out of domain/chat event
streams, and observer failures cannot fail an admitted operation.

This covers server-command-associated turns, including Task dispatch, not native
autonomous cycles which run outside that command's observation lifetime. Those
cycles retain their worker admission timing; stitching them into model-behavior
observations requires their canonical native execution identity, not an invented
RPC lifetime. Migration 0261 adds the optional column and validates its bounded,
nonnegative integer counters. No migration, tests, builds, typechecks, benchmarks,
native execution or computer-use checks were run for this milestone.

## Durable delivery of explicit Task Goal outcomes

Settled `chat.turn` responses carrying a Goal input receipt now enter a worker-local
response outbox before the ordinary command response is published. The immutable
file contains the existing protected response and original physical receipt
identifiers, never another prompt body. Its directory is scoped by stable server,
owner and worker identity rather than the current process generation. File data
is flushed before publication; directory-entry power-loss durability follows the
existing history writer and is POSIX-only.

The worker delivers pending files through the authenticated native-command HTTP
path. Both servers validate the owning server/account/worker and the exact
canonical Goal input before committing its protected history and terminal marker.
The response acknowledges that committed transaction and echoes the delivery and
physical input identities. The worker removes the file only after this matching
acknowledgment. A lost response is retried idempotently, including after worker
restart; a socket send or scheduled recovery callback is not commit evidence.
Delivery also schedules the existing Goal metadata recovery, independently of the
live RPC's suppression key. A stale generation can deliver captured history but
cannot gain execution or current Task projection authority through this endpoint.

The scanner reads one response at a time and deletes acknowledged files without
retaining completed-result tombstones. Unresolved files are retained. Actual
delivery failures use bounded backoff; an empty directory has no polling timer.
Reconnect and new results wake delivery. Authentication rejection stops this
delivery lifetime. A failed local write retries before response publication;
storage failure cannot turn a successful execution into a contradictory model
failure or release/reacquire inference capacity. Protected responses use a
dedicated 32 MiB HTTP body allowance in both servers, including base64 expansion.

This milestone covers captured explicit Task Goal outcomes. A crash before that
capture still requires native checkpoint/terminal reconciliation. Ordinary Chat
and Task-round outcome transport, current-generation abandoned preparation, canonical timing
integration and the final bounded-runtime/inference-path audit remain unfinished.
Older servers without the commit endpoint cannot acknowledge these files. No
tests, builds, typechecks, benchmarks, native execution or computer-use validation
were run; direct formatting, mechanical protocol export and diff review do not
establish exercised runtime behavior.

## Durable native execution correlation

The worker now awaits a `bindNative` journal acknowledgment at Core's existing
private inference-begin boundary. The keeper binds one exact native thread,
turn and physical scope to that ticket's worker/runtime generation. A duplicate
binding is idempotent; a changed binding or released grant is rejected. The
original operation/provider/input identity and FIFO ordinal stay unchanged.
The optional `nativeExecution` field survives retirement and restart snapshots
alongside the existing settlement facts. It carries no prompt or response body.

Root inference uses its existing ticket, including when naming has already run
serially under it. Autonomous cycles, children and independent helpers bind
their own grants. Cancellation/retirement is checked again after durable writes;
a late acknowledgment cannot begin execution. A root whose first binding fails
has not been allowed into that native scope and still waits for actual turn
completion or process fencing. A new independent operation denied before its
model dispatch can settle its unused reservation. Once a begin has been allowed,
the existing private finish/physical process boundaries remain authoritative.

This supplies durable physical identity for checkpoint reconciliation; a binding
alone proves neither that a model ran nor that input can be replayed. It does not
add a semaphore, new input queue, completed-event registry or public native RPC.
The current worker and native keeper must be deployed together; older unbound
records remain readable. Actual native checkpoint/terminal reconciliation,
unresolved result retirement, remaining Chat/Task-round durable outcomes and the
final timing/bounded-state/inference-path audit remain unfinished. Source review,
direct formatting, mechanical source patch/contract generation and diff checks
were performed. Native execution, patch verification, tests, builds, benchmarks,
typechecks and computer-use validation were not run.

## Provider catalog changes

Migration `0258_provider_inference_catalog` records one membership revision per
owning account and each provider's creation ordinal. Existing providers start at
zero. Provider creation, deletion and ownership changes advance membership in
the same database transaction; ordinary edits preserve the creation ordinal and
continue using the separate limit revision. Cascading user deletion does not
recreate a deleted account's catalog. Both servers read membership, ordinals and
limits together in one MVCC statement.

Creation, deletion, limit changes and worker connection deliver the full
`inference.configure` catalog. Workers ignore older membership snapshots and
apply same-membership limit changes using each provider's monotonic revision.
An authenticated runtime envelope for a provider created after an older snapshot
can initialize that provider immediately. An envelope predating a snapshot that
removed its provider cannot resurrect the pool. This avoids a growing list of
deleted IDs and does not require polling or an availability probe before every
inference. Legacy configuration arrays update limits without asserting deletions;
learning a legacy pool's actual creation ordinal does not cancel its queue. A
fallback default 8 can be replaced by its first actual revision-zero limit.

Removal cancels waiting, granted-but-unstarted and confirmed-suspended tickets.
Running tickets retain capacity through actual settlement. Subsequent Goal
cycles and helpers cannot obtain new tickets for the removed provider. Current
processes retain their existing lifecycle so removing a provider cannot kill a
final response between physical inference settlement and worker result capture.
Other providers' capacity is independent. Non-inference catalog/status work is
not turned into an inference admission request. Suspended tickets have a live per-pool index, so snapshots and
removal do not scan every completed operation.

Workers acknowledge the applied catalog revision. Empty removed pools are
discarded after their holders settle; pending canonical recovery metadata remains
available for a separately authorized replacement route. The database membership
counter is not a server semaphore and never grants or frees provider tickets.
Delivery failures are reported without converting a committed provider mutation
into a failed API mutation. Reconnection refreshes authoritative state; transient delivery failures also retry
through the coalesced pending delivery service described below, including while
the worker stays connected. Older workers need the updated catalog protocol.

The migration was not executed. Source review, direct formatting, mechanical
protocol export and diff checks were performed; no tests, builds, typechecks,
benchmarks, native execution or computer-use validation ran. Runtime behavior is
unverified. The remaining recovery, outcome-delivery, timing and bounded-runtime
audit obligations of the full goal remain active.

`WorkerInferenceAdmission` belongs to one server/owner/worker generation. Its
provider pools are outside the project, account, model, and native-runtime maps.
Runtime envelopes update the shared pool with their revision; stale revisions
are ignored, and legacy envelopes cannot reset an established pool.

Each opaque runtime handle owns idempotent operation identities. Admission
reserves capacity synchronously in FIFO order before resolving its promise. A
ticket moves from waiting to granted to running, with cancelling retaining
running capacity until the owner explicitly confirms settlement. Unstarted
requests can be cancelled immediately. Observers receive coalesced snapshots
with worker generation, revision, counts, and one-based waiting positions.
Observer failures cannot hold or release execution capacity.

Operation snapshots optionally include monotonic `timing` counters for the
current worker/runtime generation: `queueWaitMs`, `reservedMs`, `executionMs`,
and `suspendedMs`. Queue time includes every FIFO reacquisition; reserved time
covers a granted ticket before execution starts. Execution includes ordinary
tool round trips and cancellation until confirmed settlement. It is not a
measurement of model sampling throughput. A confirmed suspension and the later
reacquisition wait are measured separately. Released handles retain frozen
counters. Wall-clock timestamps and existing total-elapsed metrics are unchanged.
Recovered placeholder records omit timing because a new monotonic clock cannot
reconstruct the previous process's durations reliably. Replacement operations
measure their own current-generation observation, without inventing missing time.

The worker writes one debug diagnostic per queue/grant/start/cancel/suspend/resume/
release transition, plus canonical recovery decisions. Diagnostics include opaque
operation/provider/runtime/worker identities, the current worker generation and
available timing counters; recovery also identifies the previous generation.
They contain no prompt, title, credentials or token-stream events, introduce no
completed-event registry, and use the existing bounded service log buffer/archive.
Recovery decisions already installed in the current recovery set are not logged
again on each refresh. Diagnostic callback failures cannot change ownership.

Runtime retirement requires confirmed execution termination; a caller must not
retire a runtime on a timeout, missing output, or an observing UI disconnect.
Retirement invalidates its grants, removes its pending requests, and releases
its holders. Late callbacks retain their old handle and cannot affect a
replacement runtime. Settled operations remain idempotent for that runtime's
lifetime; retirement releases the record set.

## Delivery status

The foundation includes persisted configuration, runtime propagation, worker
ownership, and the admission primitive. Root GUI chat turns and managed native
turns (terminal input, queued starts, Tasks, and autonomous goal cycles) now acquire
before forwarding their actual native start. Each completed cycle releases its
ticket independently of later workspace reconciliation and UI publication. A
continuation must acquire again through the same provider queue.

Native ticket correlation lives separately from UI execution tracking. Actual
turn IDs and private native settlement notifications settle tickets; a native rejection before
an observed start releases the unused reservation. A disconnected socket cancels
unforwarded work but retains dispatched holders until actual process exit. The
captured process-exit hook remains valid after socket or child-handle replacement.
Explicit Stop can cancel a queued chat before it has a native turn ID.

Auxiliary agent operations and standalone stateless labels now use the same
worker admission service. Both servers prepare an opaque first-message label job
inside the existing turn command. A same-provider job uses one serial reservation
for labeling and the response; a different labeling provider settles and releases
before response admission. Correlated native label replies remain observable after
the RPC deadline, so a timed-out observation cannot start overlapping inference
under one ticket. Metadata failure retains the fallback title.

Native patch `0048` extends the existing connection-owned managed execution channel
with private inference boundaries. Actual root/child turn identities, manual
compaction, speculative background compaction, and Guardian classification participate.
Independently concurrent native operations acquire separate tickets. Guardian
transport cancellation/draining retains its reservation through actual settlement.
Hidden helper threads receive the same connection-owned channel.

Patch `0054` gives independently concurrent native requests an explicit private
`begin-independent` phase. A helper such as Guardian can start while the root's
`turn/started` observation is still pending; speculative background compaction
uses the same explicit independent boundary. Their identities must not bind that
unobserved root or reuse the root reservation. The worker admits these requests
as helpers with their own tickets. Ordinary root `begin` retains its existing
reservation reuse, including at limit one. Redelivery of an operation cannot
change its admission kind. Suspension, resumption, cancellation and terminal
settlement still use the original exact native operation identity.

The native runtime and worker ship this boundary together. An older worker
denies the new unsupported phase through the existing private resolver rather
than letting an independent request execute without admission. This does not
add a public protocol endpoint or another semaphore. Patches `0055` and `0056`
cover the model-client transport and memory paths described below.

Patch `0055` extends the native inference lifetime through actual response
ownership. A regular turn, foreground compaction, or speculative compaction
attaches its exact inference owner to the model client. Per-request resources
retain that owner through HTTP dispatch before headers and the spawned response
body task, or the WebSocket response task. A native cancellation closes the owned
IO. A failed WebSocket pump is aborted and joined before ownership is released;
a cancellation deadline alone is not evidence of its termination. The owned
dispatch preserves the request trace context and does not duplicate its payload.

Requests within one admitted turn remain sequential through actual transport
teardown, including retries. A native parent cannot suspend until both sampling
and its retained response tasks have stopped. Ending the turn prevents another
request from starting under that owner; private `finish` is emitted once the
remaining response resources settle. Mutex-protected ownership makes dispatch
retention and turn termination linearizable. These are lifetime resources for
one already-admitted operation, not additional provider tickets or a native
provider semaphore.

The worker records entry through the private boundary as positive native start
evidence. For those operations, a later UI `turn/completed` observation cannot
release capacity ahead of the private `finish`. A contradictory start-RPC error
also cannot override that evidence. Operations that never entered Core retain
their existing proven-preparation/terminal handling, and actual process fencing
remains the fallback when private ownership observations are lost.

Execution handles expose a settlement promise resolved by confirmed release,
proven cancellation before dispatch, or completed runtime fencing. Turn, helper,
standalone-label and admitted-native completion paths await that promise before
returning control for a retry or provider transition. Native control-frame
processing remains independent of those waits. A shared first-turn title does
not await release of its compound reservation before the response.

This integrates regular and compaction model clients and exposes a session
binding for independently admitted model-client helpers. No public RPC, prompt
queue, status polling or completed-resource registry is added.

Patch `0056` admits every parallel stage-one memory extraction independently on
its actual owning thread's inference gate. It does not use root-input eligibility
or borrow a parent turn's reservation. The raw model-client session binds that
helper's transport lifetime before dispatch, so cancellation or abandoned output
retains capacity until actual response cleanup. Normal unmanaged Codex sessions
retain their existing behavior.

All already-claimed extraction jobs renew their canonical SQLite ownership token
while waiting for local preparation or worker provider admission. The existing
local preparation bound remains; its backlog is also polled for coarse claim
renewal. A matching running token extends its lease, preventing ordinary capacity
waits from expiring the one-hour claim. An actual ownership mismatch cancels only
that job's wait/response. A failed database observation is retried and cannot prove
inference settlement. Parent-session termination and native admission cancellation
are skipped work, rather than failed extraction retries. Abandoned canonical
claims retain their existing lease-expiry recovery; the inference ticket follows
actual transport settlement independently of that lease.

Memory consolidation uses the existing internal-child session startup API with
its real parent. This avoids rebinding the parent's connection gate to a new root
and preserves its shared inference channel. The child acquires its own turn ticket;
the existing consolidation lease heartbeat also runs while that turn waits for
capacity. This adds no provider-availability probe, second input queue or app poll.

Patch `0057` binds stateless labeling to the same transport ownership resources
without a nested provider acquisition. The worker already holds its standalone
or compound title/response reservation. Native Core retains the 25-second
inference deadline, then cancels and awaits actual dispatch/body/socket cleanup
before returning either text or an error. The catalog RPC no longer wraps that
cleanup in an observer timeout. Its existing timeout-versus-failure errors remain
distinct. Dropping an observer also cancels the scope while retained transport
resources finish; the worker's existing native fencing owns ambiguous outcomes.

The worker still observes labels with its existing 27-second bound and retains
its native settlement callback. The server's 30-second execution budget remains
separate from capacity waiting. These observation deadlines cannot manufacture
transport settlement. A same-provider first-response title uses its already-held
reservation through cleanup and then continues serially; another provider is
released before response admission. No new ticket, thread, prompt queue or RPC
shape is introduced for this drain scope.

Patch `0058` assigns a fresh private scope UUID to every native inference lifetime.
Logical thread/turn IDs can be reused by a restored continuation; they cannot
identify a physical execution on their own. Begin, suspension, FIFO resumption,
cancellation and finish carry that scope. The worker binds an unbound dispatched
root reservation to one scope, while a different scope receives independent
admission. Helper operation/recovery identities include the scope as well.

A late finish or cancellation matches only the old scope, including pending
control requests, and cannot release or abort its replacement. Logical UI
completion cached before a new dispatch cannot settle that unforwarded attempt.
After private binding, UI completion remains separate from transport settlement.
The worker echoes the scope with each positive resolver acknowledgement; Core
checks it against the actual pending request. A mismatched older peer denies
admission through the existing resolver instead of running with unscoped release.
These fields use the existing private control payload and opaque generation
string; no public protocol shape or additional semaphore is introduced. Wiring
canonical restored-continuation recovery remains separate work.

Patch `0059` installs an inference-only native channel for Task-created threads,
including before Task Goal activation or active resumption. Task rounds and
canonical dispatch records retain input authority; they do not enter the GUI
prompt codec or a second scheduler. Actual native cycles, children and helpers
still request the same worker/provider tickets, release after physical settlement,
and rejoin FIFO for later cycles. Structured Task operations retain their existing
independently admitted helper path. External Task Goal activation and cold resume
prepare the channel but leave the initial kickoff to the Task owner's explicit
input, avoiding a competing automatic turn during preparation. Later completed
turns still trigger normal native continuation. An interruption cancels that
scope while preserving the channel for a later explicit Task resume.

This native mode does not claim managed input or permission ownership. Worker
preparation keeps Task permission configuration and preserves existing child
settings during Goal metadata operations. Gate generations cannot change mode,
existing managed input ownership cannot be downgraded, and a live update binds
its channel to the actual thread under the existing connection-owner check.
The opaque chat association lives with the existing thread overlay, allowing
later-cycle queue status to identify the Task after its preceding ticket was
released. It is cleared with that overlay; no additional controller map or prompt
store is added. Autonomous Task Goal checkpoint recovery and execution accounting remain unfinished.

Scheduled Task round completion, failure, and execution association, including
durable worker outcome recovery, lock the real owner/cycle fence in the same transaction as their round write. A heartbeat before
the write is insufficient: recovery or lease expiration can replace that authority
between the heartbeat and callback. Both server implementations compare the exact
cycle, operation, owner, fence, and current dispatch. Expiration cleanup carries
its captured expired fence, so it cannot fail a subsequently recovered operation.
A history association arriving after a fast settlement may finish under the same
unchanged lease owner/fence, without reopening or settling the Task. Stale scheduled
callbacks retire quietly instead of spending retry budget or logging a new launch
failure. These are canonical data-write fences; lease expiry does not establish
native inference settlement or release a provider ticket.

Scheduled encrypted Task rounds now attach input-authority metadata to their
existing canonical round before worker dispatch. The receipt identifies the
actual route attempt, Task dispatch fence, original user message, placement, and
exact execution-lane activation; lane IDs alone are reusable. It contains no
prompt copy and does not participate in provider capacity decisions.

The worker acknowledges that it enforces the receipt before entering provider
admission, then obtains a separate dispatch acknowledgement before sending the
actual native input. An older worker that ignores the optional command field
cannot manufacture no-dispatch evidence. Unacknowledged predecessor attempts
retain uncertainty across route retries. A dispatch acknowledgement is a single
input authorization: another dispatch with that receipt is rejected, including
after an unobserved reply, rather than forwarding a duplicate native start.

Both servers serialize receipt dispatch and recovery against the actual owner,
cycle, canonical round and lane activation. If recovery revokes a pending input
first, its old worker cannot forward it. If dispatch wins, sticky evidence prevents
whole-input replay. Exact native no-start evidence can reconcile a single matching
unobserved acknowledgement; an earlier or multiple forwarded attempts cannot be
cleared by a later unstarted attempt. Pending round recovery preserves its encrypted
relay input and FIFO cycle, restores the pre-claim attempt count, advances the
dispatch fence, and retires only that exact lane activation without an unread
completion. A paused recovery retains its placement for the existing resume path.
Ordinary lane settlement also locks chat before lane, matching start and recovery.

Server-startup interruption cleanup leaves receipt-bearing rounds to their actual
dispatch lifecycle. Expired claimed receipts take the same exact-fence recovery
path even if their start observation was lost; lease expiry itself releases no
provider ticket. A committed expiry is retried after a recovery write fails or
the server restarts, selecting only still-canonical enforced pending inputs
rather than polling expired history. Native takeover first fences surviving processes. Patch `0060`
then allows the keeper to adopt server-confirmed unforwarded Task input into the
replacement ticket, preserving same-provider FIFO ordinals atomically. A title can
have used that reservation without having forwarded the Task input. A route change
retains the destination provider's fresh order. Dispatched/ambiguous native work
still needs its own terminal/checkpoint recovery; this is not exactly-once execution.

This covers scheduled initial direct/planning/finalization inputs. Explicit Task
Goal kickoff/resume uses the separate canonical identity described below;
autonomous checkpoint recovery remains unfinished. Current-generation abandoned
preparations and separate per-turn execution/wait accounting also remain open.

Known dependency and user/approval waits can suspend their parent's reservation
only after all parent sampling streams have stopped. Resumption rejoins FIFO before
another model request. Ordinary tool round trips retain their reservation. Native
pause checks its current watch state again after a queued resume grant.

Worker requests now report a private, monotonic admission timing phase. Both
server implementations exclude provider-queue and confirmed suspension time from
command deadlines, including the standalone 30-second labeling request. Preparation
and execution retain separate cumulative bounded budgets; repeated events do not
reset those budgets. The Node server's inter-instance relay carries the same clock
control events internally, without exposing them as chat activity. Native label
execution retains its own 27-second observation/25-second native cancellation bounds.

Native patch `0053` distinguishes cancellation in a provider queue from an empty
automatic goal response. A per-turn extension-store marker is installed before
Core's actual `begin` request for regular turns, restored continuations and manual
compaction. It is marked admitted only after the worker grant reaches Core.
The existing inference lifetime still owns cancellation/settlement; the marker
cannot grant or release capacity. On abort, a turn that never received its grant
is retired from goal turn accounting without entering empty-response evaluation.
Existing empty-response history is preserved; a later admitted empty execution
still follows the normal policy.

Native goal `timeUsedSeconds` remains the existing active wall-clock metric. The
app already displays it as elapsed time, so subtracting provider waits there
would silently change that metric's meaning. Worker execution/queue counters are
separate evidence. Their canonical handoff to per-turn performance and the UI's
execution-versus-elapsed presentation still require integration, including the
outer worker wait before a first `turn/start` and native cycle reacquisition.
Server attempt accounting and restart timing reconciliation also remain part
of that work. No native wall-clock baseline is reset on a provider grant.

Provider limit edits are delivered directly to linked workers and synchronized on
authenticated reconnect. Workers acknowledge the actual scoped pool snapshot and
ignore stale per-provider configuration revisions. A capacity-only edit preserves
native sessions and does not force a catalog refresh. Increasing capacity drains
FIFO waiters; reducing capacity leaves current holders running.

Native patch `0049` adds worker/native lifetime ownership. A private native
keeper holds an OS lock for the server/owner/worker scope while the Node worker's
lifetime pipe is open. This is independent of browser and server connections.
Every managed app-server consumes a one-use launch intent and holds its own OS
file lease for the entire native process lifetime. Filesystem ownership changes
wake a native watcher; revocation terminates the actual native process. Read/access
events are ignored so the watcher cannot wake itself by checking its ownership.

A launcher exit fences that exact runtime and waits to obtain its native lease
before releasing remaining tickets. Killing a taskkill helper, losing a socket,
or expiring a reconciliation deadline is not native death evidence. Failed
reconciliation retains capacity and retries, with bounded diagnostics. New worker
generations take exclusive scope ownership, revoke previous intents, and wait for
all surviving native leases before preparing their first runtime. Late launches
cannot consume retired intents. Prepared intents, active identities, and their
locks are removed after confirmed settlement; no prompts or provider credentials
are stored in this registry.

Graceful shutdown also closes the keeper explicitly: worker `start()` can restart
inside the same Node process, so relying only on process exit would leave the old
generation's lifetime pipe open. Abrupt Node exit closes that pipe through the OS.
A surviving keeper fences and drains its native runtimes before giving up scope
ownership; if the keeper itself dies, the replacement performs that reconciliation.
The native OS lease outlives Rust task cancellation and runtime teardown. PID
reuse, wrapper exit, and process-name searches do not participate in proof.
CantripOS inference still runs on the owning worker; only its tools run in the guest.

An explicit rejection of the current worker connection (WebSocket policy close
`1008`, or HTTP `401`/`403` during its upgrade) stops new inference admission and
retires every inference scope belonging to that worker generation. This also runs
when a preceding reconnect-grace expiry already disconnected transport resources.
Runtime retirement still waits for native lease settlement before closing the
keeper, allowing a replacement worker to take ownership without oversubscribing
surviving execution. Concurrent shutdown shares the same retirement completion.
Re-enrollment requires a worker restart before admitting inference again. Ordinary
network loss, upgrade server errors, credential-rotation close `1012`, and stale
socket callbacks do not retire inference authority.

Both server command buses reserve a separate, bounded control lane. Stop, pause,
interaction replies, native logical settlement, queue preparation/change notifications,
automation resume, settings reads, goal reads/clears, inference configuration, and
worker lifecycle controls do not compete
with long-lived inference requests for ordinary transport slots. Native steering,
new turns, helpers, compaction, and queued execution remain ordinary commands.
The control lane allows at most eight additional requests per owner and worker
(or their configured command-concurrency limit, if lower). It has independent
rate counters using the existing configured rates. All traffic still shares the
existing relay bandwidth quota and authorization. Request statistics count both
lanes; neither server grants provider tickets. This preserves control headroom
without creating a second prompt queue.

The ordinary command-concurrency counters cover dispatch until a positive worker
admission acknowledgment, rather than a queued inference RPC's entire lifetime.
After the keeper acknowledges the operation's journal entry, the worker emits
one private `inference.command-state` event with `admitted: true` for that
correlated request. An earlier `waiting` phase alone cannot release the counter.
Both server buses release their account/worker dispatch counters idempotently at
this handoff, or at final RPC settlement if no handoff arrives. Provider tickets
remain entirely worker-owned. A backlog for one provider consequently does not
retain all ordinary dispatch slots and prevent a free provider from being reached.

The original RPC continues to carry its stream, result, execution deadlines and
errors. `activeRequests` still counts that full lifetime, including admitted
waiters; it is not a provider utilization metric. Existing byte/rate quotas,
coordinator pending/publication limits and disconnect handling remain in force.
This adds no prompt store, detached response buffer or second request registry:
pending RPC state is proportional to the currently outstanding operations, and
final settlement removes it. This handoff acknowledges durable operation metadata,
not exactly-once execution or a new durable copy of the input. Canonical input and
recovery rules described below remain authoritative.

The request envelope opts into this acknowledgment explicitly. Older workers
strip that envelope field and keep the conservative full-lifetime dispatch count;
new workers talking to older servers do not emit the extended strict event shape.
Coordinated Node relays preserve the private event across the authenticated hop.
The limiter consumes it before domain chat/task event handlers, even for requests
without a domain stream handler. Late or duplicate acknowledgments cannot release
a different request's counter or decrement a settled request twice.

Native patch `0050` extends the same worker lifetime keeper with a versioned
admission journal. The exclusive keeper is its only writer, so a retired Node
generation cannot race journal updates from a replacement generation. The journal
stores provider/worker/runtime and canonical command/message identities, FIFO
ordinals, durable grant evidence, and settlement metadata. It stores no prompts,
titles, credentials, or encrypted prompt copies.

An enqueue is durable before it can compete for a grant. The worker installs its
capacity reservation synchronously, then requires the journal's durable grant
acknowledgement before resolving the execution lease. An asynchronous write at the
queue head cannot let newer work bypass it. Cancellation before the acknowledgement
removes the waiter/reservation and prevents its late acknowledgement from starting
work. Explicit resumes persist a new ordinal at the tail. Never-granted records
are distinguishable from potentially executed work; a granted record is not proof
of actual execution or safe replay.

Metadata mutations from one burst are batched (at most 32, with bounded encoded
frames) into one atomic, flushed snapshot write. Each mutation receives its own
result, and every granted lease still waits for durable acknowledgement. Writes
occur at admission transitions rather than streamed tokens. The native ownership
watcher filters identifiable journal/temp-file mutations to avoid waking every
runtime for metadata writes.
Conclusive completion/failure history retains the latest 512 records. Unstarted,
cancelled, and runtime-exit records remain for canonical reconciliation; losing an
observer is not evidence that its accepted prompt was cancelled. Shutdown drains
metadata delivery before releasing keeper ownership. Prior-generation snapshots
are available to worker recovery without creating another prompt-delivery queue.

Patch `0052` lets the current native keeper atomically adopt previous-generation
records into a replacement ticket. It checks the captured generation/revision,
positive no-start evidence, and stable canonical chat/message identity. Adoption
preserves the oldest ordinal on the same provider; a provider change keeps the
destination ticket's new ordinal. Multiple unstarted physical attempts for one
canonical input become one restored waiter. The replacement is durable before
old records disappear, including across another crash or an unobserved reply.
Large groups are adopted in bounded frames, oldest same-provider ordinal first;
the replacement remains waiting until every required adoption acknowledges.
Resolved canonical records have a separately fenced, idempotent acknowledgement.

Worker recovery now reconciles recorded unstarted managed GUI queue claims through
the authenticated server. Native ownership takeover fences surviving execution
first. Only providers with unresolved initial eligible records hold new grants;
native startup and other providers can proceed. Verified pending inputs reserve
their restored order until the existing canonical dispatcher delivers them. They
appear in queue counts/positions and do not hold active inference capacity. Each
replacement must durably adopt its order before its grant can resolve.

Both servers atomically distinguish command transport loss from model/native
completion when closing a GUI attempt. That marker alone authorizes no replay.
Combined with exact previous-generation journal no-start evidence, it allows the
original unconsumed canonical input to recover after the server already closed
the lost attempt. User cancellation, consumed input, native terminal evidence,
and later activations remain fenced. Completion callbacks re-read their logical
root under the chat lock so a late callback cannot undo committed recovery.

The server uses existing queue eligibility: pause, archive, freeze, pending
permission/handoff, moved worker, rejected revision, and another head input cannot
leave an ineligible restored position blocking other chats. Queue revisions notify
current and former recovery workers, including after archive removes the normal
execution context. Actual disconnected former owners reconcile on reconnect;
timeouts and other delivery failures retain the existing durable notice.
Recovery uses bounded concurrent metadata requests and retries actual failures,
not an idle polling loop. No prompt content is copied into the journal.

This is recovery of proven unstarted managed GUI inputs, not permission to replay
potentially executed work. Granted/resumed execution still needs its canonical
native checkpoint/terminal lifecycle. Autonomous Task Goal recovery, current-generation
abandoned preparations, the remaining execution/wait accounting, and the
final bounded runtime/controller audit remain separate unfinished goal work.

## Canonical submission and transport backpressure

New user submissions to IDE and standalone Chats enter the existing encrypted
canonical queue even when the chat is idle. The queue retains the client's original message,
attachments, model selection, and subagent settings before dispatch; it is not a
second worker prompt store. Only the next eligible item acquires a queue claim
and competes for a provider ticket. GUI goal prompts default to the normal
`turn/start` path so first-message naming and goal initialization keep the same
lifecycle. Explicit native queue actions retain their selected execution method.

Both server command limiters mark a rejection as **not dispatched** only at their
actual admission failure before invoking the delegate. Byte-limit failures while
receiving events or responses do not carry that proof. For an accepted GUI start
with a matching canonical claim, the server transaction can close that exact
unused activation, mark the old logical receipt complete, and return the original
queue item to pending. A new claim receives its own physical operation identity.
Removed items stay removed, and deferral does not create an unread completion.
Rebuilding a first native thread excludes the current pending message ID from
its prior-history section, so retained input appears once. A preparation-stage transport rejection similarly
defers an unadmitted claim instead of permanently rejecting that prompt revision.
The existing durable queue delivery service retries; no provider semaphore or
second scheduling queue was added to the server.

This compensation does not infer safety from missing output, timeouts, or socket
loss. A dispatched, consumed, cancelled, superseded, or otherwise contradictory
native receipt is ineligible. Pre-dispatch telemetry shells close as cancelled
transport attempts with zero inference time, without failing a chat, starting a
goal cycle, spending its retry budget, or abandoning a live analytics record.
Worker queue waiting and execution-time accounting still require the final audit.

Standalone Chat uses the same canonical claims and native GUI receipts as IDE
chats. Input eligibility is separate from linked-terminal eligibility, which
remains restricted to project chats. Queue edits, cancellation, Stop/resume,
transport deferral, positive-no-start recovery and logical outcome recovery use
the existing authority. Standalone placement is its actual scratch-root identity,
including recovered outcomes; a nullable Git worktree cannot identify that root.
Only its claimed head input competes for worker provider capacity.

The server captures a standalone turn's selected route as intent, then commits
that route inside native admission after the input acquires its execution lane.
A competing input cannot overwrite a running chat's route during preparation.
A fresh native thread remains unbound until actual worker dispatch, preserving
initial encrypted-history seeding. Unbound worker preparation may reuse an
identified thread and runner only for the same canonical operation generation;
a different input must not append a freshly seeded history to an older thread.
The existing association journal stores that opaque key, without prompt content.
Known native threads keep their existing association. Standalone preparation uses
its conversation profile and does not subscribe to project Goal/history observers.

Task dispatch, durable edited-message retries, potentially executed native
recovery and current-generation abandoned preparations remain part of the wider
lifecycle integration. Ordinary transport admission still has its bounded
backpressure policy; only work actually admitted by a worker receives a provider
FIFO position.

## Configuration and live queue feedback

Provider setup and editing expose **Maximum concurrent inference**, defaulting
new providers to 8 and preserving the saved value when editing. Both the HTML
control and protocol accept positive integers up to PostgreSQL's integer bound.
The setting applies to every model, account, and project on each worker.

Workers publish coalesced `inference.status` notifications on admission changes.
A configuration handshake publishes an initial snapshot even when its revision
is unchanged. `GET /api/workers/:workerId/inference` returns a fresh,
owner-authorized snapshot through the worker control lane. Both servers validate
the server, owner, worker, actual authenticated process generation, and monotonic
revision before relaying a `worker-inference` Live status event. Coordinated Node
relays carry the authenticated continuity identity in their worker presence and
reject notifications from replaced relay connections. No prompt or title is
included in status metadata.

The UI obtains initial snapshots and reconciles reconnects through that endpoint.
Same-generation Live events directly update the query cache. A different generation
is confirmed with a fresh snapshot instead of trusting a delayed event; cancelled
fetches cannot overwrite newer Live data. Per-chat and per-provider selectors
avoid redrawing unrelated transcripts. Provider settings show utilization per
worker. Chat composers and Task overviews show one-based provider queue positions,
current utilization, and automatic-start wording without an ETA. Goal and Task
execution badges distinguish provider waiting from active inference. The existing
Stop/Cancel controls cancel eligible queued turns; later prompts remain in the
canonical chat queue and do not receive a provider queue position yet.

Operation purpose distinguishes the root turn and its naming from independent
children/helpers, so a queued child does not falsely label an actively sampling
parent as queued. Status delivery retains only the latest snapshot during socket
congestion, with a retry timer only while an actual connected write is blocked;
there is no capacity polling or idle update loop. Reconnect obtains a fresh
snapshot instead of replaying status from a previous authenticated binding.

The remaining milestones must complete durable pending-operation/order recovery, Task
transport backpressure recovery, provider deletion/route-change and
archival cancellation, execution-versus-wait accounting, bounded operation history, and the exhaustive
inference-path/lifecycle audit. This intermediate implementation is not the
completed feature; source integration is not evidence of exercised runtime behavior.

Local review is restricted to source inspection, formatting, and diff checks by
the goal's explicit no-testing instruction. Runtime behavior remains unexecuted.

## Failed attempts and route transitions

Both servers require worker execution evidence before automatically replaying a
non-GUI `chat.turn` on another route. Error text and absent streamed activity
still classify the eligible failure, but cannot prove that an input did not run.
An observer timeout or disconnect carries no execution proof. Managed GUI turns
retain their canonical accepted-input requirement; this metadata does not replace
that input authority. Existing account-switch policy remains in force.

Native patch `0062` observes errors and output at the real model-stream boundary,
before Core/tool consumption, across every sequential request in one physical
scope. Metadata is excluded; any output or completed model request prevents
failure-before-output proof for that scope. The private finish notification
reports the flag only after existing transport ownership settles. The worker
requires its exact runtime, thread, turn and scope match. A rejected native start
cannot settle an operation that already entered the private Core boundary.

A typed worker response distinguishes input never forwarded from a settled model
failure before output. The former also covers positively unforwarded preparation
failures before a runtime exists. Neither disposition is inferred from a missing
turn-start event. The failure proof is bound to the actual root chat, message and
provider, and the correlated response request. Encrypted Task error redaction and
authenticated server coordination retain only these opaque identities; prompt or
credential content is not added to the wire. Per-execution error carriers avoid
sharing one chat's proof through a cached startup rejection. Their metadata has
the error's garbage-collected lifetime rather than a completed-error registry.

The SDK also requires every preceding whole-input attempt to have positive proof
before its overload or invalid-compaction retry. A later unstarted failure cannot
make an earlier uncertain attempt safe to repeat. It waits for actual ticket
settlement before propagating evidence or starting another attempt. Cancellation
does not mint replay evidence. Older native runtimes without the optional private
flag cannot provide model failure-before-output proof; ambiguity is preserved.

This is local dispatch/output evidence, not exactly-once provider execution. It
does not clear canonical Task receipts, replay historical tools, replace native
checkpoint recovery, or change a durable outcome's physical-attempt authority.
Task Goal kickoff/resume, current-generation abandoned preparation, checkpoint
reconciliation and canonical timing integration remain separate required work.

Source acceptance review for this increment: a quota/model failure before any
output can retain proof through worker settlement and protected Task redaction;
a tool/output event followed by a later failure cannot. A server timeout, stale
scope finish, uncertain earlier SDK attempt or cancelled owner cannot authorize
replay. A real pre-forward preparation rejection can report unforwarded input.
Neither case grants capacity on the server or releases an unsettled ticket. No
tests, builds, benchmarks or computer-use validation were run for this increment.

## Task outcome attempt ownership

A scheduled Task's durable `chat.turn.outcome` echoes the opaque operation ID
from the actual dispatched input receipt. Multiple physical route attempts may
share a chat, original user message, lane ID and Task dispatch lease, so those
logical identities alone cannot identify a replacement's outcome. The worker
adds no prompt or model output to this correlation field.

Both server implementations key Task outcome delay/settlement suppression by
that exact receipt ID. A normally observed result or safe route failover settles
only its own recovery key. An earlier attempt cannot cancel a replacement's
recovery timer or suppress its result during the retention interval. Existing
non-receipt outcomes retain their logical recovery key.

A timer is only observation coordination. The actual Task complete/fail write
locks the canonical owner and dispatch cycle, then requires the same current
receipt and a non-deferred input in that transaction. Receipt replacement/defer
takes those same ownership locks. An old or revoked outcome therefore cannot
settle replacement work after the timer expires or after a server restart. A
matching completed round retains existing idempotent recovery so a crash after
its round write can still finish message publication and Goal launch. An
unscoped older-worker outcome is accepted only for a legacy round without
receipt metadata. Other canonical write paths retain their existing explicit
dispatch authority.

Source acceptance review covers a delayed predecessor after replacement,
cancellation of one attempt's timer while another remains pending, a deferred
receipt, a duplicate outcome after completion, legacy receipt-less rounds, and
a current matching receipt. This increment neither grants/releases provider
capacity nor makes ambiguous input replayable. Task Goal/checkpoint ownership
and pending-input outcome recovery remain separate required work. Source review,
direct formatting, mechanical protocol export and diff checks were used; tests,
builds, benchmarks and computer-use validation were not run.

## Terminal pending-input failures

An enforced input that was never forwarded can be recovered after transport
loss. A positive worker setup/start rejection is different: it must follow the
Task's normal failure/retry policy rather than repeatedly returning to the same
canonical capacity queue with its attempt count restored. Both servers record
that distinction as optional `failedBeforeDispatch` metadata on the existing
round receipt. Older records without the field behave as false; no new prompt
store or table is introduced.

The observation requires the actual correlated worker failure with
`input-not-dispatched` evidence and the exact operation, chat, message, provider
and worker identities. It locks the owner, latest dispatch cycle and canonical
placement/round before recording the marker. A replaced, deferred, archived or
completed input cannot be changed by an old failure. Matching current authority
or its single committed expiry fence may record the observation; delayed
heartbeats, error text and absent UI activity cannot manufacture it.

The marker commits before lease-sensitive failure settlement. A later stale
lease error or a crash before the Task failure write cannot erase the positive
observation. Expiry recovery revisits these unfinished terminal records to finish
normal fenced failure settlement, including records with an earlier dispatch
acknowledgement or uncertain predecessor. It does not requeue them or declare
previous inference safe. Settled rounds leave that recovery selection.

Marked receipts reject further input dispatch, pending-input deferral and
no-start journal adoption. A freshly authorized Task attempt gets its own
receipt and clears only its new marker; the same terminal cycle/fence cannot
reset it by preparing again. Normal route failover still happens
before terminal Task settlement and uses the existing output/input proof rules.

Worker durable failure outcomes carry the same typed opaque proof through the
existing authenticated notification path. Both servers record it before lane
observation/heartbeat checks, so a lost normal response or an expired observer
does not discard a valid terminal observation. Current-worker and previous-worker
provider ticket settlement remain worker/native responsibilities. This metadata
never frees a ticket or authorizes original-prompt replay.

Source acceptance review covers a real unforwarded setup failure, an observer
timeout without proof, a late predecessor after receipt replacement, expiry
between response and failure settlement, a crash after recording the marker,
and a fresh authorized retry. Existing cancellation exclusions in worker proof
production remain in place. Task Goal/checkpoint ownership, abandoned preparation
without a terminal observation, canonical timing integration and the final
inference-path audit remain required. No tests, builds, benchmarks or computer-use
validation were run; runtime behavior remains unverified.

## Explicit Task Goal input ownership

Explicit Goal kickoff and resume messages use the existing Task dispatch cycle's
nullable `goal_input` metadata (migration `0254`). Their receipt has optional
`kind: "goal"`; ordinary round receipts keep that field absent. The metadata
references the original encrypted `chat_messages` row, approved finalizer, actual
route attempt, dispatch fence and exact lane activation. It never rewrites the
completed finalizer's user-message identity or stores another prompt body.

Both servers prepare that receipt before sending `chat.turn`. The existing worker
accepted and pre-native-dispatch acknowledgments enforce the same input authority
as round inputs. A Goal receipt is valid only for its matching protected Goal
message and encrypted Task-message result mode. Positive terminal no-input
failures, sticky earlier dispatch evidence and exact attempt correlation retain
the round path's conservative rules.

Proven pending recovery revokes the old input authority, finishes only its
captured lane activation, advances the fence and returns the same dispatch cycle
to queued or paused. Claiming this deferred Goal input does not increment the
already-used finalization attempt. Recovery reads the original encrypted message
and submits it under a new receipt without rerunning finalization, setting the
Goal objective again, or inventing a new Resume message. Native status activation
restores a paused Goal without resetting it or starting a competing kickoff.
Explicit Resume can
unpause this pending input without taking over its still-owned attempt. Logical
pending-message lookup does not require the obsolete lane activation to survive;
actual dispatch still validates the new worker, placement and active lane.

Native patch `0063` preserves the optional kind in the private keeper journal and
requires it to match during adoption. An old round record cannot be adopted as a
Goal input. Omitting the field for rounds preserves their existing serialized
identity. Existing native no-start proof and same-provider FIFO adoption remain
required; lease expiry or the new server metadata cannot release provider capacity.

Durable Goal input outcomes have their own transaction instead of looking up the
finalizer by its unrelated user message. Protected response persistence, runtime
association and lane settlement require the current exact receipt, dispatch
owner/fence, placement and lane activation. The canonical response key is checked.
A first Goal response never marks the continuing Goal dispatch succeeded. Native
Goal observation performs the existing Task projection/dispatch reconciliation;
its Task-state, pause and retry writes now carry that same input authority.
Duplicate failure observations use the physical input ID as their retry key.
Captured heartbeat callbacks cannot clear a replacement lease's retention timer.
Ordinary captured turn completion also fences its lane activation.

Source acceptance review traces an unforwarded kickoff, deferred Resume, paused
input, released/reused old lane, replacement receipt, duplicate protected outcome,
late old outcome and crash after history commit before Goal projection. The code
keeps completed finalization results idempotent and never uses them as evidence
that the Goal input itself executed. Node and Rust paths share these boundaries.
Direct formatting, mechanical protocol export and `git diff --check` were used;
tests, typechecks, builds, benchmarks, native execution and computer-use validation
were not run. Runtime behavior is unverified.

Autonomous checkpoint/terminal reconciliation, current-generation abandoned
preparation, precise physical cancellation of revoked inputs, the remaining
canonical timing/lifecycle integration, bounded-runtime audit and exhaustive
inference-path acceptance remain required for the full goal.

## Goal setup callback ownership

A claimed Goal launcher captures the existing dispatch lease, prior Goal input
identity (including absence or a deferred input), and chat placement revision
before asynchronous setup. The snapshot contains no prompt and grants no provider
capacity. Goal startup completion/failure and captured worktree-continuation
projections validate that authority inside their actual database transactions.
They also require the same approved finalizer/planning ordinal, current Goal
phase, and an eligible non-archived, unpaused chat/project.

Replacing the lease, preparing a new Goal input, moving the chat, pausing it, or
starting a newer planning operation makes an old setup callback stale. The
launcher then retires quietly. Once the next input is prepared, its own receipt
and controller handle terminal outcomes; an older setup failure cannot mark that
input's Task failed or spend its retry budget. A valid setup failure still follows
normal failure/retry policy. Dispatch failure and retry accounting use the same
guard and stable dispatch key; an earlier heartbeat is not write authority.
Repository validation accepts the worker's bounded startup failure categories
(including connection, timeout and capacity), preserving their actual retry
classification instead of rejecting every protected failure except generic
`task-goal-start-failed`. The finalizer's precomputed generic fallback is unchanged.

Goal heartbeat retention waits for its actual database heartbeat acknowledgment
before replacing a timer. At installation it preserves any already-retained
newer fence, and duplicate acknowledgments keep one timer. Captured setup,
continuation, terminal reconciliation and project-pause callbacks release only
their exact lease's timer. A delayed old acknowledgment, failure, or pause receipt
cannot remove or overwrite a newer lease's retention. These timers retain Task
dispatch ownership; they never release worker/provider inference tickets.

Source acceptance review covers replacement during Goal setup, a new input under
the same dispatch lease, changed placement/planning/pause intent, a current real
setup failure, duplicate failure accounting, and reversed heartbeat-acknowledgment
order. Both Node and Rust use the canonical cycle/Task/message authority and
existing retention maps. Direct formatting and `git diff --check` were used; no
tests, typechecks, builds, benchmarks, native execution or computer-use validation
ran. No protocol or migration change was needed. Runtime behavior is unverified.

Unscheduled Goal launch authority, recovered-finalizer Goal dispatch ownership,
autonomous checkpoint recovery and the remaining lifecycle/accounting/bounded
state audit still require completion as part of the full goal.

## Recovered finalization to Goal startup

A receipt-bearing finalization outcome with a saved Goal now enters its own
canonical recovery transaction before the generic lane-active outcome path.
Finalizer completion is an intermediate phase: recovery must not mark the Task
dispatch succeeded and then launch a Goal without its lease.

Both servers lock the actual owner/current dispatch, original round receipt,
project/chat, Task phase and exact lane activation. They validate the worker,
original input, placement and protected result against that authority. The
transaction uses the existing Task completion writer, persists the protected
assistant message, fills any missing finalizer execution association, updates its
runtime and settles only that lane activation. Pending interactions belonging to
the ended lane are interrupted in the same transaction.

It then returns the same dispatch cycle to queued (or paused when current intent
requires it), advances its fence, clears the old lease and completed-turn ID, and
preserves its FIFO age and selected placement/configuration metadata. The next
ordinary claim continues the finalization attempt; recovery compensates its claim
count once so this transition alone does not charge another attempt. No retry
record, extra Goal cycle, second prompt queue or provider reservation is created.

The existing scheduler finds the already-completed finalizer result and runs
Goal setup under a fresh owned lease, scheduled completion hooks and explicit
Goal input receipt. It does not rerun finalization. The Goal input joins the
worker/provider queue normally; that original finalizer's provider reservation
was settled by the worker, not by this server transaction.

An inactive lane with the same captured activation remains eligible, covering a
crash after live lane settlement but before Goal kickoff. Missing late execution
association does not lose a result: recovery locates the round through the exact
dispatch/receipt rather than relying on that unfinished callback's message index.
A replaced activation, changed dispatch, cancelled/archived Task or newer planning
operation cannot be retired by the old outcome. If implementation or its Goal
input is already owned, the old finalizer outcome does not reset or relaunch it.
An old live launcher losing to this committed transition retires quietly.

Source acceptance review covers delivery before execution association, a
previously settled lane, a crash between round/history writes, a crash after
commit before wakeup/publication, duplicate outcomes, a live launcher winning
first, pause during recovery, and the next claim's attempt count/FIFO behavior.
The canonical transaction either commits all recovery state or rolls back; queue
startup can recover it without another worker result. Direct formatting and
`git diff --check` were used. No tests, typechecks, builds, benchmarks, native/helper
execution, computer-use testing or hosted validation ran. Runtime behavior is
unverified. No migration or protocol regeneration was required.

Unscheduled/legacy Goal launch authority, outcomes without current receipts,
autonomous checkpoint recovery, preparation-stage failure classification, and the
remaining lifecycle/accounting/bounded-state audit remain part of the full goal.

### Goal startup preparation failures

The ordinary claimed-operation failure handler treats an existing encrypted
round result as a completed operation. For a finalized Task awaiting Goal startup,
that result is an intermediate phase. A context/model preparation failure must
not mark the dispatch successful before implementation begins.

Both servers now capture cached-finalizer preparation authority before resolving
context or model routes. This uses the actual canonical lease, finalizer result,
placement revision, prior Goal input and implementation-start timestamp under the
existing owner/cycle/project locks. An unfinished finalizer retains its existing
input failure handling. A Goal input already owned by execution cannot be failed
by this read-only preparation path.

Preparation failures use the existing Goal startup failure writer and bounded,
classified automatic-retry ledger, preserving the finalized plan. They do not
settle the dispatch as successful, replay finalization, manufacture no-dispatch
proof or free a provider ticket. Configuration failures and timeouts retain the
existing category-specific retry behavior. A deferred Goal input remains on its
canonical dispatch for the established retry/resume path.

Every failure write revalidates its captured authority. A new input receipt,
implementation-start transition, replacement lease/placement, pause or archive
invalidates the old preparation failure. Normal Goal launch retains its own
launch guard because that path can legitimately advance implementation before
its input is prepared; it cannot reuse the narrower read-only preparation guard.

Source acceptance review covered missing/unavailable model routes, context
resolution failure/timeout, ordinary unfinished finalizers, deferred Goal input,
new input/implementation winning the race, pause/archive/replacement, failure
persistence and retry settlement. Direct formatting and `git diff --check` were
used. No tests, typechecks, builds, benchmarks, native/helper execution,
computer-use testing or hosted validation ran; runtime behavior is unverified.
No persisted schema or transported protocol field changed.

The full goal still requires the unscheduled/legacy authority, autonomous
checkpoint recovery, abandoned preparation and final lifecycle/accounting audits.

### Expired Task round ownership and terminal recovery

A dispatch lease is server mutation authority, not evidence that native
execution has ended. Scheduler expiry now revokes that authority and leaves
uncertain execution for outcome/checkpoint reconciliation. It does not turn a
missing heartbeat into a failed Task or an automatic whole-input retry. Proven
unstarted input still uses its existing durable deferral. The expiry-only failure
path requires the worker's authenticated `failedBeforeDispatch` marker, no prior
dispatched attempt, the exact receipt/expired cycle, and the same live Task round;
Goal inputs, archived/replaced work and missing evidence cannot use it.

Current receipt-bearing direct, planning and finalization outcomes now share a
transactional round-recovery writer in both servers. Its private `outcome` guard
accepts the exact original owner/fence while that cycle remains claimed/running,
including a deadline that elapsed before the scheduler observed it. It also
accepts precisely one committed expiry increment on that same latest cycle.
The guard matches the saved, non-deferred input and its original dispatch.
Cancellation, requeue, replacement receipts, later claims and newer cycles
invalidate it. This guard authorizes terminal persistence only; it is never used
for a launch, heartbeat, provider grant or provider release.

The transaction additionally checks worker, input message, project placement,
Task round/phase and exact lane activation. It uses the existing completion and
failure writers, protected message idempotency, retry policies and lane ownership.
It repairs missed execution association, saves known native thread/turn IDs,
interrupts the ended lane's pending interactions, and settles the exact dispatch.
Successful non-finalization clears pending retry state; failures record the
bounded category under the original physical dispatch key. A contradictory
failed redelivery cannot erase an already-completed round.

Completed finalization remains intermediate work: the same cycle returns to
queued/paused Goal startup, preserving FIFO age and compensating its claim count.
The next scheduler claim uses the completed result rather than rerunning it.
Already-owned Goal input or implementation cannot be reset by its old finalizer.
A missing Goal objective is left to the real startup failure path, rather than
being hidden by a prerequisite check.

Source acceptance review covered outcomes before expiry observation, outcomes
following its single fence increment, inactive-but-identical lanes, missed
association, duplicate/contradictory delivery, newer claims/inputs/placements,
protected-result failure, retry settlement, and finalizer-to-Goal startup. The
transaction commits history, Task, retry and lane/dispatch changes together.
No provider ticket is inferred free from any of these server states.

Task HTTP admission was also traced: start/plan/continue/finalize/retry routes
already delegate to the canonical dispatch queue in both servers. The old Node
`beginEncryptedTaskOperation` function has no callers and is not a current
execution bypass. Legacy outcomes lacking current input receipts still need
separate authority reconciliation; they are not evidence of a live direct route.

Direct formatting and `git diff --check` were used. No tests, typechecks, builds,
benchmarks, native/helper execution, computer-use testing or hosted validation
ran. Runtime behavior remains unverified. No persisted schema or transported
protocol fields changed. Expired Goal-input projection, autonomous checkpoint
recovery, current-generation abandoned preparations, ambiguous transport-failure
callbacks and the final timing/bounded-state/entry-point audit remain required.

### Goal input terminal recovery after lease expiry

The continuing Goal and the physical input that started/resumed it have separate
settlement. Both servers now persist bounded terminal metadata on that existing
Goal input: outcome category, observed native thread/turn when known, observation
time and projection completion time. The protected response and marker commit
through the existing message/dispatch writers. No prompt body is copied into a
second queue and the original receipt is not rewritten as a new execution.

The internal terminal-persistence guard now supports Goal inputs. It requires the
same latest dispatch, exact original input/dispatch identity, worker/placement and
lane activation. The original control token/owner can save history after a normal
pause or terminal dispatch settlement; one committed lease expiry is also
recognized. Cancellation, defer/requeue, newer control claims, replaced inputs,
changed placement/lane activation and archival revoke that authority. It grants
no inference, renews no lease and releases no worker ticket.

Worker outcome notifications record the protected response/terminal marker
without prematurely finishing an ordinary live RPC's lane. That preserves its
normal queued-message continuation. Goal metadata projection uses a distinct
recovery key, so successful live RPC completion cannot suppress it. A failed
initial database write retains the actual notification's delayed recovery
attempt. This is not a new notification acknowledgement/delivery guarantee; the
existing worker transport's delivery and restart limits still need the final
lifecycle audit.

Projection performs an actual native Goal and execution read. An old dispatched
turn error cannot relabel a Goal which has since continued. Only a positively
proven unforwarded startup failure can supply startup failure context, and a
currently running native execution overrides that captured failure. Missing Goal
metadata alone is not failure. The exact receipt, native thread, lane activation
and Task row revision fence the subsequent write. Captured placement revision,
Chat/project pause flags and native thread are checked again during projection
and dispatch settlement; stale observations are discarded.
Actual terminal Goal state, retry classification/clearing, dispatch settlement and
projection completion then commit under that authority. A metadata RPC failure
leaves the terminal marker pending instead of failing inference or spending a
retry. No new model turn or objective is started by projection.

The existing retained-Task recovery loop also visits paused dispatches and consumes
pending terminal markers before checkpoint/resume work. A crash after the marker
or Task projection can therefore finish this metadata transition without another
worker notification. Explicit Resume reloads current state after projection and
keeps the user's intent. A cancelled, proven unforwarded input under pause intent
returns its original protected message to the existing paused dispatch; it is not
left owned by an ended controller and is not replaced with a new Resume prompt.

Source acceptance review traced normal live completion versus delayed outcome,
late arrival after lease expiry, duplicate/conflicting receipts, protected-result
failure, crash between recording/projection/dispatch settlement, failed metadata
reads, newer native/input/lane ownership, pause before forwarding and explicit
Resume racing passive projection. Node and Rust use the same phases and fences.
Direct formatting and `git diff --check` were used. No tests, typechecks, builds,
benchmarks, native/helper execution, computer-use testing or hosted validation
ran; runtime behavior is unverified. These are internal JSON metadata/type
changes, with no persisted column migration or transported protocol fields.

The full goal still requires autonomous checkpoint/control authority, legacy
observation authority, current-generation abandoned preparations, transport/outcome
delivery and restart reconciliation, and the final timing/bounded-state/inference
entry-point audit. This milestone does not claim those paths complete.

### Passive Task Goal observation ownership

Legacy/passive Goal reads now capture an ephemeral server-owned observation
snapshot before the native RPC in both servers. This is read/projection authority,
not a provider ticket, dispatch lease or input receipt. It cannot launch a turn,
renew a lease, replay a prompt or reclaim inference capacity. It adds no protocol
fields, durable prompt state, polling or completed-operation registry.

The snapshot binds the actual Task revision, project/Chat identity, placement and
Stop revisions, actual active worktree worker/path, Chat status and pause intent,
project pause intent, active lane activation, runtime session/thread/route/account,
latest dispatch identity and
control token/state/owner, and the current Goal input identity/deferred flag. A
read must target either the current native runtime or the latest dispatch's
retained worker/worktree/thread affinity. Retained-session recovery can still
observe its saved worktree before restoring active placement.

The server releases all database locks before the RPC. It checks the snapshot
again under the existing owner/project/Chat locks in the transaction that writes
the encrypted Task projection. Lease heartbeat timestamps and observation timing
are excluded: an ordinary heartbeat cannot invalidate a read or prove execution
settlement. Actual ownership changes, lane reactivation, pause/Stop, archival,
Task edits/deletion, input deferral and replacement dispatches invalidate it.

Missing-Goal and observation-only responses also validate their snapshot before
returning, so an older no-Goal response cannot authorize repair for a changed
session. A lost Task CAS discards the entire native result; neither server pairs
old native metadata with an independently refreshed Task. Explicit message and
activation reads retain their existing mutation/dispatch authority and also no
longer hide a stale Task CAS. The existing passive reconciliation loop quietly
discards this expected observation conflict and can retry on its normal cadence.
Actual metadata/transport errors retain their existing reporting. Physical
control re-fencing remains part of the continuing lifecycle audit.

Source review covered current/retained affinity, ownership changes during RPC,
Task CAS races, missing Goal metadata, observation-only reads, ordinary lease
heartbeats, and both server implementations. Direct formatting and
`git diff --check` passed; runtime behavior is unverified.
No tests, typechecks, builds, benchmarks, native/helper execution, computer-use
testing or hosted validation ran. Autonomous checkpoint/control recovery,
abandoned input cancellation, terminal delivery/restart reconciliation and final
timing/bounded-state/inference-entry audits remain required for the full goal.

### Retained Goal control takeover conditions

A passive Goal read carries its private observation scope into retained-Goal
control recovery. The encrypted Task projection can advance only that scope's
Task revision to the exact revision it committed; it does not fetch newer
ownership and attach the older native result to it. Missing-Goal and read-only
results keep the original scope. The private field stays inside the server:
HTTP Goal/Task responses continue selecting their existing public fields.

Both servers validate that scope in the actual `recoverStartedGoal` transaction,
before changing its dispatch control token or lease. The recovery operation
retains all its existing authorization and native-affinity requirements; the
observation is an additional condition, never independent permission to launch
inference or grant a provider ticket. The dispatch state, lease owner, physical
worker, route and account must still match the captured dispatch, alongside its
existing exact operation/token/worktree/thread checks. Normal heartbeat timing
remains excluded from observation identity.

A canonical unforwarded Goal input retains its own authority. A recorded terminal
input waiting for projection must finish that projection before control takeover.
Observation snapshots include input dispatch/terminal progress so these changes
cannot silently race the read. The original physical input receipt is not
rewritten to claim that a newer control token executed that input.

Explicit Resume discards a cached paused observation after it unpauses the Chat,
reloads the Task, and obtains a fresh native observation under the new intent.
It does not reuse the previous paused projection to take control. Other callers
of retained control recovery retain their existing launch guards and also
validate the exact captured dispatch state/owner/route.

Source review covered a Task/placement/Stop/pause/lane/runtime/dispatch change
between native read and takeover, heartbeat-only changes, terminal projection
ordering, and explicit unpause in both servers. Direct formatting and
`git diff --check` passed. No tests, typechecks, builds,
benchmarks, native/helper execution, computer-use testing or hosted validation
ran; runtime behavior remains unverified. This adds no migration, transported
contract, semaphore or prompt queue.

The full goal still requires autonomous native checkpoint reconciliation, late
physical-input outcomes across control replacement, abandoned-input cancellation,
terminal delivery/restart recovery, and the final timing/bounded-state/entry-point
audit. These changes fence a server control takeover; they do not claim that
a native checkpoint alone has been durably reconciled.

### Physical Goal outcomes after control recovery

The retained Goal's control token can advance while the original physical input
is still finishing. Both servers now distinguish those authorities. Saving the
same retained input's protected response and terminal marker validates its full
original receipt against the latest cycle's canonical, nondeferred Goal input,
plus the existing message, planning, placement and lane checks. It does not
require that the original input's token still owns Goal control. The receipt is
not rewritten and cannot claim that the recovered owner performed that input.

An outcome from an older control owner records history/terminal metadata only.
It cannot update runtime placement, finish lanes or interactions, or defer input
under the newer control token. Ordinary same-owner completion and positively
unforwarded pause cancellation retain their existing behavior. The live hook can
still locate its original retained receipt after control recovery; it does not
thereby gain permission to launch or replay work.

Pending terminal projection independently captures the actual current control
state, token and nullable owner. Its guard still binds the original input, exact
terminal observation, placement revision, pause flags, native thread and Task
CAS. It checks the current control snapshot both when native Task metadata is
projected and when retry state/terminal dispatch/marker settlement is committed.
A second control recovery or a completed projection invalidates the older
projector. Ordinary heartbeat timestamps are not inference-settlement evidence
and do not change this identity.

Actual native Goal/execution state continues to control Task projection. An old
turn error cannot fail a continuing Goal. Fresh terminal Task metadata may close
only the receipt's exact lane activation after the execution observation reports
that it is not running. A positively confirmed pre-dispatch startup failure can
settle without an execution snapshot only when it never forwarded input and the
Task is already failed. Control timer cleanup uses the captured current owner
and token, rather than attempting to release a recovered owner's timer using the
old physical receipt. No server code grants or releases provider tickets.

Source review covered multiple control-token advances, expiry, pause, duplicate
terminal projectors, replacement/revoked receipts, live-hook lookup, missing
execution proof and actual native running/terminal state in both servers. Direct
formatting and `git diff --check` passed. No tests, typechecks, builds, benchmarks,
native/helper execution, computer-use testing or hosted validation ran; runtime
behavior remains unverified. No migration, transported contract or additional
prompt store is introduced.

This covers an unchanged canonical Goal input across control recovery. Outcomes
after that input is replaced, or after its placement/lane activation changes,
still require canonical historical receipt handling. Native checkpoint recovery,
abandoned-input cancellation, actual terminal delivery/restart reconciliation,
and final timing/bounded-state/entry-point audits remain part of the full goal.

### Historical Goal input receipt evidence

Migration `0256_task_goal_message_receipts` retains one bounded receipt-evidence
object on each canonical Goal input message. Its encrypted body stays in the
existing message field. There is no new prompt table, delivery queue, pending
operation scan, ticket registry, polling timer or semaphore. Receipt evidence
inherits the canonical message's retention/deletion lifetime and is omitted by
both public message mappers.

The migration deterministically backfills the latest still-recorded Goal input
for each canonical message. It does not manufacture receipts for pre-migration
inputs whose evidence had already been overwritten. The update trigger captures
every normal Goal input preparation/acceptance/dispatch/deferral/terminal write
from either server in the same database transaction. Initial cycle creation has
no Goal input; preparation updates it only after its canonical message exists.
The trigger intentionally does not run on cycle INSERT, preserving logical SQL
restore ordering. Current dumps carry message evidence themselves; older SQL
restores run the pending migration/backfill after loading their data.

A message which has already forwarded input cannot receive another physical
receipt identity. Rebinding requires an explicitly null canonical first-dispatched
identity. Recovering a previously forwarded attempt must first establish and
record the existing positive no-forwarding proof; missing evidence is insufficient.
The trigger does not decide that proof or grant execution. For the same receipt,
it preserves already-recorded terminal evidence and rejects conflicting terminal
status/category. Clearing or replacing the live dispatch slot does not delete
the older message's evidence.

Both servers use this evidence when a notification belongs to a replaced input,
an older cycle, or a placement/lane/Task state which no longer owns execution.
They validate the actual worker, original complete receipt/fence correlation,
canonical Goal message and acceptance/dispatch evidence before saving a protected
response with its existing idempotency key. A revoked or unsupported receipt
cannot replay input or relabel newer work. Duplicate protected responses retain
the existing exact-message checks.

This historical path updates only that message's receipt evidence and protected
response history. It does not project Task state, finish lanes/interactions,
resume work, wake Task scheduling, publish a completion boundary, unarchive the
Chat, change its status/recency, or release provider capacity. Ordinary outcome
recovery publishes a boundary only when it actually finished its exact lane.
Actual current-input terminal projection retains its separate current-control
and native-execution guards.

Archived Chats can retain these attributed assistant responses. A missing or
reactivated old lane is not permission to mutate it: historical insertion may
leave its lane link empty. The response uses its original physical worktree when
that owned record still exists, otherwise the canonical input's retained logical
worktree. No filesystem checkout is opened, recreated or treated as available.
Missing/deleted canonical messages do not get recreated from old notifications.

Source review covered phase/terminal writes in both servers, deterministic
backfill, logical restore ordering, forwarded-input identity protection,
replacement cycles, pause/archive, moved/missing/reactivated placements and lanes,
duplicate/conflicting results, message mapper field selection and notification
publication. Direct formatting and `git diff --check` passed; the migration and runtime
paths were not executed. No tests, typechecks, builds,
benchmarks, native/helper execution, computer-use testing or hosted validation
ran. Native checkpoint reconciliation, abandoned-input cancellation, actual
terminal delivery/restart recovery, and final timing/bounded-state/entry-point
audits remain required for the full goal.

## Reliable provider configuration delivery

Node and Rust servers coalesce saved catalog and limit updates by owner and
worker. Provider mutations return after scheduling delivery. An HTTP disconnect
does not abandon it. Each attempt reads the current saved catalog, sends the
actual worker command, and checks both catalog and per-provider limit revisions
in its acknowledgement. A later edit or reconnect wakes the same pending job;
it cannot launch a competing delivery for that owner/worker.

Only failed, pending delivery has a retry timer, backing off from one second to
at most sixty seconds. There is no idle polling or retained completed-job cache.
The first failure is logged; continued failures do not produce one warning per
retry. Owner-level fanout also retries if reading the worker list fails.
Authoritative worker deletion, unlinking, or ownership change retires pending
work. Connectivity status is never used as a preflight gate. An offline but
still enrolled worker receives an actual delivery attempt and retains pending
settings until delivery or retirement. Shutdown closes retry scheduling and
waits for bounded in-flight configuration requests; reconnect after server
restart reloads the durable configuration.

These jobs contain identifiers and settings only. They do not own tickets,
store prompts, or select which inference runs. Worker admission remains the
only authority for provider capacity. Source review, formatting and
`git diff --check` were performed; runtime retry and shutdown behavior remains
unverified under the user's prohibition on tests/builds/computer-use validation.

## Retirement of captured Goal outcome delivery

The commit endpoint can explicitly retire a pending result when its canonical
input message/project/chat has been deleted, or when that same canonical message
now carries a validated Goal receipt for a different input operation. Both
servers read that actual owner-scoped state under the existing history locks,
after trying normal protected-history persistence. The matching acknowledgement
identifies the delivery, original physical input and retirement reason. The
worker then removes the pending response file without retaining a tombstone.
This is retirement of publication authority, not proof of inference settlement;
it cannot free a ticket or authorize another execution.

Archive, pause, lease expiry, route changes, a missing terminal notification,
malformed or absent legacy receipt metadata, and transport/database errors do
not constitute replacement proof. Uncertain results remain pending. Results
whose original receipt is still valid continue through historical persistence,
including after archive or placement/control changes. An older server returning
only an uncommitted response cannot cause deletion. Files for an old authenticated
server/account scope are not submitted under a new scope.

Source review covered committed, deleted, replaced, archived, legacy/unknown and
conflicting receipts in both servers. Direct formatting, mechanical protocol
export and `git diff --check` ran. No tests, builds, typechecks, benchmarks,
migration execution, native execution or computer-use validation ran.

## Transactional Task round completion

Receipt-bearing live Task completions now use the same transaction as delayed
worker-outcome recovery in both servers. The transaction commits the protected
assistant message, Task/round metadata, retry bookkeeping, exact lane settlement,
dispatch transition and a bounded terminal receipt together. Publication follows
that commit. The callback receives its original input operation identity from
the turn runtime; it never substitutes a newer input or server claim.

The receipt contains monotonic authority already present on the round, native
thread/turn identifiers, observation/projection timestamps and a SHA-256 digest
of the validated outcome. The digest reuses the native history canonical JSON
encoding, so JSONB key reordering and Node/Rust delivery do not change identity.
A matching duplicate returns positive commit evidence before attempting current
dispatch mutation authority. It checks the original physical receipt and current
read authorization, then performs no Task/lane/dispatch/retry writes. Changed
outcome content, status or supplied native identity is rejected. No response or
prompt body is copied into this receipt. Migration 0259 validates new receipt
metadata while allowing existing inputs without it.

Completed finalization queues Goal startup on the same durable dispatch cycle.
The next scheduler claim uses the saved finalizer result and fresh authority;
the old completion callback does not launch the Goal again. Normal rounds settle
once. This keeps completion and recovery consistent without granting any server
control over provider tickets or changing worker physical-settlement rules.
Legacy callbacks without an input receipt retain their existing behavior.

Source review covered live/recovery races, duplicate completion after Task
advancement, conflicting outcomes, supplied/omitted turn IDs, finalizer startup,
archive/read authorization and rollback. Direct formatting, mechanical protocol
export and `git diff --check` were performed. Migration 0259 was not executed.
No tests, builds, typechecks, benchmarks, native execution or computer-use
validation ran. Captured non-Goal Task-round disk delivery and historical-input
retirement still require their integration; this terminal receipt makes a
committed response distinguishable from a transport acknowledgement.

## Captured Task round outcomes

The existing worker response outbox now captures receipt-bearing direct,
planning and finalization rounds as well as Goal inputs. Its legacy private
file/endpoint names are preserved so pending files remain discoverable. The
version-one envelope carries `inputKind`, defaulting to Goal for older files.
It persists the existing protected response before ordinary response publication
and captures the original server/account/worker scope at command admission.
There is no new prompt storage or input queue.

Round delivery uses the shared terminal transaction and acknowledges only its
positive, digest-matched commit evidence. A lost acknowledgement is idempotent,
including after finalization queued Goal startup or a Task advanced. The current
control snapshot is captured under the existing owner/round locks separately
from the original physical input receipt. Fresh control can project an actual
result for the unchanged input after pause/expiry/control takeover; it cannot
launch input, renew a lease or release provider capacity. Latest cycle, immutable
input, current Task/round, exact lane activation and placement checks still apply.
Cancellation, replacement inputs and newer cycles cannot be projected as current.

An archived or definitively superseded round can instead save its protected
assistant response and bounded `historyOnly` terminal evidence. This path never
changes Task, lane, dispatch, queue, retry, recency or native authority. A still
current but uncertain operation retains its worker file. Actual canonical
input/round deletion or a validated replacement receipt permits explicit
retirement. A failed, deferred input may also retire its negative result when
its exact worker receipt has positive no-forward evidence, all attempts were
enforced, and no attempt was ever dispatched; its canonical prompt remains queued
for Resume. The same negative-result retirement applies to Goal inputs.

Committed message publication uses the existing live service. Live publication
or follow-up failure cannot turn a committed response into a missing database
acknowledgement. Pending result files are removed only after a matching commit or
retirement receipt and retain no completed-file ledger. Migration 0260 validates
the optional historical marker and was not executed. Old servers that cannot
acknowledge the new envelope leave files pending until upgraded.

Source review covered live/recovery races, original versus current control,
matching/conflicting duplicates, pause/expiry/cancel, archive/new Task rounds,
receipt replacement, deleted inputs, no-forward deferral and lost acknowledgements.
Direct formatting, mechanical protocol export and `git diff --check` ran. No
tests, builds, typechecks, benchmarks, native execution, migration execution or
computer-use validation ran. Before-capture native checkpoint recovery, ordinary
Chat history coverage, canonical timing and bounded-runtime retention still need
the final goal audit; this milestone covers captured Task response delivery.
