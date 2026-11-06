# Durable native turn suspension

## Delivery status

This feature is being implemented in sequential, independently merged milestones.
The checkpoint storage foundation is implemented in patch `0048`; patch `0051`
connects native capture and original-ID restoration through experimental native
operations. Patch `0053` adds stored inspection, explicit attachment holds and
terminal-history-based retirement of unreadable records. Patch `0061` retains
continuations through resumption preparation and binds controls to their native
turn and generation. Patch `0064` preserves a held continuation through native
runtime teardown and transport EOF. Patches `0072` and `0073` retain finalized
CodeMode data through both gRPC and the default framed-stdio transport. Patch
`0075` quiesces MCP clients and defers held startup until explicit resumption.
The managed worker now captures a native checkpoint and commits its encrypted
source locator before confirming Pause through either shared control path.
Native command receipts now commit server suspension ownership and status.
Both server implementations can now admit a fresh physical observer for an
explicit Resume while retaining the original input and native turn. Production
worker orchestration now connects explicit cold Resume to fresh admission,
held restoration and original-input completion. Cold Stop can acquire a held
observer for cancellation without restoring or releasing the continuation.
The production worker acceptance
below exercises this through the encrypted browser SDK and mounted application.
The complete resource, error and autonomous-execution matrix is still being integrated; this is
not yet the complete product guarantee.

The complete acceptance target is:

1. Request Pause on an active native turn.
2. Wait for confirmation that its safe-boundary checkpoint is durably committed.
3. Kill the worker, Codex, and all descendants.
4. Restart the worker and reopen the chat. It still shows Paused.
5. Click Resume to continue the original native thread and turn.

Process termination before durable confirmation and loss of persistent storage
are outside this first guarantee. Stop remains cancellation, not suspension.
A replacement turn, repeated original prompt, or injected "continue" message
does not satisfy the contract.

## Existing runtime and ownership

The reviewed `0004` patch gates the sampling loop at a model/tool boundary and
flushes native history. Patch `0039` waits for the acknowledgement outside the
thread mutation queue, keeping Stop, steering, replies, and resume usable.
The pause flags and waiting task are in memory. The server's
`chats.automation_paused` value is persistent but is not an execution checkpoint.

The pinned upstream provides `CodexThread::recover_turn_if_idle`, which can
recover an unfinished native turn under its original ID without new user input.
Its `suspend_turn_and_shutdown` handoff intentionally drops pending input and
interactive waiters; this is insufficient for durable Cantrip pause. The separate
daemon continuation path creates replacement work and must not be used here.

Authority remains split as follows:

- Codex owns the continuation, native history boundary, same-turn execution, and
  local checkpoint lock.
- The worker owns runtime restoration, project/environment binding, local tool
  resources, encrypted history publication, and fresh server admission.
- The server owns user intent, durable suspension identity/status, current
  worker/runtime authority, and queue/autonomy pause state.
- The app displays authoritative state and requests explicit Resume or Stop.

## Server suspension records

Migration `0266_native_turn_suspensions` adds nullable
`chats.native_suspension_state`. Existing chats keep their existing JSON when
this column is absent. A versioned record stores control intent, original
native thread/turn identity, committed checkpoint evidence, source placement,
and execution-owner correlation. The worker's persistent `storageId` is an
opaque locator; server metadata contains no worker filesystem path, checkpoint
contents, credentials, or reusable admission grants. Runtime fingerprints are
diagnostic; actual native restoration decides compatibility.

`pausing` describes a requested boundary; `paused` requires its committed
checkpoint and exact original turn. `resuming` retains that checkpoint and the
queue hold until a matching acknowledged Resume records `running`. The old
checkpoint identity remains evidence while running, without authorizing another
Resume. Stop intent supersedes earlier controls immediately. Its evidence is
retained for cleanup until acknowledged Stop or actual terminal proof clears
resumability. A failed Stop remains Stop intent and permits a Stop retry, not
resumption. A failed new Pause does not offer Resume from evidence retained
from the earlier running boundary; retry Pause to obtain current confirmation.
Restoration errors retain an explicit Resume retry. Normal completion after a successful Resume retains the existing
queue intent rather than introducing another pause.

The TypeScript `NativeSuspensionRepository` commits each transition under the
existing project/chat locks and advances the managed queue revision atomically.
Duplicate requests join the canonical in-flight control. Every acknowledgement
must match its control ID and current execution owner. An explicit actor claim
in that control epoch is required before acknowledging Pause, Resume, idle, or
Stop. Claims are correlation metadata, not execution authorization: the control
service must obtain actual fresh admission and verify native checkpoint/history
evidence before reporting success. Resume source checks compare actual locked
chat placement, provider route, and source thread; they do not compare rotated
API keys or require an exact diagnostic fingerprint.

The database enforces the queue hold at the actual write for `pausing`,
`paused`, `resuming`, `stopping`, `error`, and unknown phases/versions. Existing
generic unpause writers cannot release that hold. Failed state writes roll
back without losing the prior evidence. Public chat summaries expose only
status, pending action, resumability, original turn, timing, and a fixed error code with optional encrypted
details. Invalid or unsupported records remain stored and show a safe error;
strict recovery reads reject them without replacing their bytes. Rust uses
the generated source contracts, explicit semantic validation, strict recovery
reads, and the same public projection.

The production cold control service uses these transitions and the typed
`chat.suspension.resume` worker command. It holds queues until the actual native
Resume acknowledgement. Server transitions alone do not establish native
restoration or whole-worker termination acceptance.

The server foundation is checked by 15 real migrated-database state tests,
62 existing native-command cases, and seven settings-persistence cases. All
1,114 protocol checks pass, including the unchanged historical export
fingerprint. Rust compares 96 source contract cases and seven public
projections, then seeds and reopens the actual server database in separate
fresh processes and verifies the legacy-unpause constraint. Its test owns an
isolated PostgreSQL runtime. These verify server metadata persistence, without
claiming native Codex or whole-worker resumption. Server typecheck and focused
format checks pass. The standard check still stops at the existing application
decomposition limits; the separate repository guard reports the existing
`native-commands.ts` limit. Later standard-check stages did not run.

## Task recovery qualification

Task controls use a separate admission-intent route. Patch `0090` restores native
journal compatibility with the canonical Task queue epoch. Run the production
fixture with `--task-origin --task-complete` to qualify a tool-using Task's normal
completion. Both Node and Rust pass with two provider requests, one native turn,
one completed command, and no native abort. This mode performs no cold recovery.

For a running Task round, the worker now binds Core's actual thread, turn, and
inference scope to the canonical dispatched Task input before its private model
permission returns. Node and Rust persist this correlation on the round input,
active lane, and dispatch cycle, bound to the claiming worker process and native
runtime generations. A repeated exact binding is idempotent; changing its native
identity or owner is rejected. The binding does not change the canonical input
receipt, create a generic chat runtime, finalize the round, or grant recovery or
input replay. A failed write rejects model permission and rolls back all three
records. The live completion fixture checks the server's thread and turn against
the actual native keeper while the Task is still running.

Direct Task rounds now commit both the native checkpoint and a Task-encrypted
worker continuation before confirming Pause. The continuation retains the
original opaque round request and published event identities, including cached
completion ciphertext. It contains no reusable dispatch grant. Task and chat
checkpoint protection remain separate; opening a Task continuation requires
current Task-content authority.

Explicit cold Resume acquires a fresh Task lease and physical input receipt while
retaining the original logical operation, planning round, native thread and turn.
It restores the result-publication pipeline from the protected continuation and
submits native Resume without resending the input. Ordinary Task scheduling cannot
claim a held checkpoint. Failed attachment or restoration retains the checkpoint
and logical round for an explicit retry; an unbound retry cannot replace the
actual execution owner of the saved checkpoint.

The production fixture with `--task-origin` now passes on Node and Rust after
whole-worker-tree termination. It checks completed tool context, unchanged round
and attempt counters, one original input and turn-start event, and no execution
on restart/reopening. `--task-cold-rounds 2 --task-duplicate-resume` exercises
repeated recovery and concurrent Resume requests. `--task-restore-damage` accepts
`missing`, `corrupt`, or `incompatible`: actual failed restoration retains recovery
state, and repairing the fixture-owned checkpoint allows same-turn retry.

Task Stop persists its intent before cancellation and remains separate from
Pause. Its acknowledgement requires actual terminal native history. It can cancel
a surviving owner or attach a cold held owner without Resume, including with a
missing, corrupt or incompatible checkpoint. The fixture covers
`--task-running-stop`, `--task-stop-pending-pause`, `--task-cold-stop`,
`--task-live-pause --task-cold-stop`, and `--task-stop-restoring`. The last case
cancels an actual restoration waiting for provider capacity and verifies that
freeing capacity cannot restart it. Late physical failure callbacks cannot fail
the stopped logical Task; matching native terminal proof still retires recovery.

These results qualify direct Task rounds. Planning/finalizer rounds, autonomous
Task Goal accounting, and the complete resource/client matrix still require
production qualification; this section does not claim those paths complete.

## Held managed attachment

Managed thread preparation can carry the server's expected suspension into
both preserving and configuring native attachment. This hold is installed
before native recovery or prewarm. Attachment may succeed while the checkpoint
file is missing or damaged; it must remain idle. Explicit restoration separately
inspects the actual checkpoint and reports compatibility or storage errors.

The native TUI's `thread/resume` attaches a view; explicit turn Resume is a
separate operation. Managed attach/detach commands use the current session,
placement, thread and provider scope without requiring or replacing an execution
activation. The worker rejects settings and history overrides on this path.
This lets a replacement TUI observe a held turn while the server retains the
original execution bookkeeping. Opening that view neither acquires execution
capacity nor releases the hold; explicit Resume still needs fresh admission.

Worker restoration also carries the execution profile used to start the native
process. A standalone chat must not be reopened as an IDE runtime. The
process-isolated worker fixture covers both profiles, two whole-worker-tree
terminations, missing and corrupt checkpoint contents during attachment, and
subsequent same-turn restoration. Production managed preparation now selects
the encrypted source as described below; the explicit cold Resume control
service connects fresh admission and observer publication.

## Selecting the original home during preparation

The server's shared managed launch path reads its actual private suspension
record and includes only the committed evidence as optional session attachment
intent. This applies to GUI preparation and native terminal launch through
Direct, relay and WorkerLink. Running and terminal records cannot turn their
historical checkpoint evidence into new attachment intent.

Before selecting or starting a native runtime, the worker opens that exact
source locator with the current chat-content grant and verifies its chat,
thread, placement, route and account. The original home remains inside its
protected source record. A private runtime namespace identifies that home and
chat; no filesystem path is added to the command protocol. An already attached
managed owner of the same home/thread can keep the live preparation path.

Missing source data or encryption authority produces a fixed error and never
selects a default home. Runtime version/fingerprint diagnostics do not decide
checkpoint compatibility; explicit native inspection remains authoritative.
Preparation installs expected suspension before native attachment and does not
create fresh execution admission, release automation or submit Resume. The
cold Resume publication/control lifecycle uses this held preparation.

## Fresh execution ownership for cold restoration

`POST /api/internal/native-commands/suspension-execution` admits an observer
under an existing suspended execution lane. It requires the authenticated
worker's current process generation, an explicit current Resume control epoch,
the exact committed checkpoint descriptor and unchanged placement, native
thread and provider route. Worker identity is checked before and after the
transaction against the actual registered connection identity. The operation
neither forwards native IPC nor releases the automation hold.

The locked transaction retains `target.originalOperationId` and the original
command generation as native input/history provenance. It creates a new
physical `thread/resume` execution with fresh operation and activation
generations, links its predecessor, and records `executionOwner` separately
from the current control actor. The original GUI logical input and execution
lane remain open. Old GUI transport cleanup cannot finish a replacement
observer, including after its explicit Resume acknowledgement. Terminal native
evidence and Stop still permit canonical cleanup.

The original `(chat, thread, turn)` history association remains unique. A
restored observer's native-turn observation is derived from its server-stamped
source and checkpoint; it never inserts another canonical input owner. The
admission result returns the original source and GUI logical root so worker
publication can retain those anchors while using fresh execution authority.

Retries by the same worker/runtime and control join the canonical physical
admission, even if the retry proposes a different operation ID. Changed
payloads or ownership conflict explicitly. The ordinary admission endpoint
rejects caller-supplied restoration markers. Dispatch checks the current
control epoch, checkpoint and execution owner again, so a later Pause or Stop
fences an older pending restoration. Resume controls can also carry the exact
expected control ID. Write failures roll back observer creation, predecessor
retirement and activation changes together; the prior checkpoint remains
available.

The optional `executionOwner` field is backward-compatible with existing
version-1 suspension records. It contains correlation IDs, not credentials or
reusable execution grants. Restoring native state and obtaining fresh runtime
capacity remain worker responsibilities; this endpoint alone does not prove
that a checkpoint is readable or that native resumption succeeded.

## Restored observer publication

`ManagedNativeCommandSession.restoreSuspendedExecution` connects fresh observer
admission to the ordinary protected publication and native terminal settlement
pipeline. It dispatches the current server generation before restoring the
held observer and joins duplicate preparation for that exact admission,
checkpoint and saved bookkeeping. It submits no prompt or native Resume.

The original operation remains the history/output provenance. Native events,
interactions, MCP and computer-use authority belong to the fresh execution
grant. Publication must flush before the native terminal receipt settles.
Observer loss or failed restoration cannot stand in for native completion.
Explicit Resume and Stop can carry the exact suspension control ID alongside
the activation generation, preventing an older Resume from replacing a newer
Stop intent.

The component integration exercises actual authenticated server admission,
native process replacement, GUI and terminal inputs, accepted steering, held
preparation and original native turn identity. Production server-to-worker
Resume delivery invokes this lifecycle. After actual native terminal evidence
and protected outcome publication, both repositories atomically retire the
fresh physical execution, original GUI logical input and completion outbox.
Transport loss cannot finish that logical input. Duplicate terminal receipts
are idempotent, including when native completion precedes Stop acknowledgement.

## Production worker recovery acceptance

`scripts/server-rust/actual-durable-suspension.mjs` uses a real browser, account
encryption, normal server HTTP routes, the built production worker entrypoint,
provider admission and the verified patched native runtime. Only the public
model HTTP responses are controlled. It performs two durable Pause/SIGKILL/
restart/explicit Resume cycles on GUI-originated and native-TUI-originated
project chats with a completed native command and accepted pending steering.

The test freezes supervisors, records descendants and owned process groups,
including native helpers and the shared TUI, and includes detached tool daemons
whose executables belong to its isolated worker storage. It sends SIGKILL and verifies
that no live member remains. Startup
and chat reads must produce no model request. Repeated concurrent Resume calls
must join one execution. The resumed requests must retain model/reasoning
settings, cwd, original input, accepted steering and exactly one completed
command result. The original rollout must contain one turn start, one terminal
completion and one copy of each accepted input and completed command result.
The final browser-decrypted answer must retain the original thread and turn.

Pause preserves the managed runner until Core commits its boundary. Invalidating
that runner before forwarding Pause aborts the turn and prevents checkpoint
capture. Stop and explicit Goal cancellation retain their cancellation paths.

Build the worker and its dependencies, then run with a normally built native
bundle whose manifest matches the current patch series:

```sh
pnpm --filter @cantrip/worker... --filter @cantrip/glitch --filter @cantrip/nbt -r build
node --test scripts/server-rust/owned-worker-tree.test.mjs
CANTRIP_CODEX_BIN=/absolute/path/to/bundle/codex \
  node --import tsx scripts/server-rust/actual-durable-suspension.mjs
```

The default run exercises both Node and Rust servers with isolated PGlite
storage. `--server node` or `--server rust` selects one implementation;
`--report <path>` saves its report. Successful runs remove disposable state
unless `--retain` is supplied; failures preserve it for diagnosis. The current
process-tree inspection uses POSIX tools.

Add `--mounted-ui` to drive the real application. Setup still uses the encrypted
SDK. The test then selects the chat through the sidebar, clicks Pause while
the provider response is held, checks Pausing and an enabled Stop, and rejects
any premature Paused status. After each worker-tree kill it reloads the actual
application, reopens the paused chat and clicks Resume. It also checks that the
final answer is visible in the mounted transcript. The same original-rollout
and inference assertions apply to both servers.

Add `--terminal-origin` to enter the original prompt through the production
native Codex PTY instead of the GUI send API. With `--mounted-ui`, Pause and
Resume still use the shared Cantrip controls. After each process-tree kill,
the test reattaches the same console before Resume, checks the original prompt
and completed command result in its rendered history, and verifies that opening
the view starts no inference. The final answer must appear in both the native
TUI and the GUI. Reattachment restores committed history; preview text from a
cancelled provider stream is not a committed history item.

Managed project preparation enables canonical native history. Console sync reads
the actual native history metadata and leaves canonical turns to the encrypted
history pipeline, preserving native lifecycle status in its response. This
prevents a TUI input from acquiring both a legacy `codex-sync` message and a
canonical history message. Unmanaged and legacy history keep their existing
sync path.

Add `--post-pause-queue` to accept a new encrypted queued prompt after the first
durable Pause acknowledgement, revise its text, and then kill the worker tree.
The reopened queue must retain the same item ID, revision and revised text
without consuming it on startup or the first Resume. The test then explicitly
steers that retained item into the running original turn before its next
checkpoint. Its revised text must reach the second cold-resumed provider request
and appear once in GUI and native history; the replaced text must not execute.

A frozen native turn rejects direct steering. Newly queued input and its edits
remain authoritative in the encrypted server queue, separate from the immutable
worker checkpoint locator. They enter the native continuation only through an
explicit steer with current execution admission after Resume. Queue acceptance
does not release the pause or authorize inference.

Add `--post-pause-settings` to change future thread reasoning effort after each
durable Pause acknowledgement, first to High and then to Low. The fixture uses
the composer's bound, encrypted native-settings operation and reads confirmed
native selections before termination and after explicit Resume. While the fresh
attachment is held, it opens the saved encrypted confirmed selection through the
normal read API. A live refresh retains the existing execution-owner fence until
Resume establishes the new owner. Neither editing nor reading settings starts inference.
The original turn keeps its captured settings in both resumed provider requests;
the thread's future selection retains each accepted edit through the worker-tree
restart. Settings observation epochs can change with the new runtime.

Add `--capacity-waiting --mounted-ui` to occupy the provider's sole inference
slot with a second chat, then accept a GUI prompt that waits before any native
turn starts. Pause persists the existing encrypted queue hold and parks its
waiting capacity ticket. Stopping the blocker frees the slot without running the
held prompt. After terminating the whole worker tree, reopening retains the
original queued item ID, revision and text and shows Resume automatic agent work.
Only that explicit Resume dispatches the accepted input. The fixture then runs
the usual two durable suspension/cold-resumption cycles under its single native
thread and turn, checking unique history and completed tool results.

Add `--prestart-preparation --mounted-ui` to pause after capacity is granted
while the production Git workspace snapshot is still preparing the input.
The fixture blocks the actual Git fsmonitor hook, rather than inserting a worker
delay. Pause parks the unused grant, frees its provider slot, and waits for the
native keeper's durable `never-started` receipt. The original input cannot cross
canonical dispatch while parked. A fresh worker recovers the accepted encrypted
input from this positive no-start evidence. Add `--live-preparation` to release
Git while the original worker remains alive: completing preparation must stay
idle until explicit Resume obtains fresh permission.

The macOS ARM64 90-patch development runtime passed all eight granted-preparation
cases: GUI/terminal origins, Node/Rust servers, and live/cold initial Resume.
Each case then passed two cold native suspension cycles with its original thread
and turn, one user input, one native start/completion, and one completed command.
Waiting-capacity recovery and pending-question Stop also passed on both servers;
all twelve runtime cases left no owned processes behind. The 118 focused worker
tests include actual keeper settlement/refusal cases and delayed-write races.
The standard check still stops at the existing server decomposition limits;
later standard stages and optimized product qualification remain outstanding.

This boundary applies only before input dispatch and provider inference begin.
If dispatch, provider preparation, or an earlier unregistered source is in
progress without a native suspension boundary, Pause reports an actionable
retry/Stop error instead of confirming a durable hold. Active native execution
continues to use its safe-boundary checkpoint path.

There is no native turn identity or native checkpoint at the initial queue hold;
the first native turn starts only when the retained input is explicitly resumed.
Both GUI and native-terminal pre-start recovery are qualified on both servers.
Add `--terminal-origin` to exercise the terminal producer at the same boundary;
its accepted queue item retains the same ID, revision and text through restart.

Direct terminal `turn/start` admission now commits an encrypted canonical queue
item and its accepted claim in the same server transaction as the command and
execution lane. It preserves the native client user-message identity and uses
the existing literal native-input envelope, so slash or shell-looking text is
not parsed again during recovery. A real queue or claim write failure rolls
back the admission. Replayed admission keeps the original item; a new command
cannot adopt an existing queued item. Native settings deferral returns this
same claim to pending without creating another encrypted prompt.

The original worker keeps using its accepted source while it survives. A fresh
worker must fence the old native scope and correlate actual no-start journal
evidence with the command, generation, message and thread before returning its
claim to pending. A previous unused grant requires the committed `never-started`
receipt; a grant alone is insufficient. Consumed native input cannot use this path.
Legacy terminal commands admitted without the retained-input contract do not
gain replay authority from missing history or a stale session. This extends
pending-input recovery without manufacturing a native continuation.

Never-granted input recovery uses the actual native-ownership takeover and
inference-journal evidence, preserving canonical queue identity while retiring
the old attempt. A replacement obtains fresh execution and inference authority.
Encrypted message idempotency compares JSON values independent of object-key
order introduced by PostgreSQL JSONB; message identity, classification, attachment
order and ciphertext must still match. Rust recovery binds serialized terminal
evidence as text before casting it to JSONB.

Add `--completed-session` to retain an actual yielded command session. A controlled
release lets the command finish before capture, leaving unread terminal output.
After the first worker-tree kill and cold Resume, the model polls the original
session ID with native `write_stdin`. The response must contain the retained
unread output and exit code once, without repeating previously drained output or
executing the command again. A second cold cycle retains the poll result in the
original turn's context and history.

Private resource callbacks use the current runner bound to their native thread;
the process-wide inference generation is only a fallback for threads without
their own gate. Ownership is checked again after actual encryption or decryption.
A replacement transport or runner cannot receive an older result. The existing
worker component grant protects completed output; no reusable execution authority
or new plaintext resource file is introduced.

Completed-session cold recovery is qualified through both input origins and both
servers. Active commands correctly refuse durable capture and show their concrete
reason with live controls. Add `--active-session` to attempt capture while the
controlled command is still running. The fixture checks the actual refusal,
absence of a checkpoint, and visible Retry Pause, live Resume and Stop controls.
It then finishes the command, explicitly resumes the surviving native turn and
performs two acknowledged cold recovery cycles, including the original session
poll and unique history assertions. Both input origins and both servers pass.

An unsuccessful capture can leave a live, paused native turn without a durable
checkpoint. Resume uses the coordinated control transaction for this state,
keeping queued work held until native acknowledgement. The original worker and
runtime generations must still match; the control operation receives fresh
correlation. This live-only path never prepares a replacement attachment or
attempts cold restoration without a checkpoint. An unavailable original owner
produces an explicit error, retains the hold and allows retry or Stop. Public
`resumable` remains false: this state does not grant recovery after process death.

Stop also commits coordinated intent before interrupting the original native
turn, including after capture failed. Duplicate Stop requests share or serialize
the native control attempt so concurrent requests cannot replace its pending
acknowledgement owner. A native interruption remains interrupted even when the
turn has earlier assistant text. A yielded command is owned by its native
thread and can remain alive after the turn is stopped. Stop does not represent
that command as durably suspended or reconstruct it after restart. The
`--active-session --stop-active-session` fixture records its actual process state,
then terminates the whole worker tree and verifies that reopening retains
Stopped, rejects late Resume and starts no inference. It does not claim Stop
alone terminates yielded background commands.

Both composer and linked console controls use authoritative suspension phases.
Restoration errors preserve the chat and expose an explicit retry; Stop intent
cannot offer Resume. Pause persistence failure keeps Retry Pause and the
existing live continuation control. A reopened composer's duration uses the
original correlated turn start and saved pause timing, including offline time;
accepted steering does not start another clock, and later turns cannot inherit
an older turn's pause total.

Both input origins and paused native-TUI reattachment are qualified through the
mounted desktop browser on Node and Rust servers. The linked console endpoint
returns its existing durable terminal identity on repeated creation requests.
Recovery-error controls and
timing have focused component coverage. Cold Stop also has mounted coverage with
missing, corrupt and incompatible native checkpoints. Actual Resume failure UI
flows remain part of the broader error matrix. This does not qualify
Task/Goal recovery or the complete resource/error matrix.
Those remain separate acceptance requirements.

### Questions and command approvals

A blocking native question or command approval keeps Pause in `pausing` while
its actual tool invocation is awaiting a reply. It does not receive a durable
acknowledgement with that waiter still outstanding. The mounted transcript says
"Resolve the pending request to finish pausing. Stop is still available." The
existing reply controls and Stop remain usable. Answering a question or allowing
a command lets the tool finish and its result enter native history before the
checkpoint commits. No further provider inference starts until explicit Resume.
Killing processes before that confirmation remains outside the guarantee.

Add `--pending-question` or `--pending-approval` to the production acceptance
fixture to exercise these boundaries with a real native request and the actual
mounted reply controls. The question case uses Plan Mode; both server
implementations expose the same encrypted Plan GET/PATCH routes. Reading saved
Plan state remains possible while the worker is offline, and does not load a
native thread. Mode changes require an actual native write and reject a running
turn. The fixture checks malformed input, missing chats and active-turn changes
through real HTTP requests.

After resolving the interaction, each case performs a live Resume followed by
two complete worker-tree kills and cold Resumes of the original turn. The
accepted interaction stays resolved under its original request ID. Its completed
tool result appears once in restored provider context and native history, with
no repeated question, approval or completed command. This policy preserves
completed replies; it does not reconstruct an unanswered in-memory waiter after
an unconfirmed Pause.

Add `--stop-pending-interaction` with either interaction option to leave the
request unanswered and click Stop while Pause is pending. The fixture checks
the original request becomes interrupted, a late encrypted answer or approval
is rejected, and the original turn records one abort. It then kills the worker
tree, restarts, and reopens the GUI and native TUI. The stopped turn must remain
nonresumable without inference or another turn start. An unapproved command must
never execute; an already completed command must keep its single result.

The legacy pause HTTP response's `paused` field describes the automation flag.
In a concurrent Stop it can still reflect the earlier pause request. Durable
confirmation requires the authoritative native suspension to be `paused` and
resumable under the expected native identity. A `stopped` suspension remains
terminal even when a late control updates the automation flag. The mounted
application uses that authoritative state and offers no Resume turn or Paused
indicator for the stopped execution.

### Cold Stop before continuation restoration

Explicit Stop persists its own control epoch before worker preparation and
retains the autonomy stop. A previously accepted Resume cannot dispatch under
that epoch. A surviving managed observer handles Stop directly; a fresh worker
can instead acquire an observer grant stamped for Stop. That grant retains the
original logical input and native history provenance, and cannot be used as a
Resume grant. Duplicate deliveries for the same control and source join the
same worker attempt.

Managed preparation attaches the exact native thread under its execution hold.
Stop then installs the original protected publication/bookkeeping observer
without reading or decoding the native continuation. It does not reattach the
already held session, release the pause gate, submit input, or start inference.
The named native cancellation validates actual unfinished or terminal history,
commits one abort when needed, and retires resumability. Both servers require
the authoritative terminal acknowledgement before reporting successful Stop.
Failure keeps the chat and Stop intent with an explicit retry; it cannot expose
Resume for the stopped intent.

The encrypted worker source and its original placement still need to be
available. Missing or unreadable worker source is a recovery error; Stop does
not guess another private runtime home. A missing, corrupt or unsupported native
checkpoint alone does not prevent cancellation using the retained source and
actual native history.

The production fixture accepts `--cold-stop` to cancel after the first full
worker-tree kill instead of resuming. Add `--mounted-ui` to click the real Stop
button after reopening the paused chat. `--checkpoint-damage missing`, `corrupt`
or `incompatible` changes the actual native checkpoint after termination. These
cases run on both servers and require one original turn start, one named abort,
one completed tool result, no consumption of pending steering and no further
provider request. Concurrent or repeated Stop requests must not duplicate the
abort. This qualifies native checkpoint error handling for cold Chat Stop;
complete Task/Goal and resource-interleaving acceptance remains outstanding.

## Managed worker capture and source locator

An admitted managed `turn/pause` with `paused: true` forwards the exact stronger
native `turn/suspension` Pause operation for the same thread and turn. The
gateway permits only this exact rewrite, including its parameter shape; clients
cannot use it to select Resume, discard, another turn, or another filesystem
path. Requesting the durable boundary directly avoids a gap in which a separate
live Pause reply could arrive after the original turn finished.

The existing shared command settlement awaits both native checkpoint completion
and worker source persistence before returning its receipt to GUI or terminal.
It does not replay an uncertain mutation. Stop and ordinary completion may win
while Pause is pending. The worker accepts that outcome only after an actual
native history read proves the original turn ended; disappearing local process
state alone is not durable confirmation. Existing live Resume still uses its
admitted `turn/pause` operation and the native continuation's live path.

`NativeSuspensionStore` retains immutable files beneath the worker data
directory's `native-turn-suspensions/<scope-hash>/<chat-hash>` directories. Each
opaque UUID locator identifies one exact checkpoint descriptor and revision.
The source's project/placement/provider binding and actual original native home
are encrypted with the current worker's granted chat-content key. A separate
derived-key and authenticated-data domain prevents substitution between source
locator ciphertext and Core resource ciphertext. No credentials, socket IDs,
worker/runtime generations, execution grants, or conversation copy are saved in
the source locator.

Publication uses the existing private immutable-file helper: synced contents,
atomic same-directory publication, and directory sync on POSIX. Retrying a
publication retries actual directory sync before confirmation. Corrupt or
unsupported bytes are retained, and an uncertain write is not success. Opening
a locator after restart requires actual use of a fresh component grant; the
worker's private key alone is not a fallback. Saved paths never travel through
the public chat status. Inspection/listing does not attach or execute a turn,
and the registry does not choose a latest checkpoint using timestamps or PIDs.

These files are historical capture evidence, not execution authority or proof
that a turn is still resumable. Native checkpoint/history inspection and the
server's current control/owner fences must establish that at restoration.
Original-home selection, fresh execution/observer adoption and server control
records are connected to cold Resume. Startup and reconnect retain the hold.
The remaining UI and resource acceptance requirements still apply; the worker
capture milestone alone does not complete the product guarantee.

Local capture validation used the normal development build of all 78 patches,
fingerprint `6b953a3bbca421aef73a5dc2dd08f64db330315c3397d88f2116e4be09a59c52`.
Its runtime verifier, worker typecheck and 94 focused worker tests passed.
The seven-file native run passed 71 of 72 cases, including all six managed
GUI/TUI shared-control cases. One raw CodeMode case received an ended-turn
error from suspension Read immediately after Stop completion instead of the
expected empty result. This terminal-cleanup inspection race remains tracked;
it did not resume the stopped turn. The standard repository check stopped at
existing application decomposition limits, so later stages were not run.

## Server control and native receipts

Managed Pause, Resume and Stop declare the exact original native turn and the
current worker incarnation. Authorized dispatch commits the control epoch and
actor claim in the same database transaction as its native command dispatch.
GUI and terminal controls use this shared path in both server implementations.
The actor's worker/runtime/operation generations fence acknowledgements; they
are correlation data, never persisted execution authority.

Pause settlement includes the committed worker locator and native descriptor.
The command receipt and `paused` record commit together. Resume dispatch keeps
automation held through `resuming`; only its native acknowledgement changes the
record to `running` and releases the global hold. A failed database write leaves
both receipt and recovery state retryable. The HTTP Resume path skips its old
early unpause when checkpoint evidence exists. Stale workers and superseded
control acknowledgements cannot release that hold.

Actual native terminal evidence retires recovery separately from GUI logical
cleanup. This covers GUI and terminal origins without waiting for a new turn.
Transport failure and administrative execution retirement are not native
terminal proof. Stop retains the existing input/Goal cancellation fence and
clears checkpoint resumability on acknowledgement. A previous completed turn's
record cannot absorb Stop for a different active native turn.

The server also retains the current physical root and logical GUI input when
worker submission or transport ends with a committed suspension still held.
Both implementations read the actual suspension and current activation under
the chat lock. Administrative finish cannot close that lane, stamp logical
completion, or enqueue completion delivery. The submission failure path skips
provider failover and failure callbacks while this exact root is retained.
Native terminal proof permits cleanup even if it precedes the Stop receipt;
ordinary terminal settlement or acknowledged Stop retires the checkpoint.
This preserves the owner needed for subsequent cold adoption;
it does not yet acquire that fresh owner or implement product cold Resume.
Running records retain historical evidence without extending this hold to
unconfirmed termination of active inference. These guards cover managed agent
Chats, including their Goal turns. Task-experience turns use a separate admission
path and remain part of the pending integration.

Retention validation passed 91 focused server cases, server typecheck, and an
actual Rust server build. The database compatibility harness passed 107
operations per implementation, including held GUI/terminal closure attempts,
Resume and Stop ordering, and a real failed SQL write with retry. All seven
cold-worker/shared-control native cases passed against the unchanged verified
80-patch development runtime. Four broader Task test failures reproduce on
the pristine merged baseline. The standard check still stops at application
decomposition limits; its later stages were not run.

Worker persistence failure records a fixed public control error while retaining
native recovery bytes. The complete cold path still needs original-home
selection, fresh execution admission/adoption, restoration errors, duplicate
control reconciliation, and the client controls that distinguish Pausing from
durably Paused. This transaction integration does not authorize startup or
reconnection to resume inference or queued work.

Control integration validation passed 97 focused worker tests, 84 server tests,
all 1,114 protocol tests, and worker/server typechecks. The database compatibility
harness ran 34 operations against each actual server implementation with
separate migrated databases, including a real failed SQL write and retry.
The normal 79-patch macOS arm64 development build and runtime verifier passed
with `patchesSha256` of
`a4529c16e562ab5db15d93993056903bbfc3af835de00a6d051343c128274379`.
All 40 native cases in the shared-control, durable-Goal and durable-suspension
suites passed against that binary. Whole worker-tree cold product Resume
acceptance remains required; these results do not claim that path is delivered.

## Cold worker observer preparation

New managed captures use source-locator format 2. Its encrypted payload adds
versioned worker observer bookkeeping: the original workspace baseline,
effective model and settings, token context, publication deduplication, pending
messages and activity, and Goal checkpoint
publication state. Native history remains the only conversation record. Old
execution grants, controllers, capacity tickets, callbacks and timers are never
serialized. Resolved reply RPC IDs are transport-local and are not restored:
a new process can reuse an old numeric ID for an unrelated question. Native
continuation owns accepted input. Restoration keeps fresh authority, reply
tracking and callbacks and reconstructs
maps and sets. Observer fallback timing excludes time spent offline.

Format 1 source locators remain readable and inspectable. They lack the worker
bookkeeping required for cold observer reconstruction; callers must report that
limitation while retaining the saved bytes. They must not create a replacement
turn. Format 2 has a distinct immutable locator even for the same native
checkpoint, and retries retain the original published bookkeeping.

The worker API can open an exact locator with a fresh component grant and select
its original native home despite changed credential-derived defaults. It reads
the actual stored native suspension, attaches with `expectedSuspension`, reads
again, and binds the original turn into a fresh admitted observer. Attachment
and observer preparation do not send Resume or input and do not emit another
TurnStarted. Matching concurrent preparations join one observer; another owner
is rejected. Attachment failures retain the native hold and allow retry.

The isolated worker API acceptance fixture kills the entire worker/Codex tree
immediately after durable capture, restores in fresh processes, and repeats the
cycle. It checks the original thread and turn, one completed command side effect,
one original input and tool result in restored context, accepted pending steering,
effective settings, workspace baseline and token bookkeeping, fresh encryption
grants, held startup, and explicit Resume. A missing grant fails before native
startup. This is worker API acceptance, not full server-owned product acceptance.
The production cold-control handler, fresh server execution adoption and client
recovery controls remain required before the end-to-end guarantee is available.

The current normal 80-patch macOS arm64 development build and runtime verifier
passed with `patchesSha256`
`72e03cab144f69f706bdc8f96749d017e65e19fe77a2ca5cc5843e39b93986ce`.
All 41 native cases across cold worker restoration, shared GUI/TUI controls,
durable Goals and native suspension passed. The focused worker checks pass;
the broader app-server/admission run has five retry failures reproduced on
the pristine merged baseline. `pnpm check` still stops at the existing
application decomposition limits, leaving its later stages unrun. Full
server/worker/client cold acceptance and other platforms remain outstanding.

## Checkpoint store foundation

`codex-turn-checkpoint` is a small native workspace crate applied only to the
prepared build copy. The native suspension coordinator supplies a typed
continuation and an exact native history binding; the store does not
interpret that binding, capture context, authorize execution, or start work.

Each record includes thread, turn, and checkpoint identity; a monotonically
increasing revision; runtime version; history binding; lifecycle state; and the
typed continuation. Format version 1 wraps the original serialized record bytes
with a SHA-256 checksum. The checksum detects corruption; it is not authentication.
The continuation must contain data or references appropriate to the existing
private native history boundary, never credentials or reusable execution grants.

A thread ID is hashed to derive local filenames. The native coordinator uses
`<CODEX_HOME>/turn-suspensions`; product integration must retain the worker-owned
native home across restart. Files use owner-only permissions on Unix, and newly
created directories use owner-only access. Windows inherits the selected native
storage directory's access controls. The store is not exposed through browser filesystem
access or a general caller-controlled path.

An actual OS file lock provides exclusive process ownership. It is released
when its owner dies; no PID/age-based readiness or stale-lock heuristics are
used. Keep the lock throughout any execution that can consume or replace its
checkpoint. Never unlink lock files: another process could otherwise acquire a
different inode while the old owner still holds the original lock.

Commits compare the observed revision and advance it exactly once. They write a
private temporary file in the same directory, sync that file, atomically replace
the destination, and sync the directory on Unix. Windows uses the synced file and
same-directory replacement. The required guarantee concerns process termination,
not universal power-loss durability on every filesystem.

Failures before replacement retain the previous checkpoint. A directory-sync
failure after replacement can leave the new record installed: callers must read
actual state before retrying and must not acknowledge successful suspension on
an error. Uncommitted temporary files are not recovery candidates.

Lifecycle states are `suspended`, `resuming`, `consumed`, and `invalidated`.
Resumption preparation advances the store revision and retains the continuation
in `resuming`. A failed directory sync after replacement can leave that record
installed; a fresh owner can retry the same confirmed suspension while its
native history still matches. Actual execution beyond the boundary makes the
older snapshot stale. Settlement drops the continuation and retains a tombstone.
A settled checkpoint ID cannot be
reopened. A later suspension uses a new checkpoint ID and revision. Unsupported
formats, incompatible suspended runtimes, and corrupt records remain on disk and
return explicit errors. Settled records do not block later runtime upgrades.
The runtime still needs to validate the actual history and lifecycle evidence;
the store alone cannot establish that a turn remains unfinished.

Runtime compatibility is checked from validated envelope metadata before decoding
the runtime-specific continuation. An unsupported runtime error identifies the
required and current contracts; it does not destroy the saved continuation.
After actual committed terminal history proves the latest native turn ended,
an unreadable record can be retired to a private `<thread-hash>.retired-*.json`
inspection copy. The copy is synced before the active file is removed. Retired
files never become recovery candidates, and the permanent lock is retained.
A later suspension gets a new checkpoint identity and a fresh revision chain
when retirement removed an unreadable active record. Valid records normally
settle to revisioned tombstones instead. Terminal cleanup uses its actual native
history snapshot and coordinator generation to avoid retiring a later turn's
checkpoint. It does not change the current turn's live pause controls. A failed
settlement of a readable record remains an error; it does not trigger archival.

## Native continuation primitives

Patch `0051` adds the experimental native `turn/suspension` operation. Its
`pause` action names the active native turn and returns a checkpoint identity
only after native history and the continuation are committed. `read` inspects
that identity without attaching an unloaded thread or starting execution. A
loaded thread retains its existing owner; stored inspection takes temporary
exclusive ownership and reads actual native history. `resume` requires the exact
thread, turn, checkpoint and revision. `discard` records Stop in native terminal
history, including when an incompatible or corrupt continuation cannot be decoded.
These primitives do not yet replace Cantrip's product pause operation; the
worker/server/client integration remains a separate delivery milestone.

`thread/resume.expectedSuspension` carries the saved checkpoint identity into
attachment before startup prewarm or automatic input admission. It keeps an
explicit hold even if the file disappeared after inspection or its contents
cannot be decoded. Attachment does not authorize execution. Reads and explicit
Resume report the actual missing/corrupt/incompatible-data error, and repair can
be retried without replacing the original turn. A stale attachment request
cannot freeze an unrelated running turn. Held threads skip idle lifecycle
callbacks. Restoring Goal accounting and extension-owned turn bookkeeping still
requires an explicit extension contract. Patch `0066` adds this contract and
native Goal snapshots; resource policies and product recovery remain separate
requirements.

The continuation retains pending accepted inputs with native metadata, the
sampling-loop decisions, cumulative file diff, selected and pinned step settings,
turn timing and token accounting, retained input order, reasoning-effort pinning,
and the active compaction window. The persisted native history remains the
conversation authority. A SHA-256 binding covers its committed prefix, and
actual native start/terminal events fence stopped or superseded work.
Both paginated and legacy storage supply their full committed native history;
the checkpoint does not bind only the model's compacted context suffix.
Execution records after the bound prefix also invalidate an older checkpoint,
even if they still name the same unfinished turn.

The current native continuation contract is
`0.166.0/cantrip-suspension-v4`. The confirmed capture revision is stored inside
the continuation and remains stable across preparation retries. The store's
physical revision still advances for each committed lifecycle write and supplies
its compare-and-replace fencing. Native control descriptors identify the capture;
they do not turn a newer lifecycle write into a replacement checkpoint.
Earlier suspended contracts produce an explicit compatibility error and retain
their bytes; Stop can still retire them using committed native history.

Patch `0066` adds extension-owned bookkeeping to the private continuation. Core
captures and restores registered contributors without replaying turn-start
callbacks or depending on the Goal extension. Restoration applies each capture
and contributor once in a loaded session. Its short control guard rejects stale
preparation after Stop or a newer control generation. Async DB work never holds
that guard, and successful fresh admission validates all contributors before
thawing them or allowing the turn to advance.

The Goal snapshot retains the original turn ID, per-turn usage and accounting
baselines, descendant usage, Goal identities, failure/activity flags, automatic
continuation and empty-turn streaks, and unflushed timing. It references the
persisted Goal's identity, configuration revision and usage counters. Actual
atomic counter changes distinguish a held delta already charged by a Goal
mutation from still-unflushed usage; unexplained counter changes return a recovery
error instead of charging it again. Current Goal state remains authoritative.
No credentials or reusable execution grants are added to this data.

Durably held and offline time is excluded from Goal elapsed usage. The clock
retains its fractional unaccounted balance across repeated suspension; it does
not persist a process-local `Instant`. The existing legacy memory-only pause path
retains its behavior. Cold Stop settles reconstructible Goal usage before native
terminal history retires the continuation, and fences Resume while that write is
pending. A real DB failure preserves the hold and recovery data for a Stop retry.
Stop can reconstruct cancellation bookkeeping directly from a repaired checkpoint
without a successful Resume. Unsupported extension data is retained as an exact
private inspection copy after terminal history commits, with a warning that its
unreconstructible accounting could not be settled.

Cold Stop also persists the existing Goal-continuation hold. Reopening the chat
does not create a replacement Goal turn. A later explicit active Goal mutation or
ordinary turn start clears that hold; the original stopped turn stays terminal.

The v4 contract is intentionally incompatible with v3 suspended continuations.
Their original bytes remain available for inspection and explicit Stop. A changed
Goal runtime enablement or unsupported Goal payload produces a concrete restoration
error. This milestone does not complete post-capture instruction/resource producer
policies or connect Cantrip's product pause to durable recovery.

Original initial, next-step and already-pinned
pending-step settings are restored under the fresh runtime's constraints and
environment requirements. Changing future thread defaults while a turn is
suspended does not change that turn's captured settings. The restoration marker
applies only to the saved turn and is removed from defaults before a subsequent
ordinary turn. Runtime credentials and inference admission are acquired afresh.

A cold native attachment establishes the pause gate before model prewarm or
automatic input admission. Explicit Resume uses the original-ID native recovery
reservation and enters the shared sampling loop without repeating the turn-start
lifecycle. Patch `0066` restores extension-owned continuation bookkeeping.
It reconstructs fresh runtime handles, acquires fresh inference admission, and
waits for restoration readiness before acknowledging resumption. It does not
submit the original user prompt or emit another native TurnStarted event.
New model-visible world-state records are deferred until execution admission.
Failed preparation preserves unfinished-turn metadata without reporting a new
running lifecycle. Readiness and live gate changes belong to the same control
generation; a superseded operation cannot release a later pause.
Re-pausing a restoration waiting for inference admission cancels its fresh
reservation and reconfirms the saved boundary. A later Resume obtains fresh
admission; Stop can instead terminate the original turn without a provider grant.
The legacy Resume control also restores a cold suspension under its original ID.
Completed or cancelled speculative compaction requests are drained before
checkpoint capture; their usage is charged and their transport is not saved.

The native milestone currently refuses durable confirmation for active background
commands, yielded code-mode cells, outstanding native interactions, and native
subagent trees. The error retains live pause/resume and Stop controls. Recovery
policies for completed code-mode state, restarted MCP sessions and subagent trees
still require implementation and acceptance before product completion. A model
boundary alone is insufficient evidence that these resources survive death.

Native integration validation, resource-policy acceptance and complete
worker/server/UI acceptance remain distinct from the checkpoint-store tests.

### Completed terminal resources

Patch `0070` extends the native continuation contract to
`0.166.0/cantrip-suspension-v6`. Completed, pollable terminal sessions retain their
original session IDs, exit status, unread bytes, retained transcript and exact
byte-omission counts across process termination. Restoration creates read-only
completed records. It does not relaunch commands, recreate PTYs, replay stdin,
emit another command completion, or restore launch permissions or approvals.
Nonempty stdin and signals cannot execute against a restored completed record.

Capture requires actual command exit and raw-output producer closure and joins
the real output and history producers before committing the history boundary.
Cancelling capture retains the output join for a subsequent attempt. A still-open
producer, even after its parent command exits, refuses durable confirmation;
the existing live Resume and Stop controls remain available. Poll or close
completed sessions if their serialized resource data exceeds the 32 MiB limit.

Private resource data uses the worker's existing `chat-content` component grant,
field-key derivation and AES-256-GCM envelope. Associated data binds the original
thread, turn and checkpoint to the verified logical server, account owner and
stable worker principal. The checkpoint stores the envelope and key revision,
without another plaintext key file, reusable execution grants or raw resource
data. The private bridge targets only the owning connection, authenticates its
runner generation and one-use request identity, and bypasses history observers
and diagnostic payloads. Native protocol exports include both bridge operations.

Attaching a held chat retains opaque resource data without decrypting it. Each
explicit Resume attempts decryption with the current worker grant, including live
resumption when the original process survives. Reopening the worker's existing
HPKE identity alone does not restore the component grant. Missing authorization
or damaged data leaves the continuation held and retryable; Stop can discard it
without decryption. An unmanaged native session without a worker protector must
use live controls or finish collecting its terminal sessions before durable pause.

Older suspension contracts remain inspectable and stoppable, but require their
matching runtime for Resume. This terminal-data milestone does not implement
completed code-mode stores, MCP restoration, native child recovery, or the
server-owned and client-visible process-tree recovery guarantee.

The macOS ARM64 development runtime with all 71 reviewed patches passed 62
native acceptance cases: 30 Goal cases, four suspension cases, six shared-pause
cases, two physical TUI cases, and 20 terminal-resource cases. The resource
cases use the production worker protection handler, real HPKE bootstrap and
fresh component grants, real command processes and a local Responses fixture.
They cover both native history formats, live and cold collection, concurrent
cold Resume, large output with exact omission counts, repeated cold suspension,
session-ID reservation during fresh commands, missing-grant repair, Stop without
a grant, Stop during a withheld decryption reply, rejection of that late reply,
and nonempty-stdin rejection without consuming output or rerunning the command.
Every fixture verifies the actual current patch fingerprint and packaged
artifacts. The original native thread and turn identities, initial input,
completed side effects and original TurnStarted remain unique.

The same candidate passed 80 command/session Rust cases, two private-gate cases,
eight buffer cases, 345 native protocol cases and 44 Goal cases. One remote-only
command case exited early because its environment was unavailable. The protocol
run reports one ignored fixture writer; stable and experimental exports were
regenerated through explicit writer invocations. These are local macOS results.

This is native component acceptance. It does not establish whole-worker/server
recovery, persistent product controls, code-mode or MCP resource recovery, native
child recovery, or Linux/Windows execution. Final optimized product validation
remains required.

## Required next milestones

### Native lifecycle and resource hardening

Extend real-process validation of the native primitives across failed capture,
interrupted restoration, duplicate controls and terminal invalidation. Verify
native observers and the physical TUI against the same original-ID lifecycle.
Extend terminal invalidation to all resource and Goal lifecycle cases, including
an ordinary new turn after explicit Stop. No supported path may
duplicate TurnStarted, accepted input, completed tools or
history items, retain old execution authorization, or advance merely on attach.

Worker teardown and native transport EOF remain distinct from explicit Stop.
Patch `0064` detaches a held regular task before ordinary runtime cancellation,
fences pending resumption readiness, and cancels and joins its live task without
turn-terminal callbacks. The task releases its security execution lease; normal
runtime cleanup still closes command, code-mode and MCP resources and unregisters
thread services. Process-local pending input is cleared only after the task
stops; the committed continuation retains its accepted input.

SessionEnd hooks do not run for a held suspension because their commands could
perform side effects or change the saved history boundary. Ordinary completed,
stopped and non-suspended shutdown retains its existing SessionEnd behavior.
Explicit Stop still commits terminal history and invalidates the checkpoint.
An expected cold suspension remains held during teardown even when its checkpoint
is missing or unreadable; teardown does not substitute execution for recovery.
The existing `turn/interrupt` Stop operation commits cancellation for a cold held
turn even though it has no live task. Public history retains the unfinished turn's
stored lifecycle during a hold, with the thread remaining idle until execution
is actually admitted. Native TUI attachment therefore must not render a false
interruption or launch a replacement turn.

The pre-fix 62-patch runtime reproduced the EOF gap in both history formats:
closing App Server stdin after durable confirmation left an `invalidated`
checkpoint with no continuation. A real trusted SessionEnd hook also executed
during that suspended shutdown. Native EOF validation and complete worker-tree
restart acceptance are separate requirements; neither substitutes for the other.

Inspect PTYs, yielded commands, MCP sessions, code-mode state, waiters and native
subagents. A parent boundary does not prove those resources are durable. Restore
resources where feasible, or retain explicit information about lost resources
and a coherent continuation policy. Never replay completed side effects blindly.
Any state that cannot receive durable confirmation must produce an actual,
actionable outcome while retaining existing controls.

### Worker/server and product integration

Persist suspension identity and state in validated server protocols/schema.
Distinguish Pausing from durably Paused. Reconcile restart using real checkpoint
and history evidence. Acquire fresh runtime generations, admission, and capacity;
never reuse old grants/tickets. Retain project/source/environment boundaries.
Bind fresh admission to the suspended execution's original provider/account/model
route, including when future chat defaults have changed.

Use stored checkpoint inspection without starting a session, and carry the
server's expected suspension into native attachment before prewarm or autonomous
admission. A successful earlier inspection alone cannot keep attachment idle if
its checkpoint subsequently disappears. Missing or unreadable data must retain the explicit pause
hold and produce the actual restoration error.

Opening a chat, startup, reconnect and restoration must not run inference,
tools, queued input or Goal continuation. Explicit Resume selects the live or
cold path. Errors retain the chat and explain the actual failed operation.
Stop stays usable while pause/restoration is pending. Cover applicable shared
React clients and native-terminal interaction.

### Complete acceptance

Use the real patched binary, isolated persistent stores, actual worker/server
processes, and deterministic provider/tool fixtures. Test process-tree kill
immediately after durable confirmation, repeated cycles, both input origins,
observer reattachment, accepted pending input, questions/approvals, background
resources and subagents, duplicate Resume, failed writes/restoration, stale
ownership, missing/corrupt/incompatible checkpoints, and terminal invalidation.

Assert original thread/turn IDs, no duplicate completed tools or user/history
items, correct restored request context/settings, and no automatic execution.
Run existing pause, steering, queue, Goal, interrupt and history regressions.
Only this end-to-end evidence can establish product completion.

## Foundation validation

The native crate tests cover persisted payloads across fresh owners and repeated
replacement, competing owners, stale revisions, lifecycle settlement, corrupt and
unsupported data, staging failure, Unix permissions, and actual forced child
process termination followed by lock reacquisition and checkpoint read.
These storage tests do not prove native turn or worker restoration.

After normal source preparation (`pnpm codex:build`), run on the host target:

```sh
cargo test --locked --manifest-path cantrip_codex/.build/darwin-arm64/source/codex-rs/Cargo.toml -p codex-turn-checkpoint
cargo clippy --locked --manifest-path cantrip_codex/.build/darwin-arm64/source/codex-rs/Cargo.toml -p codex-turn-checkpoint --all-targets -- -D warnings
```

Replace `darwin-arm64` with the actual host platform key. macOS ARM64 storage
validation is recorded for this milestone; Windows/Linux native and complete
product acceptance remain required work.

## Native continuation validation

Build the reviewed patch series with the normal build workflow, then run the
actual runtime fixtures (replace the platform key for another host):

```sh
pnpm codex:build
CANTRIP_CODEX_TEST_BINARY="$PWD/cantrip_codex/.build/darwin-arm64/bundle/codex" \
  pnpm --filter @cantrip/worker exec vitest run \
  test/native-durable-suspension.test.ts test/native-shared-pause.test.ts
```

For the checkpoint/recovery milestone on macOS ARM64, the release bundle built
from all 53 patches passed eight tests:
two durable-continuation cases and six existing GUI/native-TUI shared-pause
cases. The durable fixture verifies the bundle's actual artifact hashes and
current patch fingerprint before starting isolated native processes against a
local Responses provider and real command tools. Each history format exercises
two forced native process-tree kills immediately after durable acknowledgement,
one live resume, concurrent duplicate Resume requests, accepted steering,
original turn settings despite changed future defaults, exact-once completed
tool effects, unique history items and a single original TurnStarted. It also
forces actual checkpoint-creation and live-settlement I/O failures, repairs the
filesystem, retries, verifies cumulative token accounting, completes the original
turn and starts a normal next turn. Further durably paused turns are explicitly
stopped with live, corrupt and incompatible checkpoints; duplicate Stop emits
one terminal event, and archived records preserve the exact damaged bytes.
After process restart their old checkpoints cannot resume and ordinary new
turns can complete. Attachment and read operations are checked for unintended
provider requests.

The expanded recovery fixtures also exercise stored inspection without native
attachment, missing data after inspection, corrupt and incompatible continuations,
repair and retry, stale same-turn checkpoints, and Stop followed by fresh work.
A Unix FIFO holds an older turn's actual checkpoint read while a later turn
reaches durable pause; the later turn must still reject input after cleanup
finishes. This interleaving reproduced acceptance of steering after a durable
acknowledgement before the cleanup fix in patch `0053`.

For the lifecycle milestone, the normal macOS ARM64 release build applied all
62 patches and the updated eight-test matrix passed. Actual artifact hashes,
the current ordered patch fingerprint and the generated protocol were verified.
Both history formats now also force a directory-sync failure after atomic
checkpoint replacement. The installed `resuming` record retains its continuation
and confirmed capture identity; permission repair permits live retry and a retry
in another fresh process. No extra provider request or false running status is
allowed during failed preparation. These permission-failure cases require the
native process's directory read access to be denied by the operating system.

A separate FIFO interleaving blocks an older Resume in actual checkpoint I/O
while a newer Pause is requested. The older Resume must fail, the newer Pause
must commit, and no provider request may escape the gate. This reproduced a
successful older Resume in both history formats before the control-generation
fix in patch `0061`.

The fixture also installs a real managed profile and holds fresh native inference
admission after cold restoration. Re-pause cancels that reservation without
ending the original turn; repeated Pause confirms the same stored boundary.
Retry creates a fresh inference scope, rejects the old correctly scoped grant,
and continues the original turn only after its own matching grant. The next
provider request contains the original input and completed tool result once.
Another durable pause and forced restart require another fresh scope. Stop
while admission is pending commits one terminal event without a provider grant;
duplicate Stop, another restart, history inspection and ordinary new work verify
that the stopped continuation cannot reopen. Both completed tool effects and the
original TurnStarted remain unique. Linux and Windows execution of this expanded
matrix remain unverified.

These tests establish the native milestone only. They do not kill and recover a
complete Cantrip worker/server deployment, validate the product Paused indicator,
or establish the remaining resource and terminal-error policies. Those remain
required before the feature can be declared complete.

The shutdown fixture expands the durable cases to paginated and legacy history
under both forced process-tree termination and actual App Server stdin EOF.
It also closes the owner while fresh inference admission is withheld, then
requires a new owner and scope and rejects the abandoned grant. Missing, corrupt
and incompatible expected suspensions are shut down and attached again before
repair, preserving their explicit hold and actual recovery error.

A real SessionEnd command is discovered and trusted through the native hook
APIs. Its output file must remain absent during suspended teardown, while
ordinary completed and active non-suspended EOF controls must execute it. The
active control must retain its normal interrupted history and no suspension.
These controls distinguish continuation preservation from globally disabling
hooks or ordinary cancellation. The expanded matrix passed against the normal
65-patch release bundle on macOS ARM64.

The physical native TUI fixture creates its original input through a real PTY,
completes a side-effecting command, accepts steering, and kills the TUI and native
owner immediately after durable confirmation. It attaches a new owner and PTY
without provider traffic, requires idle thread status and the same unfinished
turn, then explicitly resumes. It checks restored settings, input and tool output,
single tool execution and TurnStarted, and preservation of each format's actual
public history projection. The previous runtime reproduced the false interruption
in both history formats. This fixture exercises the native component; it does not
replace whole-worker product acceptance.

The shutdown milestone's core test-target compilation passed on macOS ARM64
against its 64-patch candidate, including the response-stream fixture's updated
inference argument. The complete 65-patch candidate's App Server library check
also passed after the cold Stop and public history fixes. These checks compile
code; they do not execute native restart scenarios or establish whole-worker
recovery.

The normal 65-patch release build and all 12 native acceptance cases passed on
macOS ARM64: four durable shutdown cases (both history formats under forced tree
termination and stdin EOF), two physical TUI cold-resumption cases, and six shared
GUI/TUI live pause cases. The runtime verifier checked the current patch fingerprint
and packaged artifacts. Original native thread and turn IDs survived the tested
native process-tree termination, without duplicate TurnStarted, accepted input,
completed side effects or tool output. This remains component acceptance rather
than the complete worker/server/client restart guarantee.

Patch `0066` adds sixteen native Goal cases across paginated and legacy history:
live and cold resumption, a budget edit while held, three repeated cold resumptions,
unflushed accepted input and usage, and cold Stop. The Stop cases also cover a
repaired Goal payload stopped before successful restoration, and an unsupported
payload whose exact bytes remain archived with an accounting warning. Reopening
after Stop must remain idle; a later explicit active Goal mutation starts a
distinct new turn. Completed command effects and the original turn start remain
unique before that new user intent.

On macOS ARM64, the normal 67-patch development build and all 28 native cases
passed: sixteen Goal cases, four suspension cases, two physical TUI cases and six
shared-pause cases. Every direct native fixture verifies actual artifact hashes,
the current patch fingerprint and generated protocol. The fifteen accounting
tests, twenty-seven Goal backend tests and SQLite continuation-hold test also
passed. An earlier optimized candidate built successfully and exposed the
Stop/reopen Goal-startup defect; final acceptance of the corrected implementation
used the development profile. Final optimized product validation and complete
worker/server/client recovery remain required before feature completion.

### Finalized CodeMode data

Patch `0072` uses native continuation contract
`0.166.0/cantrip-suspension-v7` and protected resource-data format 2. It retains
finalized CodeMode JSON values, the next cell counter and the public host
generation. These share the worker-encrypted resource envelope with terminal
data and its combined 32 MiB serialized limit. It does not persist JavaScript
isolates, functions, promises, tools, callback routes or execution authority.

Capture asks the actual already-open CodeMode session for its state, serializes
cell admission against capture, and joins completion producers. Running cells
and unconsumed results refuse durable confirmation with instructions to use live
Resume to wait or terminate them and retry Pause. A failed producer or unavailable
host produces an actual error; capture never replaces a lost host with an empty
session. An unused CodeMode service does not start a host during capture.

Attaching remains opaque and inert. Only explicit Resume, after current worker
authorization, may open a CodeMode host and import JSON without executing a cell.
Identical import before execution is retryable; a stale import cannot reset a
used session. Import preserves cell identities and advances the provider's next
host generation. Every Resume attempts CodeMode restoration, including when the
checkpoint-owning native process survives but its helper has died. Terminal
buffers already imported for that checkpoint are retained during retries.
Stop can acquire turn ownership while host IPC is pending; late restoration is
checked against the current turn and control generation before admission.

The gRPC host supports this data-only transfer over TCP and its local
HTTP/2-over-stdio transport. Core selects it with `features.code_mode_host_grpc=true`;
the default local transport is still legacy framed stdio. Providers that do not implement stored-state transfer,
including the legacy framed-stdio provider, return explicit unsupported errors
instead of reporting empty state. Older native checkpoint contracts remain
inspectable and stoppable but require their matching runtime for Resume.

This is a native resource milestone. Implementing the default framed-stdio state
transfer is the next dependency; its current explicit refusal is not completion
of CodeMode recovery. Whole-worker/server recovery, persistent client controls,
MCP and native child policies, and final optimized product acceptance also remain
outstanding.

The 73-patch macOS ARM64 development candidate passed all 62 existing native
acceptance cases and four new CodeMode cases. The gRPC cases cover both native
history formats, two successive process-tree kills immediately after durable
acknowledgement, fresh authorization repair, concurrent Resume, preserved JSON
values, settings and original thread/turn identities, helper-only termination,
and unique input, history results, TurnStarted and external side effects. The
default framed-stdio cases verify explicit refusal plus working live Resume and
Stop. These are native component tests using the real worker resource-protection
handler and actual native processes, not whole-worker/server product acceptance.

The same final candidate passed 207 Rust unit cases (74 client, 43 protocol and
90 runtime) and four real child-host cases, including generation-space
exhaustion without ID reuse. Worker protection checks passed 13 cases. These
results use the normal development build and verified patch fingerprint
`2b69b95f11a9bb82f42fb188e6511dd0f55a1c9ea5f0ecc5ecaa5223c7d6c769`.
The repository check stops at the existing server file budgets; its later stages
did not run. Worker typecheck still reports seven existing errors in unrelated
inference-source, chat-ID and logging code. Optimized production and other
platform validation remain outstanding.

### Default framed-stdio CodeMode continuation

Patch `0073` adds the same data-only state transfer to Core's default local
CodeMode provider. It does not require changing the transport feature flag.
Framed peers negotiate `stored-state-v2`; older hosts that omit that capability
receive no new control frames and return an explicit unsupported error while
ordinary live execution remains available.

The live transport lease retains its fresh session identity. The client's
session registry separately retains the saved public cell namespace, and each
observation keeps its admitted namespace. Successful import commits that mapping
before replying to its caller, including when a reply is lost or the caller
cancels. Identical import remains retryable before execution. Export uses the
existing host only; explicit, freshly authorized Resume may replace a lost host
and import without evaluating source or invoking tools. Both the actual runtime
producers and final framed cell-forwarding producers finish before capture ACK.
Stop does not wait for the state-admission lock.

This milestone uses native checkpoint contract
`0.166.0/cantrip-suspension-v8` and CodeMode state format 2. The cell counter and
public generation are canonical decimal strings on the wire, retaining their
complete native integer range through the worker's JavaScript JSON/encryption
boundary. Ordinary stored JSON values keep their existing semantics. Native
contracts and CodeMode formats from earlier milestones remain preserved and
require their matching runtime for Resume; unsupported data never causes empty
state, prompt replay or a replacement turn. Protected resource-data format 2
and the encryption envelope remain unchanged.

Whole-worker/server/client recovery, MCP and native child policies, other input
producers and final optimized product acceptance remain required. This native
resource milestone does not change the current product pause guarantee.

The normal 74-patch macOS ARM64 development build passed all 66 native
acceptance cases. Both history formats now exercise full repeated cold recovery
through both transports; neither transport uses the earlier refusal-only case.
The cases verify original thread/turn identities, unique input/history/start
lifecycle and external effects, fresh grant repair, concurrent Resume, inert
attachment, helper-only termination and exact decimal cell counters.

The same prepared source passed 264 Rust cases: 77 client, 44 protocol, 90
runtime, 37 host-library, 12 real framed-stdio and four real gRPC cases. The
framed cases include hard-killed helpers, fresh and surviving providers, public
namespaces distinct from fresh lease identities, active-cell refusal and
counter exhaustion. Protocol fault cases cover a canceled import with a late
successful reply, retry against the original lease, foreign-session replies and
older-host capabilities. Fourteen worker crypto/control cases passed, including
large exact identities through the actual encrypted JSON bridge. Native and
focused repository formatting and diff checks passed.

These results use patch fingerprint
`636068ce867f83431b9ca44545ec849981540c5b0eb67ea18242682a02d99072`;
all 16 changed native files match the actual normal prepared source. The broad
repository check remains stopped at existing server file budgets, and worker
typecheck reports seven pre-existing errors in untouched production code.
Later repository-check stages, optimized production and Linux/Windows validation
are not claimed. Complete worker/server/client process-tree recovery remains
unproven and required.

### MCP clients and held startup

Patch `0075` defers initial MCP publication and required-server validation when
native attachment is held by a suspension. Auth changes and background prewarm
retain pending invalidation without publishing connections. Direct Apps catalog
refresh and reconnect return a concrete held-turn error. An uncached required
server can therefore be unavailable while the chat is inspected or stopped.

At capture, the global elicitation service fences new MCP registrations under
the same lock used to count actual outstanding interactions. An outstanding
interaction refuses durable confirmation and retains its responder. The user
can answer it, retry Pause, use live Resume or Stop. The callback permit covers
verification, automated review and automatic approval as well as surfaced forms.
Turn-owned pending interactions retain their existing refusal policy.

After freezing input, capture joins the real MCP publication gate, retires this
thread's publications and joins their client shutdown before committing the
checkpoint. Retired callbacks lose their authority; subscribed event streams
are canceled. Shared clients belonging to other chats retain their own leases.
The thread's response router remains usable for later explicit resumption.
Publication retirement and callback revocation take place under the current
native control generation. Client cleanup survives cancellation of its caller;
Pause joins that cleanup and propagates an actual join failure. Re-pausing a
pending Resume also joins its new clients before acknowledging the retained
checkpoint. No active-turn or control lock is held across client IPC.

Explicit Resume acquires fresh native inference admission before rebuilding MCP
from the attached runtime's configuration and current authentication. It waits
for actual required-server initialization. Failure retains the suspension and
closes that attempt's clients, allowing repair and retry; it does not advance
the model. Stop can supersede restoration while real MCP initialization is
withheld. Native lifecycle cleanup reopens the interaction registry for future
turns without itself starting a server.

MCP connections are fresh sessions. Completed tool results remain in native
history and are not called again during restoration. Server-owned cursors,
subscriptions and opaque handles have no portable snapshot contract: a later
operation uses the fresh server and can report a lost or unknown handle. Cantrip
does not recreate such handles by replaying their original operation. This
patch adds no serialized MCP configuration, credentials, sockets or execution
grants. The native checkpoint and protected-resource formats remain unchanged.

Whole-worker/server/client recovery and the remaining native child/input
producer policies are still required. These native changes do not change the
current product pause guarantee.

The normal 76-patch macOS ARM64 development build passes the default packaged
runtime verifier with fingerprint
`716ba21963ea37c985feb2a78c83f36021f8291e9992f633e8d6715b4edcab4c`.
All 72 native acceptance cases pass: six real stdio MCP cases and the existing
66 suspension, Goal, terminal, CodeMode and shared-control cases. The MCP cases
cover live/cold recovery, completed operations and pending input, a never-started
required server, initialization failure and retry, Stop during withheld real
initialization, and re-pause joining superseded startup processes before ACK.
A trusted SessionStart hook runs initially and stays idle on held attachment.
All 276 MCP Rust tests and 45 Core interaction tests pass; all 12 changed native
files match the actual prepared source and pass focused Rust formatting.

After incorporating Main's worker fixes, worker typecheck and all six shared
GUI/terminal controls pass again, and the current default runtime verification
still passes. `pnpm check` stops at existing server decomposition limits
(`build-app.ts` 1516/1500 and `chat-turn-runtime.ts` 2230/1999); later stages did
not run. Earlier validation caught the now-fixed re-pause race. Earlier MCP
Rust runs failed an existing CLI capability probe; its exact CLI command and the
unchanged suites subsequently passed, as did the final 276-case suite.

After incorporating Main's unused-Goal recovery identity, patch `0076` needed a
context repair around the existing `TaskInputKind` enum. Its intended source
additions and removals are preserved. The combined 77-patch development build
passes the current default verifier with fingerprint
`42387966f377d8ae8e3646265a8eb1169387c53279f930522a9256dec420f6c7`.
All 72 native acceptance cases, 276 MCP Rust tests, 45 Core interaction tests
and worker typecheck pass on this baseline; all 13 intended native files match
the actual prepared source. Three real keeper smoke cases verify same-Goal
unused adoption and rejection of a foreign Goal epoch or a bound native turn.
Those checks cover admission metadata, without claiming complete Goal recovery.

These cases do not yet establish model-facing session-loss notices or recovery
of opaque MCP handles. Those acceptance paths, complete worker/server/client
recovery, optimized production builds and other platforms remain outstanding.
