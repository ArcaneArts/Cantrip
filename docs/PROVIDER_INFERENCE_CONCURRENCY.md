# Provider inference concurrency

Provider configuration stores `maxConcurrentInference` (positive PostgreSQL
integer, default 8) and `inferenceConfigRevision` (initially 0). The database
advances the revision atomically only when the limit changes. Mutation inputs
keep the limit optional so updates from older clients preserve it. Provider
summaries and resolved model runtimes carry the configuration through both the
Node and Rust server implementations.

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
turn IDs and terminal notifications settle tickets; a native rejection before
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
native checkpoint/terminal lifecycle. Standalone/Task recovery, current-generation
abandoned preparations, the remaining execution/wait accounting, and the
final bounded runtime/controller audit remain separate unfinished goal work.

## Canonical submission and transport backpressure

New user submissions to managed IDE chats enter the existing encrypted canonical
queue even when the chat is idle. The queue retains the client's original message,
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

This step covers managed IDE submission and transport admission. Standalone Chat,
Task dispatch, edited-message retries, and potentially executed native recovery must
still complete their existing canonical lifecycle integration. It does not yet
remove the ordinary RPC concurrency ceiling: a full transport retains inputs
for retry rather than claiming that they have entered a provider's FIFO queue.

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

The remaining milestones must complete durable pending-operation/order recovery, ordinary
transport backpressure recovery, provider deletion/route-change and
archival cancellation, execution-versus-wait accounting, bounded operation history, and the exhaustive
inference-path/lifecycle audit. This intermediate implementation is not the
completed feature; source integration is not evidence of exercised runtime behavior.

Local review is restricted to source inspection, formatting, and diff checks by
the goal's explicit no-testing instruction. Runtime behavior remains unexecuted.
