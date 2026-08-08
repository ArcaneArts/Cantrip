# ADR 0001: Agent-managed worktree execution lanes

- Status: Accepted
- Date: 2026-08-08

## Context

Cantrip currently resolves chats, linked Codex consoles, terminals, Explorer,
skills, and Git operations through a project's single `project_sources` path.
That prevents isolated concurrent changes and makes it unsafe for an agent to
follow repository policies that require every writable task to use its own Git
worktree.

The product must keep a compact, flat project sidebar. A chat is a durable
server-owned conversation, not a permanent alias for one directory. It may
inspect Primary, acquire an isolated checkout, deliver work, release that
checkout, and later use a different checkout while retaining one transcript.

## Codex app-server spike

The installed `codex-cli 0.146.1` app-server bindings were generated locally
with:

```bash
codex app-server generate-ts --experimental --out <temporary-directory>
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

The generated protocol establishes:

- `thread/start` accepts `cwd` and `runtimeWorkspaceRoots`.
- `thread/resume` accepts `cwd` and `runtimeWorkspaceRoots`.
- `turn/start` accepts `cwd` and `runtimeWorkspaceRoots`; its contract says the
  CWD override applies to that turn and subsequent turns.
- A thread may therefore change CWD at a turn boundary without pretending that
  an already-running command or tool call moved directories.
- `thread/start` accepts native `dynamicTools` definitions.
- App-server invokes those client-hosted tools through the
  `item/tool/call` server request and expects a `DynamicToolCallResponse`.

A live no-model RPC probe then started an ephemeral thread in one temporary
directory, called `thread/settings/update` with a second directory, and read
the thread back. App-server reported the first directory from `thread/start`
and the second directory from `thread/read`:

```json
{
  "startedCwd": "/tmp/codex-cwd-a...",
  "updatedThreadCwd": "/tmp/codex-cwd-b..."
}
```

This verifies that the running app-server accepts a CWD transition for
subsequent turns without making a model request. It does not make an in-flight
turn movable: active command, approval, diff, and activity state remains tied
to the turn that created it. Cantrip must transition only after that turn and
all mutating dynamic-tool work have settled.

Cantrip's current app-server client supplies CWD when starting or resuming a
thread, but not on every `turn/start`. A loaded thread would therefore retain
its earlier CWD. Worktree-aware execution must pass the resolved CWD and runtime
workspace roots on each turn and must reject lane transitions while a turn or
mutating tool is active.

These findings are protocol evidence for the installed version. Automated
client tests must protect the required request fields so a future Codex upgrade
cannot silently regress worktree routing.

## Decision

### Project, source, and worktree

- A project is a server-owned logical repository.
- A project source is one worker-owned repository installation.
- A project worktree is one physical checkout owned by that source and worker.
- Every source has a non-removable Primary worktree representing its existing
  checkout.
- The worker remains authoritative for paths and Git state. The server stores
  observed metadata for routing and offline rendering.

### Chats and execution lanes

- Chats default to `agent-managed` and may change worktrees only at safe turn
  boundaries.
- A chat may instead be `pinned` to one worktree until the user unpins it.
- A durable worktree lease records each chat/worktree execution lane and its
  lifecycle, ownership, starting revision, and runtime association.
- Only one lease is active for a chat turn. Historical leases remain available
  for audit and transcript rendering.
- Messages, turns, command activity, and file changes record their originating
  lease/worktree.
- Codex runtime state is keyed by chat, worker, and worktree. Returning to a
  previous lane resumes its runtime when available; creating a new lane creates
  a new runtime and hydrates it from server-held context.
- A linked Codex console always follows the chat's active lane.

### Agent control

Cantrip will use Codex app-server dynamic tools as the primary agent control
path. This is native to the existing process protocol and avoids managing a
second MCP process solely for Cantrip-owned operations. The tool namespace will
provide list, acquire/create, switch, status, release, and remove operations.

The agent supplies intent and Git references, never an unrestricted checkout
path. The server authorizes ownership and lease transitions; the worker chooses
and validates filesystem paths and performs Git operations with argument-array
process execution.

If an agent requests a lane transition during a running turn, the tool records
the requested transition but does not mutate the active CWD. Cantrip completes
or checkpoints the current phase, applies the transition, and continues at the
next turn boundary with an explicit transcript activity.

The Codex protocol does not require a new thread merely to change CWD. Cantrip
still keeps a distinct runtime-session record per chat, worker, and worktree so
lane-specific rollout identity, recovery, and audit state are explicit. An
implementation may reuse a Codex thread across safe turn-boundary transitions
only when it records that association on both lane sessions and sends the new
CWD and workspace roots on the following turn.

### User interface

- The project tab list remains flat and freely sortable.
- Secondary-worktree state appears as a compact indicator on filesystem-backed
  tabs, with details and controls in a popover and the active tab header.
- Primary and project-level tabs do not receive a worktree indicator.
- History visualizes all worktree HEADs and per-worktree WIP state while one
  selected worktree supplies status and Git actions.

### Safety

- Primary cannot be removed independently of its project.
- Managed worktrees are exclusively leased to one chat by default.
- Dirty, active, externally owned, or another chat's worktrees cannot be
  silently released or removed.
- Worktree removal never implies branch deletion.
- All paths are checked against the repository common directory and
  worker-managed worktree root.
- Cross-worker filesystem replication is outside this decision. Offline
  metadata and server-owned transcripts remain available.

## Consequences

- Existing projects and filesystem-backed tabs require a migration to Primary.
- Git status and actions become worktree-scoped instead of project-path scoped.
- Runtime and queue dispatch must resolve the active lease at dispatch time.
- The Codex app-server client gains dynamic-tool request handling and explicit
  per-turn CWD/workspace-root overrides.
- Worktree state can be shown while a worker is offline, but the checkout cannot
  execute until that worker reconnects.
- Future cross-worker handoff must explicitly replicate committed Git state and
  cannot pretend uncommitted files moved automatically.
