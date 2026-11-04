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

The remaining milestones must complete durable pending-operation/order recovery, ordinary
transport backpressure recovery, provider deletion/route-change and
archival cancellation, app feedback, bounded operation history, and the exhaustive
inference-path/lifecycle audit. This intermediate implementation is not the
completed feature; source integration is not evidence of exercised runtime behavior.

Local review is restricted to source inspection, formatting, and diff checks by
the goal's explicit no-testing instruction. Runtime behavior remains unexecuted.
