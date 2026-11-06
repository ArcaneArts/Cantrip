# Provider inference concurrency

Cantrip workers enforce a shared FIFO inference limit for each configured provider.
The implementation spans provider settings, worker admission, managed native
execution, durable recovery, and queue feedback in Chats, IDE agents and Tasks.
This guide describes the resulting behavior and its source-review evidence.

No tests, builds, typechecks, benchmarks, migration execution, native patch
application/verification, helper/native execution or computer-use validation were
performed for this goal under the user's restriction. Source review, direct
formatting, mechanical protocol exports and `git diff --check` do not establish
runtime or platform qualification.

## Configuration and scope

Each provider exposes **Maximum concurrent inference**, defaulting to **8** for
existing and newly created providers. The UI and protocol accept positive integers
up to PostgreSQL's integer bound. An older client's update that omits the setting
preserves its saved value. A limit-only edit does not replace native sessions.

One `WorkerInferenceAdmission` belongs to a stable server/account/worker scope.
Its pool key is the configured provider ID. Models, provider accounts, projects,
Chats, Tasks and native runtime processes do not create additional pools. For
example, three tickets in Project A and two in Project B use five of that
worker's eight tickets. Another worker has its own eight; another provider has an
independent limit on either worker. CantripOS inference remains on its owning
worker, even when tools execute in the guest. This does not restore Task Worker
presets or their old scheduling limits.

Migration `0250_provider_inference_admission` installs the default, constraints
and atomic limit revision. Migration `0258_provider_inference_catalog` versions
provider membership and creation identity separately. Both servers read the
catalog and its revision in one MVCC statement, then deliver the saved catalog
on edits and authenticated worker connection. Runtime envelopes also carry the
configured provider identity and revisions.

Workers reject stale settings and membership. Legacy envelopes cannot reset a
known limit or resurrect a removed provider. Increasing the limit immediately
drains eligible FIFO waiters. Decreasing it lets holders finish and grants no new
ticket until usage is below the new limit. It never terminates work merely to
meet a lower setting.

Configuration delivery is coalesced by owner/worker in both servers. An actual
failed delivery retries with bounded backoff; a later edit or reconnect wakes the
same pending job. Success removes it. There is no idle configuration polling or
connectivity preflight. The server persists configuration and relays status; it
never chooses who receives a provider ticket.

## Ticket lifecycle and FIFO

A ticket covers one admitted turn/cycle or standalone inference operation,
including its sequential model requests and ordinary tool round trips. It is not
one ticket per streamed token, model request or entire Goal.

The worker lifecycle is `waiting` → `granted` → `running` → `released`.
Cancellation of running work enters `cancelling` and keeps capacity until actual
settlement. A confirmed non-inferencing boundary can enter `suspended`; resumption
rejoins FIFO before another model request. A native request parked before its
first grant retains its unresolved promise and also rejoins at the tail on Resume.

The worker reserves capacity synchronously before resolving a grant. An async
journal acknowledgement cannot let a newer arrival overtake the queue head.
Queue positions are one-based among eligible waiters and exclude current holders.
Durably recovered eligible work retains its actual ordinal. A new cycle or resumed
episode receives a fresh ordinal rather than inheriting an earlier turn's priority.

Operation identities are bound to canonical live sources and worker/runtime
generations. Redelivery under the same source is idempotent; changing its identity
is rejected. Closing a source prevents future use but does not declare a running
native operation settled. An old callback cannot release a replacement ticket.
Cancellation racing with a grant prevents the cancelled operation from starting.

User submissions remain in the existing encrypted canonical Chat queue, with
their original IDs, attachments, settings and queue-edit semantics. Only the next
executable item competes for provider capacity. Later messages waiting for their
current Chat turn have no provider position yet. There is no second prompt queue
or copied encrypted input store for the semaphore.

## Titles, helpers and autonomous cycles

A new Chat acquires its response provider's ticket, generates an enabled
same-provider title serially under that ticket, runs its response, then releases
after settlement. The label cannot borrow another operation's ticket or run
concurrently with the response. This avoids nested acquisition at a limit of one.

If labeling uses a different provider, that label first acquires and settles its
own provider ticket. Only then does the response enter its provider queue. No
response ticket is reserved while waiting for the label. Label failure keeps the
fallback title and allows the response to proceed unless its actual source was
cancelled, removed or superseded. A timeout does not release a still-running label.

Each later Chat turn, Task planning/finalization turn and Goal cycle acquires
again. Managed Goal input is admitted before native turn creation; private Task
Goals also gate actual native inference. Applied Goal setters awaiting their first
cycle retain their canonical first claim without resubmitting the objective.
Every continuation settles the previous ticket and rejoins behind existing work.
Waiting does not consume a Goal turn, empty-response allowance or Task retry.

Independently concurrent children and helpers acquire separately, including
Guardian requests, speculative compaction and memory extraction. Foreground
compaction within an admitted turn retains that turn's sequential ownership;
manual compaction has its own admitted lifecycle. Native hidden child sessions
inherit the connection-owned inference channel.

Parent waits for Tasks/children, code-mode waits, user interaction and approval
boundaries can suspend only when native Core confirms that sampling and retained
response resources have stopped. `task_wait`, native child waits and indefinite
user waits therefore need not keep all tickets while their dependencies queue.
Resuming inference reacquires through FIFO while preserving the same turn and tool
result. Ordinary tools retain the reservation. Silence or missing output is never
treated as a suspension boundary.

## Inference entry-point inventory

The supported worker paths below converge on the same service. These are source
integration findings, not executed acceptance results.

| Producer                                                              | Admission and settlement boundary                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary Chat and IDE GUI input                                       | Canonical claimed head input → managed native command session or `runTurn` → worker admission before forwarding.                                 |
| Queued prompts, edited retries and supported terminal/native input    | Existing native receipt and `ManagedExecutionRunner`; only the next eligible input competes. Steering an existing turn keeps that turn's ticket. |
| Task planning and finalization                                        | Canonical Task input receipt and original dispatch/control revision → `runTurn`; actual native settlement retains physical ownership.            |
| Explicit Task Goal kickoff                                            | Canonical Goal input receipt plus complete private Task configuration; initial turn and later native cycles pass the shared gate.                |
| Goal automatic continuation, including the first cycle after a setter | Managed outer admission before native turn creation, then exact private Core boundary; each later cycle obtains a fresh ticket.                  |
| Automatic titles and requested renames                                | `generatePrivateLabel` → `runLabelInference`; first-message same-provider naming instead uses the response reservation serially.                 |
| Generated Git text and summaries                                      | Repository agent command → `runAgentOperation`; each failover attempt settles before the next route starts.                                      |
| Provider connection check that invokes a model                        | `model.provider.test` → `runAgentOperation`; this is inference and consumes capacity. Catalog, credential and status reads do not.               |
| Native child agents and internal child sessions                       | Inherited connection-owned channel; actual child turn receives its own private ticket.                                                           |
| Manual/foreground/speculative compaction                              | Managed turn or independent private boundary as appropriate; speculative work cannot borrow the parent's reservation.                            |
| Guardian classification                                               | Explicit independent private boundary, retaining ownership through dispatch and response drain.                                                  |
| Memory extraction and consolidation                                   | Each parallel extraction is independently admitted; consolidation uses a real internal child session. Canonical job leases renew while waiting.  |
| Stateless `cantrip/inference` labeling                                | Already-admitted standalone/compound owner, with native transport drain before its result releases ownership.                                    |

`runtimeFor` supplies the shared service to every supported native runtime,
including account/model-specific and CantripOS runtime instances. The private
`begin`, `begin-independent`, `suspend`, `resume` and `finish` boundaries extend the
existing managed channel. There is no competing native provider semaphore.

Primary implementation locations:

- Worker pool and journal: `cantrip_worker/src/inference-admission.ts`,
  `inference-journal.ts`, `native-inference-ownership.ts`.
- Runtime integration: `cantrip_worker/src/codex/inference-admission.ts`,
  `app-server.ts`, `managed-execution-runner.ts`,
  `managed-native-command-session.ts`, and `cantrip_worker/src/index.ts`.
- Helper ownership: `cantrip_worker/src/inference-command.ts`,
  `inference-source.ts`, and `automatic-labeling.ts`.
- Task authority: both servers' `task-inference-inputs`/`inference_inputs` and
  `task-goal-inference-inputs`/`goal_inference_inputs` repositories, their dispatch
  fences, Goal synchronization and Task control paths.
- Native boundaries: `cantrip_codex/patches/0048-worker-inference-admission.patch`
  and the subsequent inference ownership, transport, memory, suspension,
  recovery, Goal accounting and Task-control patches in that ordered patch set.

## Timeouts, controls and failure ownership

Provider queue and confirmed suspension time do not consume execution deadlines.
Both command buses use monotonic phase/sequence updates with separate cumulative
preparation and execution budgets. Waiting longer than the former 30-second
labeling command allowance remains ordinary queueing; actual preparation and
inference still have their bounded deadlines. Native stateless inference cancels
and drains its response resources before returning after its execution deadline.

Stop, Pause/Resume, interaction replies, status, settings and queue controls have
reserved bounded command-lane headroom. They do not wait behind the provider queue
or the ordinary inference transport limit. The positive durable enqueue ACK frees
ordinary transport admission without granting provider capacity. Relay quotas and
authorization still apply. An actual rejection before dispatch can defer an
unchanged canonical input; a timeout or lost response cannot establish no-start.

Tickets release after exact native/private settlement, proven unstarted
cancellation, or confirmed native-process fencing. Root terminal UI events cannot
release before private native response ownership finishes. Model transport retries
within a ticket remain sequential through dispatch/body/socket cleanup. Provider
failover settles the old attempt first; switching accounts under one provider
continues using the same pool. A provider change obtains destination capacity only
after old ownership is settled or positively withdrawn at a no-replay boundary.

A quiet stream, deadline, lost socket, closed tab, failed UI publication or delayed
heartbeat cannot free possibly running inference. Physical ownership is separate
from logical Chat lanes and Task leases. Observer exceptions cannot retain an
otherwise settled ticket. No exactly-once provider-execution promise is made after
an ambiguous failure; canonical native receipts and uncertainty handling remain
authoritative.

Queued route edits use the canonical claim and positive unused-source withdrawal.
They preserve ordering for unchanged routes, move changed providers to the
destination FIFO, and cannot hold both pools. Applied Goal setters and a pending
alternate-provider title use their existing input/producer hold; source identity,
not a cached idle badge, determines whether a transfer is safe.

## Recovery, removal and Task controls

One native keeper owns an OS lock for the stable server/account/worker scope.
Every managed native process consumes a one-use launch intent and holds its own
OS lease for its lifetime. A replacement worker fences prior processes and waits
for those leases before granting replacement capacity. Launcher PIDs, wrapper exit,
socket loss and helper timeouts are not evidence of native death. Actual failed
fencing retains capacity and retries. Graceful shutdown closes the keeper as well
as native runtimes; abrupt worker exit closes its lifetime pipe through the OS.

The keeper journal records operation identity, provider, generation, FIFO ordinal
and exact native correlation, without prompts. Startup reads and reconciles actual
journal records before admitting replacements. Canonical queue/Task receipts and
native checkpoints distinguish unused input from potentially executed work.
Only positively unused sources can be reissued. Restored eligible work preserves
its ordinal; unavailable recovery preparation is reported as recovery rather than
a fictitious provider slot. Real preparation failure can remove its eligibility
without pretending that a physical execution ended.

Captured Task Goal and round results have durable worker delivery and exact
canonical commit acknowledgements. Lost publication can retry without replaying
input or granting execution authority to an old generation. Acknowledged metadata
is removed; unresolved results and execution evidence remain available for actual
reconciliation. A crash before capture still uses native checkpoint/terminal
recovery. Directory-entry power-loss durability follows the existing POSIX history
writer; cross-platform power-loss behavior was not exercised.

Provider removal closes new admission and cancels waiting, unstarted granted and
confirmed-suspended operations. Running work remains charged through settlement;
removal does not kill a just-finished response before result capture. Empty removed
pools are pruned. Stale catalogs or envelopes cannot recreate them.

Chat/Task/project deletion uses the durable ID-only revocation outbox from
migration `0262_inference_resource_revocations`. Both servers retry actual delivery
to all registered owning workers, including previous placements. The worker seals
actual command sources before asynchronous cleanup, retains interruption of known
running native owners, and acknowledges sealing rather than physical completion.
Helpers authorize their actual resource before queueing and again before dispatch.
Archival retains its existing active-turn Stop requirement and does not permanently
revoke a restorable native registration. Helpers cannot start against archived
resources. UI disconnection does not cancel durably accepted work.

Task Pause/Resume intent is revisioned under the canonical Chat lock and applied
at the actual native gate. Stop also fences a claimed/running dispatch before an
input receipt exists. Launch preflight retains the original control revision;
fresh context reads cannot adopt authority after Stop/Resume. Enforced unused
round/Goal receipts defer through their existing canonical transitions without
failing the Task or consuming retry budget. Each resumed episode rejoins FIFO.

An old physical Goal result can persist after its original lease is fenced. Its
logical projection uses current control authority. For a paused Task, clearing the
captured lane requires an acknowledged pause on the exact root plus an actual
loaded Core idle read. The worker brackets that read with control, cycle/order,
transport and root-generation checks; both servers compare the positive
`pausedAndIdleRevision` to the current canonical Chat revision. Unloaded history,
an in-flight pause or a Pause/Resume/Pause race cannot provide that proof. An
unconfirmed receipt remains unprojected for reconciliation. This closes only the
old lane, suppresses unread completion and never releases provider capacity.

## Queue visibility, accounting and bounded state

Workers publish coalesced event-driven snapshots containing provider, worker,
generation, operation, state, one-based position and utilization. Both servers
validate authenticated server/account/worker binding and monotonic revision.
The app loads an initial snapshot and reconciles reconnects. Same-generation
Live events update selected query data; a generation change requires a fresh
authenticated snapshot. Delayed fetches/events cannot resurrect an old position.

Chat and Task surfaces show, for example:

> Queued · #3 for ChatGPT · 8 of 8 slots in use. Starts automatically when capacity is available.

The name comes from the actual provider. There is no ETA. Later Chat messages
waiting for their current turn remain distinct from provider waiters. Existing
Stop/Cancel and queue-edit controls preserve drafts, attachments and message
identity. Provider settings show each worker's utilization separately. A queued
child/helper does not falsely label its actively inferencing parent as queued.
Status contains opaque identifiers and counts, never another project's prompts
or titles, and stays on the owner-authorized server/live-event boundary.

Monotonic worker counters separate queue, reservation, execution and suspension.
Command telemetry also distinguishes preparation and attributes provider-local
clocks to the response provider. Native Goal accounting excludes provider waiting
from inference/turn budgets; existing wall-clock total-elapsed semantics remain.
Task/Goal views stop extrapolating inference clocks while queued. Missing legacy
timing remains unknown; it is not reconstructed from a different process's clock.
Autonomous cycles retain worker timing without inventing a server RPC lifetime.

Diagnostics correlate admission, grant, start, cancellation, suspension, release
and recovery by opaque operation/provider/runtime/worker identities. They contain
no prompts, titles or credentials and do not emit per token. Active operations
have strong ownership; completed source handles use weak ownership, native recent
completion metadata is bounded, and acknowledged durable records are retired.
Unresolved evidence is retained for correctness. Status congestion retains the
latest snapshot, not an unbounded stream. There is no new whole-app polling or
continuous idle render loop.

Relevant UI and relay sources are `cantrip_app/src/lib/worker-inference.ts`,
`app-live-query.ts`, `components/chat/inference-queue-notice.tsx`, Task surfaces,
provider settings, both servers' worker notification/status routes, and
`cantrip_server/src/workers/provider-inference-config.ts` with its Rust
`settings/account_service/inference_delivery.rs` counterpart.

## Acceptance source review

The following scenarios were traced through the implementation. **None was run as
a test for this goal.** Native patches, migrations and all supported platforms
still require runtime qualification when execution is authorized.

| Scenario                                           | Source conclusion and controlling boundary                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ten eligible turns, one provider, limit 8          | `drain` reserves eight active tickets; two remain in FIFO with positions 1 and 2.                                                                     |
| Several projects on the same worker                | All `runtimeFor` instances receive the same scoped `WorkerInferenceAdmission`; project ID is attribution, not the pool key.                           |
| A second worker                                    | Stable worker-scoped admission and keeper ownership create independent pools.                                                                         |
| Multiple models or accounts under one provider     | Provider ID remains the pool key across runtime/account selection and safe failover.                                                                  |
| Another provider while one is full                 | Each provider has its own active set and FIFO; no global inference gate serializes them.                                                              |
| Same-provider title and response at limit 1        | `runTurnAttempt` acquires once and passes the reservation to sequential `runInitialLabelInference`.                                                   |
| Different-provider title                           | `prepareBeforeAcquire` retains source authority without response capacity; `runLabelInference` settles before response acquisition.                   |
| Goal continuations competing with Chats/Tasks      | Each managed/private cycle requests a new ticket; resumed suspensions receive a new sequence and journal ordinal.                                     |
| All parents waiting for children/Tasks             | Native dependency waits suspend only after sampling/response drain; children acquire independently and parents reacquire before sampling.             |
| Queue wait exceeds old labeling deadlines          | Node/Rust command phase clocks exclude waiting; native label execution deadlines start after admission.                                               |
| Cancel races with acquisition                      | Ticket state/signal are rechecked after durable grant and native binding; cancelled unused work cannot start.                                         |
| Exception or real runtime exit                     | Unforwarded work settles unused; started work waits for exact private finish or native OS-lease fencing.                                              |
| Timeout while native work may continue             | Observation failure retains dispatched holders; native cleanup/settlement or actual fencing remains necessary.                                        |
| Worker restart or reconnect                        | Keeper takeover fences survivors before preparation; journal/canonical receipt reconciliation prevents duplicate replay and preserves eligible order. |
| Live limit changes                                 | Monotonic config revisions reject old updates; increasing drains FIFO and decreasing preserves holders.                                               |
| Multiple windows/devices and stale events          | Scoped status revisions, authenticated worker generation and fresh reconnect snapshots protect query state.                                           |
| Resource/provider removal or queued route edit     | Durable source revocation or positive withdrawal closes old admission; no destination grant borrows old-provider capacity.                            |
| Task Stop during preflight or late Goal completion | Original control revision and Cycle fence prevent stale launch; late physical result projection cannot free tickets or finish a newer lane.           |

## Deployment and verification limits

Deploy current protocol readers, server, worker and the matching patched Codex
runtime together, with the normal ordered migrations. Strict private response
schemas and managed execution authority are coordinated contracts; older runtimes
or servers are not an unrestricted inference fallback. This guide does not claim
the migrations were applied or the native patch set was built or verified here.

The final audit covered the supported producer inventory, first and continuing
Goal admission, same/different-provider naming, suspended dependency and pause
resumption, configuration/removal, resource authority, recovery ownership,
monotonic feedback and the scenarios above. Runtime throughput, exact UI behavior,
native patch compatibility and cross-platform recovery remain unmeasured under
the no-execution restriction. Earlier incremental notes are preserved in Git
history rather than maintained as contradictory implementation status.
