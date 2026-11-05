# Durable native turn suspension

## Delivery status

This feature is being implemented in sequential, independently merged milestones.
The checkpoint storage foundation is implemented in patch `0048`; patch `0051`
connects native capture and original-ID restoration through experimental native
operations. Patch `0053` adds stored inspection, explicit attachment holds and
terminal-history-based retirement of unreadable records. Patch `0061` retains
continuations through resumption preparation and binds controls to their native
turn and generation. Patch `0064` preserves a held continuation through native
runtime teardown and transport EOF. Cantrip's current
product pause remains an in-memory execution gate until the worker/server/client
integration is delivered. Do not treat the
existing product acknowledgement as a process-termination guarantee.

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
requires implementation and acceptance.

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
`0.166.0/cantrip-suspension-v3`. The confirmed capture revision is stored inside
the continuation and remains stable across preparation retries. The store's
physical revision still advances for each committed lifecycle write and supplies
its compare-and-replace fencing. Native control descriptors identify the capture;
they do not turn a newer lifecycle write into a replacement checkpoint.
Earlier suspended contracts produce an explicit compatibility error and retain
their bytes; Stop can still retire them using committed native history.

Original initial, next-step and already-pinned
pending-step settings are restored under the fresh runtime's constraints and
environment requirements. Changing future thread defaults while a turn is
suspended does not change that turn's captured settings. The restoration marker
applies only to the saved turn and is removed from defaults before a subsequent
ordinary turn. Runtime credentials and inference admission are acquired afresh.

A cold native attachment establishes the pause gate before model prewarm or
automatic input admission. Explicit Resume uses the original-ID native recovery
reservation and enters the shared sampling loop without repeating the turn-start
lifecycle. Extension-owned continuation bookkeeping remains a separate milestone.
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
