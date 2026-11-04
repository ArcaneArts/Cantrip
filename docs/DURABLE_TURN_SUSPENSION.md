# Durable native turn suspension

## Delivery status

This feature is being implemented in sequential, independently merged milestones.
The checkpoint storage foundation is implemented in patch `0048`; patch `0051`
connects native capture and original-ID restoration through experimental native
operations. Cantrip's current product pause remains an in-memory execution gate
until the worker/server/client integration is delivered. Do not treat the
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

Lifecycle states are `suspended`, `consumed`, and `invalidated`. Settlement drops
the continuation and retains a tombstone. A settled checkpoint ID cannot be
reopened. A later suspension uses a new checkpoint ID and revision. Unsupported
formats, incompatible suspended runtimes, and corrupt records remain on disk and
return explicit errors. Settled records do not block later runtime upgrades.
The runtime still needs to validate the actual history and lifecycle evidence;
the store alone cannot establish that a turn remains unfinished.

## Native continuation primitives

Patch `0051` adds the experimental native `turn/suspension` operation. Its
`pause` action names the active native turn and returns a checkpoint identity
only after native history and the continuation are committed. `read` inspects
that identity without starting execution. `resume` requires the exact thread,
turn, checkpoint and revision. `discard` records Stop in native terminal history,
including when an incompatible or corrupt continuation cannot be decoded.
These primitives do not yet replace Cantrip's product pause operation; the
worker/server/client integration remains a separate delivery milestone.

The continuation retains pending accepted inputs with native metadata, the
sampling-loop decisions, cumulative file diff, selected and pinned step settings,
turn timing and token accounting, retained input order, reasoning-effort pinning,
and the active compaction window. The persisted native history remains the
conversation authority. A SHA-256 binding covers its committed prefix, and
actual native start/terminal events fence stopped or superseded work.
Both paginated and legacy storage supply their full committed native history;
the checkpoint does not bind only the model's compacted context suffix.

The current native continuation contract is
`0.166.0/cantrip-suspension-v2`. Original initial, next-step and already-pinned
pending-step settings are restored under the fresh runtime's constraints and
environment requirements. Changing future thread defaults while a turn is
suspended does not change that turn's captured settings. The restoration marker
applies only to the saved turn and is removed from defaults before a subsequent
ordinary turn. Runtime credentials and inference admission are acquired afresh.

A cold native attachment establishes the pause gate before model prewarm or
automatic input admission. Explicit Resume uses the original-ID native recovery
reservation and enters the shared sampling loop after turn-start contributors.
It reconstructs fresh runtime handles, acquires fresh inference admission, and
waits for restoration readiness before acknowledging resumption. It does not
submit the original user prompt or emit another native TurnStarted event.
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
Complete terminal invalidation and corrupt/incompatible-checkpoint acceptance,
including an ordinary new turn after explicit Stop. No supported path may
duplicate TurnStarted, accepted input, completed tools or
history items, retain old execution authorization, or advance merely on attach.

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

The current inspection primitive requires an attached native thread. Add stored
checkpoint inspection without starting a session, and carry the server's expected
suspension into native attachment before prewarm or autonomous admission. A
successful earlier inspection alone cannot keep attachment idle if its checkpoint
subsequently disappears. Missing or unreadable data must retain the explicit pause
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

On macOS ARM64, the release bundle built from all 51 patches passed eight tests:
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
turn and starts a normal next turn. A further durably paused turn is explicitly
stopped; after process restart its old checkpoint cannot resume and an ordinary
new turn can complete. Attachment and read operations are checked for unintended
provider requests.

These tests establish the native milestone only. They do not kill and recover a
complete Cantrip worker/server deployment, validate the product Paused indicator,
or establish the remaining resource and terminal-error policies. Those remain
required before the feature can be declared complete.
