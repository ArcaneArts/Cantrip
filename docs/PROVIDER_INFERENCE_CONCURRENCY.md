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
without removing transport resource bounds or creating a second prompt queue.

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

This journal is the evidence layer for recovery. Canonical reconciliation,
redelivery of eligible pending work, the restored-order barrier, and acknowledgement
of old pending journal records remain to be integrated. Merely loading ordinals
is not yet complete FIFO recovery across a restart. In-memory runtime/controller
tombstones also still need the final bounded-lifecycle audit.

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
Task dispatch, edited-message retries, native recovery, and restart FIFO must
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
