# Tasks

## Status and dependency

This document designs the Cantrip Task experience. It assumes the Policy system
in [POLICIES.md](POLICIES.md) has already been fully implemented, merged, and
validated. Policies are intentionally implemented first as an independent
effort. Task implementation should be revisited against the final Policy APIs
before its first code milestone begins.

Tasks automate the user's existing large-job workflow:

1. write a broad idea/brief;
2. let an Agent investigate and propose a Markdown plan;
3. answer material questions;
4. continue planning as many times as useful;
5. optionally edit the plan directly;
6. finalize the plan and generate a Goal prompt;
7. automatically submit that prompt to the same Agent in Goal mode;
8. observe implementation, PRs, pauses, and completion from one durable tab.

A Task looks like a new project tab type, but it is implemented as a specialized
Chat experience. Cantrip does not create a second agent runtime or separate
transcript system.

## Product model

### Task-backed Chat

Add an experience field to Chat:

    agent
    task

Existing and ordinary chats use agent. A Task creates a normal Chat with
experience task and an attached Task record.

Internally, project tab layout continues to use:

    chat:<chat-id>

This deliberately avoids adding a second project-tab member kind. Task-backed
Chats already inherit:

- project/worktree/worker placement;
- model and reasoning selection;
- implementation permission profile;
- attachments;
- Codex thread/runtime;
- normalized transcript and activity;
- Agent Inspector data;
- linked Codex console;
- prompt pause/resume/stop;
- Goal mode;
- relocation and attachment replication;
- tab groups, reordering, popout, archive, and deletion.

The UI renders a Task icon/title and Task surface when the backing Chat has
experience task.

### View toggle

Only Task-backed Chats show a compact **Task / Chat** toggle in the content
header.

- Task is the default view for a newly created Task.
- Chat shows the real underlying Agent transcript and activity.
- Ordinary Chats do not show the toggle.
- View choice is per Task/per application-window session, like other
  presentation state; it does not change the Task's durable state.
- During Draft, Planning, Review, and Finalizing, Chat view is inspect-only.
  Task actions remain the only way to submit planning turns.
- During Implementing, Paused, Blocked, and Complete, Chat view exposes normal
  Goal controls, steering, queueing, approvals, and console switching.

Restricting the early Chat composer prevents an unrelated prompt from bypassing
the structured planning state machine.

## State machine

Durable Task states:

| State        | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| draft        | User is writing the initial brief and adding attachments.            |
| planning     | Initial or continued planning turn is active.                        |
| review       | A valid Markdown plan is available for editing/questions.            |
| finalizing   | Agent is incorporating final answers and producing the Goal prompt.  |
| implementing | Goal mode is active.                                                 |
| paused       | Goal/Chat automation is cooperatively paused.                        |
| blocked      | Goal reported a genuine blocker or requires user action.             |
| complete     | Goal completed.                                                      |
| failed       | The current planning/finalization operation failed and is retryable. |

The Task stores the last stable state and failed operation kind so Retry can
return to Planning or Finalizing correctly.

Main transitions:

    draft --Plan Task--> planning
    planning --valid result--> review
    review --Continue Planning--> planning
    review --Begin Implementation--> finalizing
    finalizing --valid result and Goal accepted--> implementing
    implementing <--> paused
    implementing --> blocked
    blocked --Resume--> implementing
    implementing --> complete
    planning/finalizing --> failed
    failed --Retry--> planning/finalizing

No transition from Finalizing to Implementing is committed until both the final
Task result and Goal creation are durably accepted. Retrying must never create a
duplicate Goal.

## Draft experience

### Creation

Add **Task** to desktop and mobile new-tab menus with a task/checklist icon.
Creating it:

1. resolves ordinary Chat placement;
2. creates a Chat titled New task with experience task;
3. creates its one-to-one Task record in draft state;
4. attaches the Chat to the requested tab group;
5. opens Task view.

Task creation is atomic. A Chat must not exist without its required Task row, and
a Task row must not point at a non-Task Chat.

### Editor

Draft view is a full-content Markdown document editor:

- large distraction-free editing area;
- Markdown syntax support;
- drag/drop and paste attachments;
- attachment chips/previews/removal;
- title rename;
- autosave status;
- primary **Plan Task** action.

The brief autosaves to Cantrip Server using a positive row version. Conflicting
saves return a conflict that lets the user reload or copy their unsaved text;
Cantrip never silently applies last-writer-wins.

### Controls

Compact controls appear in the Task header/footer:

- model;
- reasoning effort;
- **Implementation access** permission profile;
- worktree/worker placement where applicable.

Model and reasoning apply immediately to planning. Implementation access is
stored on the backing Chat but is not granted to planning turns.

### Attachments

Reuse normal Chat attachments:

- maximum counts/sizes and preview behavior remain unchanged;
- bytes stay in the worker's private Cantrip data directory;
- metadata remains server-owned;
- relocation uses existing attachment replicas/transfer;
- Task deletion uses Chat attachment cleanup.

The Task record stores the ordered attachment IDs selected for its draft. Plan
Task uses exactly that saved set. An uploaded but removed attachment is deleted
through the existing attachment lifecycle.

The brief and plan do not live in temporary repository files. Cantrip Server is
the source of truth.

## Planning execution

### Why native Plan mode is not used

Codex Plan mode is designed as a collaboration mode inside an ordinary coding
conversation. Task planning needs a stricter product contract:

- planning must be read-only;
- output must replace one durable Markdown artifact;
- questions must be structured for a dedicated review UI;
- the same loop may run repeatedly;
- implementation starts only through Begin Implementation.

Task planning therefore uses an ordinary Codex Chat turn with a Task-specific
worker prompt and structured response schema. It still runs on the backing Chat
thread and emits normal activity.

### Read-only guarantee

Every Task planning/finalization turn is hard read-only, regardless of the
selected Implementation access:

- filesystem writes are unavailable;
- Git mutations are unavailable;
- GitHub/external mutations are unavailable;
- side-effecting MCP or dynamic tools are unavailable;
- preauthorization is unavailable;
- shell network is unavailable unless exposed through a dedicated read-only
  capability;
- repository reads, Git inspection, policy reads, attachment reads, and
  read-only research tools remain available.

Planning may inspect Primary without acquiring a worktree because it cannot
write. The implementation permission profile is activated only when Goal mode
begins.

### Policy awareness

Because Policies already exist:

- every planning/finalization turn receives current effective summaries;
- the planner can run cantrip policy list/read;
- a policy summary decides whether its full body must be read;
- no policy bodies or revision numbers are copied into Task persistence;
- policy edits become visible the next time the Agent receives summaries or
  reads the policy;
- Task does not notify, snapshot, or reconcile policy changes.

The planning prompt says that policies may constrain the implementation plan
even though planning itself remains read-only.

### Planner contract

Initial planning prompt includes:

- user brief;
- selected attachments;
- current effective policy summaries;
- project/worktree context;
- instructions to investigate before proposing architecture;
- instructions not to implement;
- structured output schema.

The planner must:

- produce one complete replacement Markdown plan;
- distinguish product behavior, architecture, persistence, APIs, UI, safety,
  tests, rollout, and independently mergeable milestones where relevant;
- ask only questions whose answers materially change the plan;
- include a recommended answer when it has a defensible recommendation;
- return an empty question list when no clarification remains;
- avoid claiming files/tests it did not inspect.

### Structured planning result

Conceptual schema:

    {
      "planMarkdown": "# Plan\n...",
      "questions": [
        {
          "id": "stable-question-id",
          "header": "Short topic",
          "question": "Decision to make?",
          "options": [
            {
              "id": "option-id",
              "label": "Short answer",
              "description": "Impact or tradeoff"
            }
          ],
          "recommendedOptionId": "option-id",
          "allowFreeform": true
        }
      ]
    }

Bounds:

- plan Markdown: 1–100,000 characters;
- 0–12 questions per round;
- question ID unique within the round;
- header: 1–80 characters;
- question: 1–2,000 characters;
- 0–6 options;
- option label: 1–120 characters;
- option description: at most 1,000 characters;
- recommended option must exist when supplied;
- freeform answer: at most 10,000 characters.

Questions without useful predefined choices set options empty and allow
freeform. Questions with options should still permit freeform when the planner
allows it.

### Runtime integration

Extend Chat turn execution with an internal structured-result mode:

- server supplies a bounded JSON schema;
- worker passes it to Codex turn/start;
- live commentary, reasoning summaries, commands, and file-read activity flow
  normally;
- raw structured final-answer text is not appended to the visible transcript;
- server validates the terminal result;
- server writes Task plan/questions transactionally;
- server appends a normalized assistant message containing the Markdown plan and
  a short question summary to the underlying Chat.

An invalid result places the Task in failed state and retains the previous
stable draft/plan. Raw invalid output may be retained only in bounded diagnostic
state that is owner-visible and excluded from logs.

## Live planning view

While Planning or Finalizing, Task view becomes a full-width activity display
reusing the Agent Inspector model:

- latest surfaced commentary/reasoning summary;
- files inspected/changed events (writes should never occur);
- running commands after the normal anti-flicker threshold;
- rolling bounded output;
- elapsed time;
- recent completed commands;
- stop/pause status where supported.

This uses events Codex/worker already emits. It does not expose hidden
chain-of-thought or introduce filesystem interception.

If a planning turn attempts a write despite the prompt, sandbox denial is shown
as activity and the planner must recover without mutation.

## Review and questions

### Plan surface

Review state shows:

- rendered Markdown plan filling the available Task surface;
- compact plan actions;
- structured questions below the document;
- Additional direction;
- Continue Planning;
- Begin Implementation.

The plan, not the underlying agent response text, is the authoritative review
artifact.

### Edit Plan

**Edit Plan** switches the rendered document into a full editor:

- Save uses rowVersion optimistic concurrency;
- Cancel discards local edits;
- Preview returns to rendered Markdown;
- unsaved edits block Continue Planning and Begin Implementation;
- the saved user-edited plan becomes the current authoritative plan;
- the planning round records agent output separately from the final user-edited
  document.

The UI clearly identifies that the user edited the plan; it does not imply the
Agent authored the final text.

### Answer controls

For each question:

- show header and question;
- show options with descriptions;
- mark the recommendation;
- allow selecting one option;
- show freeform input when allowed;
- preserve draft answers across tab switches;
- require an answer before either bottom action when the question is required.

Additional direction is always optional and applies to the whole next action.

### Continue Planning

Continue Planning submits:

- current saved plan, including user edits;
- answers;
- Additional direction;
- prior question context;
- Task planner contract.

The Agent returns a complete replacement plan and a new question set. Old
questions/answers remain in round history but no longer render as current.

Continue Planning is allowed with no questions when the user supplied Additional
direction or directly edited the plan. If neither changed, the UI may still allow
it after confirming the user wants another independent refinement pass.

## Finalization

### Begin Implementation

Begin Implementation is the user's explicit authorization. It does not show a
second confirmation after the finalization turn.

It requires:

- saved plan with no dirty editor;
- all current questions answered;
- no active Task/Chat turn;
- an available selected model/runtime;
- selected Implementation access;
- a backing Chat that can start Goal mode.

The finalization turn receives the same inputs as Continue Planning but uses a
different structured contract:

    {
      "finalPlanMarkdown": "# Final implementation plan\n...",
      "goalPrompt": "Implement the complete attached plan..."
    }

The Agent must incorporate the answers and Additional direction, remove open
questions, make acceptance criteria explicit, and create a prompt intended to
finish the whole plan rather than only the first milestone.

### Durable final artifacts

On valid finalization, store:

- immutable final plan Markdown;
- generated Goal prompt;
- final planning round;
- associated Chat message/turn IDs;
- implementation start timestamp.

The editable current plan may continue to mirror the final plan, but the final
artifact is not modified after Goal startup. Policy contents are not embedded or
snapshotted.

### Goal objective builder

Cantrip builds the actual Goal input from:

1. a small system-owned Task execution wrapper;
2. current effective policy summaries already provided through Agent context;
3. instruction to run cantrip policy list and read every policy whose summary
   requires a full read before acting;
4. final plan Markdown;
5. Agent-generated Goal prompt.

The wrapper must not hardcode the Manual Change Protocol. That protocol is
enabled by default through Policies and may be edited, unmarked, disabled, or
deleted by the user.

Representative wrapper intent:

    Implement the complete Task plan below. Before making changes, inspect the
    effective Cantrip policies and read any full policy required by its summary.
    Continue until every acceptance criterion is satisfied or the Goal is
    genuinely blocked. Keep progress recoverable and report the result.

### Automatic Goal start

Refactor current Goal route logic into a reusable server service, then:

1. create/set the Goal on the backing Codex thread;
2. append the Goal user message to the same Chat;
3. submit it automatically in Goal mode;
4. commit Task state to implementing;
5. open the implementation dashboard.

Use one finalization idempotency key and one Goal-start key. Recovery after
server/worker restart must observe an already-created Goal rather than creating
another.

## Implementation dashboard

Task view remains the default after Goal startup. It shows:

- immutable final plan;
- Goal status;
- elapsed time and token usage;
- pause/resume/stop;
- current worker/worktree/branch;
- latest surfaced thought/activity;
- detected implementation PRs;
- advisory protocol warnings;
- generated Goal prompt in a collapsible/copyable section;
- link/toggle to full Chat.

Goal states map to Task:

- active → implementing;
- paused/automation paused → paused;
- blocked/budget/usage limited → blocked with exact reason;
- complete → complete;
- runtime failure → failed without discarding final artifacts.

Normal Chat controls remain available in Chat view during implementation.

## PR detection and advisory warnings

Task does not hard-enforce a one-worktree/one-PR cycle. Effective policies and
the generated Goal prompt direct the Agent. Cantrip only reports observable
state and warnings.

### Association sources

Associate a PR with a Task when supported by one or more:

- PR head branch equals a branch used by one of the Task Chat's execution lanes;
- PR worktree is explicitly checked out by the Task Chat;
- exact GitHub PR URL appears in a Task message/activity result;
- server-observed GitHub PR creation is attributed to the Task Chat;
- repository and branch match after implementation began.

Store explicit associations when available. Inferred associations include a
confidence/source label and can be dismissed.

### Display

For each associated PR show:

- number/title/link;
- head/base;
- open/draft/merged/closed;
- associated worktree/branch;
- checks/merge readiness when available;
- explicit or inferred source.

### Nonblocking warnings

Examples:

- more than one Task-associated PR is open;
- Agent acquired a new worktree while a prior associated PR remains open;
- a PR closed without merging while the Goal continued;
- an implementation worktree is dirty after its PR merged;
- Task completed while an associated PR remains open.

Warnings never stop Goal continuation and never administratively merge, close,
or alter a PR.

## Persistence model

### chats extension

Add:

| Field      | Notes                                   |
| ---------- | --------------------------------------- |
| experience | agent or task; migration default agent. |

Chat summary protocol exposes the experience so all clients choose the correct
icon/surface.

### tasks

One row per Task-backed Chat:

| Field                    | Notes                                                |
| ------------------------ | ---------------------------------------------------- |
| chatId                   | Primary key and Chat foreign key.                    |
| state                    | Durable Task state.                                  |
| stableStateBeforeFailure | Nullable retry target.                               |
| activeOperationId        | Nullable idempotent planning/finalization operation. |
| activeOperationKind      | initial-plan, continue-plan, or finalize.            |
| briefMarkdown            | Autosaved user brief.                                |
| draftAttachmentIds       | Ordered existing Chat attachment IDs.                |
| planMarkdown             | Current saved plan, including user edits.            |
| planAuthorship           | agent, user-edited, or mixed.                        |
| currentQuestions         | Current bounded structured questions.                |
| currentAnswers           | Current answer drafts/saved answers.                 |
| additionalDirection      | Current optional direction.                          |
| finalPlanMarkdown        | Nullable immutable final plan.                       |
| goalPrompt               | Nullable generated Goal prompt.                      |
| planningRound            | Nonnegative ordinal.                                 |
| implementationStartedAt  | Nullable timestamp.                                  |
| lastError                | Bounded owner-visible error metadata.                |
| rowVersion               | Positive optimistic-concurrency counter.             |
| createdAt / updatedAt    | Server timestamps.                                   |

Large immutable round inputs/outputs should not be duplicated unboundedly in the
tasks row.

### task_planning_rounds

| Field                              | Notes                                            |
| ---------------------------------- | ------------------------------------------------ |
| id                                 | UUID.                                            |
| chatId                             | Task-backed Chat.                                |
| ordinal                            | Unique increasing round number per Task.         |
| kind                               | initial-plan, continue-plan, or finalize.        |
| status                             | running, completed, failed, interrupted.         |
| inputBriefMarkdown                 | Snapshot used for this round.                    |
| inputPlanMarkdown                  | Nullable plan supplied to revision/finalization. |
| inputQuestions                     | Questions being answered.                        |
| inputAnswers                       | User answers.                                    |
| additionalDirection                | User direction.                                  |
| outputPlanMarkdown                 | Validated result when available.                 |
| outputQuestions                    | Validated result when available.                 |
| outputGoalPrompt                   | Finalization result when available.              |
| userMessageId / assistantMessageId | Transcript correlation.                          |
| executionLaneId / turnId           | Runtime correlation.                             |
| error                              | Bounded failure.                                 |
| startedAt / completedAt            | Timestamps.                                      |

Round history is owner-visible for recovery/debugging but the initial product
does not need a complex diff/history editor.

### task_pull_requests

Optional durable associations:

| Field                   | Notes                                               |
| ----------------------- | --------------------------------------------------- |
| chatId                  | Task Chat.                                          |
| repository identity     | GitHub repository.                                  |
| pullRequestNumber       | Stable number.                                      |
| associationKind         | explicit or inferred.                               |
| source                  | lane-branch, worktree, message-url, server-created. |
| dismissedAt             | Nullable user dismissal.                            |
| firstSeenAt / updatedAt | Timestamps.                                         |

Current PR state may be refreshed from GitHub rather than duplicated as
authoritative state.

## API surface

Suggested routes:

### Creation and state

    POST  /api/projects/:projectId/tasks
    GET   /api/tasks/:chatId
    PATCH /api/tasks/:chatId/draft
    PATCH /api/tasks/:chatId/plan

### Operations

    POST /api/tasks/:chatId/plan
    POST /api/tasks/:chatId/continue
    POST /api/tasks/:chatId/begin-implementation
    POST /api/tasks/:chatId/retry

### Advisory state

    GET  /api/tasks/:chatId/pull-requests
    POST /api/tasks/:chatId/pull-requests/:number/dismiss

Mutations carry rowVersion and idempotency keys. Operation endpoints return
accepted/current state rather than holding the HTTP request open for the whole
Agent turn. Existing live-query/chat events invalidate Task state as activity
arrives.

Task services live outside route handlers so recovery, Goal startup, and tests
can invoke them without internal HTTP calls.

## Recovery and concurrency

- only one planning/finalization operation may run per Task;
- the ordinary Chat execution lane provides the underlying exclusive turn;
- operation IDs make duplicate button submissions idempotent;
- stale draft/plan edits return conflict;
- valid previous plan remains visible if a continuation fails;
- failure records which operation can be retried;
- restart reconciliation correlates worker turn outcomes to planning rounds;
- a recovered successful finalization cannot create a second Goal;
- worker offline preserves every server-owned artifact and shows Retry when
  placement returns;
- attachment transfer follows existing Chat relocation;
- Task relocation is disallowed during an active turn, like ordinary Chat;
- pause prevents automatic Goal continuation but does not erase planning state;
- deleting/archiving the backing Chat applies existing cleanup/retention and
  cascades Task-only rows.

## Fork, duplicate, and console behavior

- Renaming the Task renames the backing Chat/tab.
- The linked Codex console remains available from Chat view.
- Forking a message from the hidden Chat creates a normal Agent Chat by default,
  not a second half-initialized Task.
- A future explicit Duplicate Task action may copy the brief/current plan into a
  new draft Task; it is not required initially.
- Archiving a Task follows Chat archive retention.
- Restoring it restores Task view/state.

## App structure

Refactor rather than placing the whole experience in App.tsx:

- TaskSurface
- TaskHeader
- TaskDraftEditor
- TaskPlanningActivity
- TaskPlanReview
- TaskQuestionList
- TaskPlanEditor
- TaskImplementationDashboard
- TaskPullRequestList
- pure Task state/transition helpers
- Task-specific query/mutation hooks

Reuse:

- Chat attachment controls;
- model/reasoning pickers;
- permission profile picker relabeled Implementation access;
- worktree/placement control;
- Markdown renderer/editor primitives;
- Agent Inspector content;
- Goal panel/status logic;
- Task/Chat header switching;
- existing responsive/tab/popup shell.

Task surface remains mounted according to normal persistent tab behavior so
draft answers and local editor state do not disappear during ordinary tab
switching.

## Logging and telemetry

Operational logs may record:

- Task/chat/project/worker IDs;
- operation kind and state;
- duration;
- round count;
- question count;
- plan character count;
- error class/reason code;
- Goal/PR association identifiers.

They must not record:

- brief text;
- plan text;
- questions/answers;
- Goal prompt;
- attachment contents;
- policy summaries/bodies;
- command output/source contents.

Model usage continues through existing execution-attempt telemetry with a Task
operation-kind dimension. Task plan contents are not analytics.

## Implementation sequence

Start only after Policies is merged and the Task plan has been reconciled with
the implemented Policy contracts. Every milestone uses its own worktree,
branch, ready PR, squash auto-merge, merge observation, and cleanup.

### Milestone 1: Task domain foundation

- Chat experience protocol/database migration;
- Task and planning-round tables;
- state transition helpers;
- optimistic revisions/idempotency;
- atomic Task-backed Chat creation;
- repository/protocol/server tests;
- no visible Task menu yet.

### Milestone 2: Structured read-only planner

- internal structured Chat-turn mode;
- Task planner/finalizer schemas;
- enforced read-only runtime profile;
- policy-aware planning context;
- final-answer suppression/normalization;
- round persistence and restart recovery;
- worker/server integration tests.

### Milestone 3: Task creation and draft UI

- new-tab Task entries;
- Task surface/router selection;
- Markdown brief editor/autosave;
- attachment integration;
- model/reasoning/Implementation access/placement controls;
- Plan Task and live activity;
- Task/Chat inspect toggle;
- focused app tests.

### Milestone 4: Review and iterative planning

- Markdown plan renderer;
- question/recommendation/freeform UI;
- Additional direction;
- revision-safe Edit Plan;
- Continue Planning;
- failed/retry/offline states;
- multi-window and accessibility tests.

### Milestone 5: Finalization and Goal handoff

- Begin Implementation validation;
- final structured turn;
- immutable final artifacts;
- policy-aware Goal objective builder;
- reusable Goal startup service;
- automatic same-Chat Goal turn;
- recovery/duplicate-prevention tests.

### Milestone 6: Dashboard and PR advisories

- implementing/paused/blocked/complete dashboard;
- Goal controls and Chat integration;
- PR association/refetch;
- nonblocking warnings;
- worktree/branch display;
- server/app/GitHub tests.

### Milestone 7: Full-system hardening

- relocation and attachment-transfer tests;
- hosted tenant isolation;
- popout/mobile behavior;
- archive/restore/delete lifecycle;
- logging/redaction review;
- README/FULL_DESCRIPTION updates;
- end-to-end and repository-wide validation.

## Acceptance criteria

- Users can create a Task from the normal project new-tab menu.
- A Task is one durable Chat with a Task experience, not a parallel runtime.
- Draft Markdown and attachments survive tab/window/client changes.
- Model/reasoning affect planning; Implementation access never grants planning
  mutation authority.
- Plan Task produces validated Markdown plus structured questions.
- Live planning uses existing normalized Agent activity.
- Users can answer questions, add direction, directly edit/save the plan, and
  repeat planning indefinitely.
- Planning/finalization cannot mutate repository, Git, GitHub, or external state.
- Begin Implementation finalizes once and automatically starts one Goal on the
  same Chat.
- Goal instructions rely on current effective Policies rather than hardcoding
  Manual Change Protocol.
- Policy changes are naturally observed on later summaries/reads without Task
  revision messaging.
- Task view remains useful throughout Goal execution and Chat view remains
  available.
- PR associations and protocol warnings are advisory only.
- retries/restarts cannot duplicate planning rounds or Goals.
- ordinary Chats never show Task-only controls.
- server/worker/app boundaries and tenant ownership remain intact.

## Explicit non-goals

- implementing Policies in the Task milestone series;
- native Codex Plan mode as the Task planner;
- temporary plan/question files as authoritative state;
- hard enforcement of PR sequencing;
- machine interpretation of arbitrary policy prose;
- automatic PR merge/close/admin bypass;
- exposing hidden chain-of-thought;
- Agent mutation of Policies;
- organization/server-admin policy hierarchy;
- Task templates, dependencies, nesting, assignees, due dates, kanban, or a
  general issue tracker;
- duplicating/forking a Task orchestration state in the first release.
