# Tasks and scheduling

## Task configuration

A Task is a durable, encrypted project Chat. Each Task owns its model
configuration: root model, reasoning effort, optional subagent model, and
subagent reasoning effort. New Tasks inherit account model defaults and expose
the model/reasoning picker in their draft options. Model choice is saved with
the brief, attachments, priority, and Plan + Goal selection.

**Direct** is the default and runs one ordinary Agent turn. **Plan + Goal** is
opt-in for every configured model. It runs read-only planning and question
rounds, lets the user review/edit the plan, and finalizes into implementation
on the same native conversation. Planning/finalization use the read-only
execution profile; implementation uses the Task's Implementation access choice.

Task Worker presets, Auto/Pinned preset assignments, preset enable switches,
continuity families, Plan + Goal capability flags, and task-worker concurrency
limits are retired. Settings has no Tasks category or preset CRUD endpoints.
Physical Workers still host files, worktrees, PTYs, encryption keys and native
agent runtimes; they are distinct from the retired model presets.

## Scheduling

Creating a Task saves its draft. Submitting or advancing a Task queues a durable
dispatch cycle. The account scheduler claims the oldest eligible cycle first.
Display priority affects list ordering, not execution ordering.

There is no task-worker or per-model semaphore. If ten Tasks are runnable, all
ten may be claimed and run as soon as their execution contexts are available.
Model-level concurrency controls are future work and are not implemented here.

Actual execution constraints remain in force:

- The account owns the Task, Project and selected model configuration.
- Archived/completed Tasks cannot be claimed.
- Explicit Project/Task pauses are respected.
- A Task has at most one active dispatch and native execution lane.
- The bound worktree and physical Worker must be usable; actual branch/execution
  leases prevent conflicting turns from modifying the same execution context.
- Provider routes, credentials, reasoning and subagent configuration must resolve
  for the selected model on the physical Worker.
- A physical Worker needs authorization for encrypted Task content.

A missing provider, offline worker or conflicting execution context leaves the
Task queued with its eligibility reason. Scheduling does not relocate projects
or worktrees just to satisfy a model route.

Each claim snapshots the Task's complete model configuration, provider route,
provider account, physical Worker and worktree. A queued edit advances the
cycle's fence and updates the configuration atomically with the encrypted draft.
Prepared routing results are checked against that configuration and fence.
Running/paused cycles retain their snapshot instead of following later defaults.

## Lifecycle and recovery

Direct Tasks advance from draft/queued to implementation and completion. Plan +
Goal Tasks advance through planning, review/question rounds, finalization and
Goal implementation. Continuing planning and beginning implementation queue a
new cycle using the Task's original creation time as FIFO age. Planning results,
finalizer results, and Goal launch receipts remain idempotent.

Pausing retains the exact physical Worker, model route, provider account, native
thread and native turn. Resume uses that affinity while other Tasks continue;
it does not acquire a model/preset slot. Offline affinity remains paused until
usable. Project resume does not override an individual pause or pending input.

Dispatches retain lease ownership, lease deadlines, heartbeat timestamps and
monotonically increasing fencing tokens. Duplicate scheduler wakeups cannot
claim the same cycle twice. Expired unstarted claims can be queued again;
possibly started turns are reconciled before retry. Stale claimants cannot
complete or alter a newer execution. Retrying a saved finalized Goal reuses its
canonical encrypted objective and does not repeat planning/finalization.

Technical failures use the existing durable retry policy: a five-second delay,
five automatic attempts in a rolling minute, and a user-controlled retry latch.
User pauses, pending input, genuine Goal blockers, configuration errors, and
usage/budget limits retain their existing behavior. No retry raises a budget,
clears a pause, or silently changes the selected model.

## UI and observability

Project Tasks shows Active, Failed and Completed lists. Active display ordering
prioritizes attention/input, running and queued states, then display priority and
creation time. Failed and Completed retain separate ordering. Rows show the
selected model, Task mode, priority, plan progress, and root trajectory.

Queued drafts stay editable until an atomic claim wins. Close flushes pending
changes, and stale revisions report a conflict instead of overwriting another
client. Hidden/covered Task surfaces suspend polling, history subscriptions and
trajectory clocks while retaining their draft and cached state.

Overview exposes the latest thought, live state, progress, elapsed time and
worker-observed Git metrics. Files/lines changed describe the bound worktree's
commits in the Task's time window plus current working-tree changes, including
changes made by other processes in that checkout. Unavailable observations are
shown as unavailable rather than zero. Requests use the existing encrypted
repository-operation channel.

## Encryption and trust

The server stores and routes encrypted Task prompts, plans, questions, answers,
Goal objectives, messages and trajectories. It schedules from public
classifications and model/routing metadata, without opening protected content.
Authorized physical Workers decrypt and prepare the latest Task operation after
claim; the app does not need to stay online for execution.

Queued edits regenerate the encrypted snapshot and retain optimistic revision
checks. Grants remain account- and Task-scoped. Plan/trajectory projections reuse
the client decryption cache and batched Project workload query. Overlapping Live
invalidations coalesce into a trailing refresh rather than restarting reads.

## Persistence and upgrade

`tasks.model_configuration` is the canonical durable Task selection. Dispatch
cycles snapshot it when claimed. Project pause state retains its own revision.
Task content, planning rounds, operation IDs, history and native Goal receipts
keep their existing storage and ownership boundaries.

Migration `0236_direct_task_models` copies live/paused snapshots first, then an
explicit legacy assignment, previous execution/automatic assignment, an eligible
legacy automatic default, or the Chat's existing defaults. Queued cycles receive
the migrated selection. Task assignment fields are cleared, and retired presets
cannot retain foreign keys that prevent deleting unrelated models.

Historical preset tables, read-only wire fields and repository codecs remain
for database/fixture compatibility. Production settings routes, task creation,
draft updates, scheduling, resume and Goal recovery never select a preset or
consult its enabled/capability/concurrency flags.

## Validation

- UI model and Plan + Goal changes survive encrypted autosave and close/reopen.
- Ten Tasks can be claimed with no configured presets, including Plan + Goal.
- Claims follow FIFO while independent Tasks execute concurrently.
- Competing PostgreSQL schedulers retain ownership/fencing without a global slot.
- Queued edits invalidate stale prepared configuration and cannot race past claim.
- Paused tasks resume their exact native affinity alongside other active Tasks.
- Upgrade preserves explicit selections, in-flight snapshots and Chat defaults.
- Native/Node differential checks cover dispatch, eligibility and retired routes.
- Encryption, planning/review, Goal launch, retry, pause and recovery tests remain
  applicable; the server never needs protected Task plaintext.
