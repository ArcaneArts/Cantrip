# Tasks and Global Scheduling

## Status

This document is the implementation plan and product contract for Cantrip
Tasks. It replaces the earlier immediate-execution Task design.

Tasks already support two execution modes:

- **Direct** sends the user's prompt to an agent as an ordinary Task without
  planning or Goal mode.
- **Plan + Goal** performs one planning cycle at a time, lets the user review
  and answer questions, and can ultimately start Goal-mode implementation.

The fundamental change is that creating or advancing a Task no longer starts
an agent immediately. Every runnable Task enters a durable, account-global
queue and waits for an eligible Task Worker with available capacity.

## Product language

Use **Task** for every user-facing unit of work, regardless of whether it is a
Direct Task or a Plan + Goal Task. Do not introduce user-facing terms such as
work item, job, dispatch, or workload item.

Use these names in the app:

- **Tasks** for the Project Overview tab.
- **Tasks** for the global Settings tab that owns Task-related settings.
- **Task Workers** for the configurable model and concurrency profiles inside
  Settings > Tasks.
- **Workers** for the existing physical machines. This feature does not rename
  or replace them.

Internal scheduling records may use implementation-specific names, but those
names must not leak into the UI or user-visible errors.

## Product principles

- Direct is the default Task mode.
- Plan + Goal is opt-in and switched off by default.
- Creating a Task only queues it.
- Continuing planning or beginning implementation only requeues the next Task
  cycle.
- Task Worker concurrency is enforced globally across every Project in the
  account.
- Execution is oldest-eligible-first FIFO and never uses display priority.
- The Project Tasks tab has one active list and one Completed list.
- Task prompts, plans, answers, and messages remain end-to-end encrypted.
- No Task Worker is created automatically. Task execution remains inert until
  the user explicitly configures at least one.

## Task creation

The new Task surface contains:

- the Task prompt;
- attachments and the existing implementation access controls;
- a **Plan + Goal** switch, off by default;
- a **Task Worker** selector, set to **Auto** by default, with configured Task
  Workers available as explicit choices; and
- a priority number, defaulting to `0`.

The primary action is **Add Task**. It persists the encrypted Task and queues
its first cycle. It does not prepare or start an agent turn synchronously.

For a Direct Task, the first queued cycle is `direct`. For a Plan + Goal Task,
the first queued cycle is `initial-plan`.

The current Task-level model and reasoning picker is replaced by the Task
Worker selector. Model, reasoning, subagent model, and subagent reasoning are
owned by Task Worker configuration.

## Settings > Tasks

Add a new top-level Settings tab named **Tasks**. Task Workers are the first
settings group in this tab, leaving room for future global Task settings.

### Task Worker configuration

Each Task Worker contains:

- a user-defined name;
- an enabled state;
- root model and reasoning effort;
- optional custom subagent model and reasoning effort;
- maximum concurrent Task count;
- whether it may run Plan + Goal Tasks;
- configured ordering for Auto assignment; and
- a persisted root-model continuity family.

Every Task Worker can run Direct Tasks. The Plan + Goal setting determines
whether it can additionally run Plan + Goal Tasks.

Maximum concurrency must be a positive integer. Changing it affects future
claims immediately. Lowering it below the number of active claims does not
interrupt Tasks; it prevents new claims until usage falls below the new limit.
New Task Workers default to a maximum concurrency of `1` and Direct-only
eligibility; the user may raise concurrency or enable Plan + Goal explicitly.

Task Workers referenced by Tasks or historical executions must be disabled or
soft-deleted rather than removed destructively.

### Continuity family UX

The continuity family lets compatible versions of the same root-model family,
such as Grok 4.5 and Grok 4.6, continue an Auto-assigned Task at a safe cycle
boundary. It prevents incompatible changes such as GPT to Grok or Grok to GLM.

Continuity must not add friction to ordinary setup:

- infer and persist a suggested family from trusted catalog metadata;
- hide the value under an Advanced control;
- let the user override it when catalog metadata is missing or incorrect; and
- fall back conservatively to the exact root model profile when no safe family
  can be inferred.

The user is never required to type or understand a continuity-family value to
create a Task Worker.

The root model determines Task continuity. A custom subagent remains governed
by the existing rule that root and subagent routes must share an enabled
provider and provider account for that Task Worker.

### No automatic default

Cantrip must not create a default Task Worker from account model defaults.

When no Task Workers exist, Project > Overview > Tasks shows a centered empty
state explaining that Tasks require a configured Task Worker. Its **Configure
Task Workers** button opens Settings > Tasks directly at the Task Workers
section.

If historical Completed Tasks exist, they remain accessible below the
configuration empty state.

## Project Overview > Tasks

Add **Tasks** to the Project Overview navigation for both Git-backed Projects
and folder Projects. It must not be hidden merely because Git or GitHub is
unavailable.

The tab contains a header action for pausing or resuming Project Task work and
exactly two lists:

1. one active Tasks list containing Needs Attention/Input, Running, and Queued
   Tasks; and
2. one Completed list below it.

Avoid separate sections for each active state. Status is expressed by each row
and by row ordering.

### Active-list ordering

Sort the active list by:

1. status rank: Needs Attention/Input, then Running, then Queued;
2. priority descending;
3. Task `createdAt` descending; and
4. Task ID as a stable final tie-breaker.

Priority is display-only. It does not change scheduling order.

Paused is an overlay on the Task's underlying active status rather than a
third list. When the Project queue is paused, rows retain their underlying
ordering and show a Paused badge or queue-level paused treatment.

The Needs Attention/Input display rank includes:

- a Plan + Goal Task waiting for plan review, answers, Continue Planning, or
  Begin Implementation;
- a Task waiting for an approval or agent interaction;
- a blocked Task; and
- a failed Task that can be retried or needs configuration changes.

A Task waiting for plan review has released its Task Worker slot. A live turn
waiting for approval still owns its slot unless the Project or Task is
cooperatively paused.

### Completed-list ordering

Completed Tasks are separated below the active list and ordered by
`completedAt` descending, with Task ID as a stable tie-breaker. Archived Tasks
are excluded.

### Task rows

Each Task row shows enough information to understand and act on it without
opening the Chat:

- decrypted title or prompt summary;
- Direct or Plan + Goal mode;
- current status;
- priority;
- Auto or explicitly assigned Task Worker;
- currently claimed Task Worker when running or paused;
- creation time and relevant running/completion time;
- the agent's **Steps x of y** progress when the root agent has published a
  plan; and
- a compact root-agent trajectory bar for the active or most recent turn.

Do not synthesize Steps x of y when the agent has not published plan steps.
Reuse the existing plan-progress interpretation so Chat and Tasks show the
same values.

The trajectory bar is a compact projection of the existing encrypted root
trajectory. It should not create a separate server-side plaintext activity
model.

Selecting a row opens the existing Task-backed Chat surface. Queued rows expose
editing actions. Needs Attention rows expose their relevant review, approval,
retry, or resume action.

## Task assignment

Every Task stores one of two assignment policies:

- **Auto** allows any eligible Task Worker to make the first claim.
- **Pinned** allows only the selected Task Worker to claim any cycle of that
  Task.

An explicitly pinned Task never falls back to another Task Worker.

For an unclaimed Auto Task, if multiple eligible Task Workers have capacity,
configured Task Worker order is the tie-breaker. The first eligible configured
profile claims the Task; when it has no capacity, evaluation continues through
the configured order.

After an Auto Task's first claim, future claims at safe cycle boundaries may
use another Task Worker only when its persisted continuity family matches the
Task's claimed continuity family.

## Scheduler contract

The server is the authoritative scheduler. Physical Workers execute claimed
turns but do not independently decide queue order or capacity.

### Eligibility first, FIFO second

For each available Task Worker slot, the scheduler first filters queued Tasks
to those eligible for that slot. It then selects the oldest eligible Task by:

1. Task `createdAt` ascending; and
2. Task ID as a stable tie-breaker.

Eligibility is a filter, not a ranking signal. Priority, the latest requeue
time, Project identity, and active-list display order must not influence
execution order.

This prevents head-of-line blocking across incompatible pools. For example, a
newer Direct Task may run on an idle Direct-only Task Worker while an older
Plan + Goal Task waits for a Plan + Goal-capable Task Worker.

### Eligibility rules

A Task Worker is eligible only when all of the following are true:

- the Task is queued and has no active claim;
- the Project Task queue is not paused;
- the Task Worker is enabled and has free global capacity;
- the Task assignment is Auto or explicitly names this Task Worker;
- the Task Worker supports the Task's Direct or Plan + Goal mode;
- any previously claimed Auto continuity family matches;
- the root and optional subagent model configuration resolves successfully;
- the required provider route and account are available on the Project's
  current physical Worker; and
- the Project placement, worktree, permissions, attachments, and encryption
  grants are ready for execution.

Ollama and other worker-local providers are eligible only when available on the
Project's current physical Worker. The scheduler does not automatically
relocate a Project, worktree, or Task to satisfy a Task Worker. An ineligible
Task remains queued and the UI exposes the reason when user action can resolve
it.

### Global semaphore

Task Worker concurrency is account-global. A Task Worker configured with a
maximum count of four can own at most four active claims across all Projects,
not four per Project or four per server process.

Implement capacity with durable database coordination:

- transactional claim selection;
- row locking or an equivalent database-backed semaphore;
- `SKIP LOCKED`-style contention handling where supported;
- lease expiration and heartbeats;
- fencing tokens on worker completion and mutation calls; and
- restart reconciliation for expired or orphaned claims.

The scheduler must remain correct with multiple server instances and multiple
physical Workers connected concurrently.

### Configuration snapshots

Every claim snapshots the Task Worker revision, root/subagent configuration,
reasoning efforts, provider route, physical Worker placement, worktree, and
continuity family used for the cycle.

Editing a Task Worker affects future claims only. A running or paused turn must
continue against its claim snapshot.

## Task and scheduling persistence

Keep the existing Task phase state machine and add an independent scheduling
lifecycle. Do not overload phase states such as `review` or `implementing` to
represent queue leases.

### Task fields

Extend durable Tasks with at least:

- `priority`, integer, default `0`;
- `requestedTaskWorkerId`, nullable for Auto;
- `continuityFamily`, nullable until the first Auto claim;
- `lastTaskWorkerId`, nullable until claimed;
- `completedAt`, nullable;
- scheduler and optimistic row revisions; and
- any public encrypted-content classifications needed for eligibility without
  revealing Task content.

The existing immutable Task `createdAt` is the scheduling timestamp for every
cycle of that Task.

### Task Worker fields

Persist Task Workers as account-scoped records with:

- identity, name, enabled/deleted state, and configured position;
- root/subagent model configuration and reasoning;
- maximum concurrency and Plan + Goal permission;
- inferred or overridden continuity family;
- row/configuration revision; and
- creation and update timestamps.

### Dispatch-cycle fields

Persist one internal dispatch cycle for each queued agent operation. A cycle
needs:

- Task and operation identity;
- operation kind: `direct`, `initial-plan`, `continue-plan`, `finalize`, or
  Goal continuation;
- queue, claim, running, paused, succeeded, failed, cancelled, and expired
  state as required;
- immutable Task FIFO timestamp;
- requested, selected, and snapshotted Task Worker data;
- physical Worker and model-route affinity;
- lease owner, expiration, heartbeat, attempt count, and fencing token;
- retryable eligibility/failure reason; and
- queued, claimed, started, paused, completed, and updated timestamps.

These records are not displayed as a second kind of Task.

### Project pause state

Persist Project Task pause state independently from individual Task and Chat
pause state. Track pause sources so resuming Project Tasks removes only the
Project-level pause and cannot override a Task the user paused individually.

## Direct Task lifecycle

The Direct lifecycle is:

```text
Add Task
  -> queued
  -> eligible Task Worker claim
  -> implementing/running
  -> complete
```

The claimed worker decrypts the exact current prompt and supplies it as an
ordinary Task turn. It adds no planning wrapper, planning review, Goal prompt,
or Goal record.

On successful durable assistant completion, set the Task to `complete`, set
`completedAt`, finish the dispatch cycle, and release the slot.

Failures release the slot after durable reconciliation and place the Task in
Needs Attention with a safe Retry action. Retry requeues the Task using its
original `createdAt`.

## Plan + Goal lifecycle

Plan + Goal is a sequence of separately scheduled cycles over one durable Task
and one encrypted conversation.

### Initial planning

```text
Add Task
  -> initial-plan queued
  -> eligible Task Worker claim
  -> planning/running
  -> plan and questions durably accepted
  -> review/Needs Attention
  -> slot released
```

One claim performs one planning cycle. It does not continue planning
automatically after producing a plan or questions.

### Continue planning

After the user edits the plan, answers questions, or adds instructions,
**Continue Planning** creates a new `continue-plan` cycle and returns the Task
to Queued. It does not start immediately and does not change Task `createdAt`.

The next compatible Task Worker receives the existing encrypted conversation,
plan, questions, answers, and cycle state. When the cycle finishes, the Task
returns to Needs Attention and releases capacity again.

### Begin implementation

**Begin Implementation** creates a queued `finalize` cycle. It does not
immediately finalize the plan or start Goal mode.

When claimed, finalization incorporates the reviewed plan and answers into the
Goal prompt. Goal creation must remain idempotent. Once the Goal is durably
accepted, the same claim and Task Worker continue to own implementation until
the Goal:

- completes;
- blocks or needs user attention;
- fails terminally; or
- is cooperatively paused.

The finalization-to-Goal transition must not release the slot or allow another
Task Worker to interleave between those operations.

### Conversation continuity

All cycles retain the same Task-backed Chat, encrypted transcript, planning
rounds, plan state, answers, attachments, and Goal linkage.

At a safe idle cycle boundary, an Auto Task may start a fresh worker-specific
Codex runtime thread when moving to another Task Worker in the same continuity
family. The next cycle must include enough durable encrypted context to remain
self-contained when opaque Codex runtime context cannot be resumed.

Pinned Tasks always use their exact Task Worker. Auto Tasks never cross their
claimed continuity family.

## Editing queued Tasks

The user may edit a Task prompt and attachments only while the Task is queued
and unclaimed. Priority and assignment may also be edited while queued.

Use optimistic row versions and the scheduler claim transaction as the final
authority:

- an edit that commits first updates the encrypted Task snapshot seen by the
  eventual claimant;
- a claim that commits first causes the edit to fail with a clear message that
  the Task has started; and
- a Task Worker must decrypt and prepare the operation after claiming the
  latest snapshot, not from a stale envelope created when the Task was added.

Do not change `createdAt` when editing, reprioritizing, retrying, continuing
planning, or beginning implementation.

## Pause and resume

Project > Overview > Tasks provides **Pause Tasks** and **Resume Tasks**.

### Pausing

Pausing Project Tasks must:

- persist the Project pause before allowing new scheduling decisions;
- prevent all queued Tasks in that Project from being claimed;
- cooperatively pause every active Task turn in that Project at a safe Codex
  boundary;
- record exact Task Worker, physical Worker, model route, provider account,
  thread, and turn affinity for each paused live turn; and
- release each paused Task's logical Task Worker slot after pause is durably
  acknowledged.

A paused resident Codex turn is not counted against Task Worker concurrency,
so another Task may use the released logical slot.

### Resuming

Resuming Project Tasks removes only the Project pause source and makes queued
Tasks eligible again.

A Task paused mid-turn must return to the same Task Worker and the same
physical Worker, model route, provider account, Codex thread, and turn. Resume
must:

1. wait until that exact Task Worker has capacity;
2. reacquire a fenced logical slot;
3. verify the original physical Worker and runtime affinity are available; and
4. send native resume to the existing turn.

If the original physical Worker or route is offline, the Task remains paused
and shows the reason. Same-family switching is allowed only between completed
cycles, never while moving a paused live turn.

Disabling a Task Worker with paused Tasks does not orphan them. The profile and
claim snapshot remain durable, and resume waits for the exact profile to become
available or for a future explicit idle-boundary migration flow.

## Encryption and trust boundaries

The server may know only the public classifications required to schedule a
Task, including mode, phase, queue state, priority, Task Worker assignment,
continuity family, timestamps, operation kind, and lease metadata.

The server must not receive plaintext Task prompts, plans, questions, answers,
Goal prompts, messages, progress explanations, or trajectory content.

At claim time, a trusted authorized physical Worker obtains the latest
encrypted Task snapshot, verifies its grant, decrypts it, and prepares the
worker operation. The scheduler must not depend on an interactive app client
remaining online after Task creation.

Prompt edits re-encrypt content and rotate or refresh any worker-readable
envelope required by the existing Task encryption design. Authorization must
remain account- and Task-scoped and must not grant a Worker blanket access to
unrelated Tasks.

## Live updates and projections

Add a Project Task live resource that invalidates or patches the Tasks tab when
any of these change:

- Task content classification, phase, priority, assignment, or completion;
- queue, claim, lease, pause, retry, or eligibility state;
- Task Worker configuration or capacity;
- planning rounds, questions, answers, or review state;
- Chat messages, plan steps, approvals, interactions, or Goal state; and
- root trajectory activity.

Use a batched Project query rather than one request per row. The response may
contain opaque Task summaries and the bounded encrypted current-turn material
needed for client-side Steps x of y and trajectory projection.

Reuse the existing client decryption cache and plan/trajectory derivation.
Invalidate cached projections when their encrypted source revision changes.

## Failure, recovery, and fairness

- Duplicate scheduler wakeups and worker completions are idempotent.
- A fencing token prevents an expired claimant from completing a newer cycle.
- Lease expiry returns safe unstarted work to Queued or reconciles a possibly
  started turn before retrying.
- A recovered planning result cannot create two planning rounds.
- A recovered finalization cannot create two Goals.
- Worker or provider unavailability leaves the Task queued or paused with an
  actionable eligibility reason.
- A failed Task appears in Needs Attention and never silently loses its
  original FIFO timestamp.
- Archived or completed Tasks cannot be claimed.
- Per-profile global FIFO may skip Tasks ineligible for that profile, but must
  not skip an older eligible Task for a newer eligible Task.

## Migration

The migration must preserve current encrypted Tasks and avoid duplicate turns:

- add Task Worker and scheduling tables without creating a default Task Worker;
- backfill completed Task `completedAt` from the strongest available durable
  completion timestamp, falling back to Task `updatedAt` when necessary;
- map existing Direct and Plan + Goal drafts to Queued cycles;
- map existing review, blocked, and retryable failed Tasks to Needs Attention;
- leave all queued work inert until the user creates an eligible Task Worker;
- allow operations already active during deployment to finish through their
  existing execution ownership, then reconcile them into the new lifecycle;
  and
- never create a second operation for an existing active Task.

Migration and compatibility parsing must accept old clients long enough to
show an upgrade-required error instead of accidentally launching work through
the obsolete immediate-execution path.

## Implementation sequence

Implement this feature in independently reviewable milestones while preserving
the complete contract:

1. **Protocol and persistence:** Task Worker schemas, Task scheduling fields,
   dispatch cycles, Project pause state, migrations, and compatibility parsing.
2. **Task Worker settings:** Settings > Tasks navigation, Task Worker CRUD,
   model/subagent validation, capacity controls, order, and automatic
   continuity-family inference.
3. **Scheduler foundation:** global semaphore, eligibility, FIFO claims,
   leases, fencing, reconciliation, and worker command contracts.
4. **Queued Task creation:** Direct default, Plan + Goal switch, Auto/pinned
   assignment, priority, queued prompt editing, and removal of immediate start.
5. **Plan + Goal cycles:** planning review release, Continue Planning requeue,
   Begin Implementation requeue, finalization-to-Goal ownership, and continuity
   boundaries.
6. **Pause and resume:** Project-wide pause, native active-turn pause, capacity
   release/reacquisition, exact mid-turn affinity, and pause-source handling.
7. **Project Tasks UI:** two-list dashboard, empty state, ordering, row actions,
   progress, trajectory, attention states, and live invalidation.
8. **Migration and hardening:** legacy active-operation reconciliation,
   multi-server contention, offline workers, failure recovery, performance, and
   end-to-end acceptance coverage.

Each milestone must be delivered through an isolated worktree and pull request
with squash auto-merge, following the repository manual-change protocol.

## Validation matrix

### Scheduler and persistence

- global concurrency across at least three Projects sharing one Task Worker;
- independent concurrency limits across multiple Task Workers;
- FIFO by original Task creation time;
- priority affecting display but not execution;
- direct-only eligibility skipping an older Plan + Goal Task;
- Auto assignment order and exact pinned assignment;
- same-family Auto handoff at a safe cycle boundary;
- incompatible-family handoff rejection;
- claim/edit races and optimistic conflicts;
- multi-server claim contention;
- lease expiry, fencing, and stale completion rejection; and
- no dispatch when zero Task Workers are configured.

### Task lifecycle

- Direct Task queues, runs once, and completes without planning or Goal state;
- initial planning consumes one cycle and returns to Needs Attention;
- Continue Planning requeues without changing `createdAt`;
- Begin Implementation requeues before finalization;
- finalization creates at most one Goal and retains its slot into Goal mode;
- retry preserves the original FIFO timestamp;
- archived and completed Tasks are never claimed; and
- queued prompt edits are visible to the eventual claimant.

### Pause and runtime continuity

- Project pause prevents new claims;
- all active Project Task turns receive a cooperative pause request;
- acknowledged pauses release logical capacity;
- resume waits for exact Task Worker capacity;
- a mid-turn resume uses the same physical Worker, route, provider account,
  thread, and turn;
- offline affinity leaves the Task safely paused;
- Project resume does not override an individual pause; and
- another Task may use capacity released by a paused Task.

### App

- Tasks tab appears for Git and folder Projects;
- no-worker empty state routes to Settings > Tasks;
- active rows sort by status, priority, then newest creation time;
- Completed sorts by newest completion time and excludes archived Tasks;
- queued edit actions disappear or conflict cleanly after claim;
- Needs Attention actions open the correct review or interaction surface;
- Steps x of y matches the Chat projection;
- root trajectory updates without per-row request fan-out; and
- desktop, mobile, and popout Project Overview navigation remain consistent.

### Encryption and authorization

- the server never receives protected Task or trajectory plaintext;
- only an authorized claimed Worker can decrypt the latest Task snapshot;
- editing a queued Task cannot leave a stale executable envelope;
- assignment and Project ownership are enforced server-side;
- provider and worker-local route availability are checked at claim time; and
- cross-account Task Worker capacity or claims are impossible.

## Acceptance criteria

- Adding any Task queues it and never starts an agent immediately.
- Direct is the default and Plan + Goal is opt-in.
- Tasks default to Auto assignment and can be pinned to one Task Worker.
- Queued Tasks can be edited until an atomic claim succeeds.
- Task Worker limits are enforced account-wide across all Projects.
- Scheduler execution is oldest eligible Task first and ignores priority.
- Display order is Needs Attention/Input, Running, Queued; then priority
  descending and creation time descending within each status.
- Completed is the only separate list and is ordered by completion time.
- Each planning cycle releases capacity for user review.
- Continue Planning and Begin Implementation requeue using the original Task
  creation timestamp.
- Auto Tasks may change Task Workers only within the same persisted continuity
  family and only at safe cycle boundaries.
- Pinned Tasks always use their selected Task Worker.
- Paused Tasks release logical capacity and resume mid-turn on the same Task
  Worker and physical runtime affinity.
- Ollama and other local routes never cause automatic Project relocation.
- Steps x of y and the root trajectory are visible live in Task rows when the
  underlying agent data exists.
- Settings has a Tasks tab with Task Workers and creates no automatic default.
- With no Task Workers, the Tasks tab shows a centered configuration action.
- Task content remains end-to-end encrypted and the server schedules from
  public classifications only.

## Non-goals

- Priority-based execution ordering.
- Automatic Project, repository, worktree, or active-turn relocation to satisfy
  a Task Worker.
- Moving a paused live Codex turn to a different physical Worker or provider
  route.
- Requiring users to manually classify model families during normal setup.
- Creating a default Task Worker from account model settings.
- Introducing a second user-facing work-item or dispatch abstraction.
- Decrypting Task content, plan progress, or trajectory data on the server.
