# Retired durable workflow subsystem

Status: removed from the executable product.

Cantrip no longer exposes or runs its former durable DAG workflow subsystem.
The app workflow center and client APIs were removed first; the server
scheduler, executor, workflow repositories, and worker execution, trigger,
gate, generation, and repository handlers were then removed. Former public
durable-workflow paths are simply unregistered and receive the normal
not-found response.

This retirement does not affect either of the current automation surfaces:

- **Project automations** schedule one protected prompt, optionally after one
  worker-evaluated condition.
- **GitHub Actions workflows** are repository files inspected and dispatched
  through the Git/GitHub surface.

Neither surface uses the retired durable workflow runtime.

## What remains in source

The following are compatibility artifacts, not an executable subsystem:

- database tables and historical migrations for definitions, revisions, runs,
  nodes, attempts, gates, triggers, deliveries, events, and workflow worktree
  leases;
- shared protocol and `workflow-content` encryption schemas;
- protocol `workflow-run` live-scope/resource names, although `/api/live` does
  not authorize that scope and no durable-workflow publisher remains;
- account-storage classification for legacy rows; and
- conservative lifecycle checks that still notice legacy active run or
  worktree-lease markers before an update, conversion, replica removal, or
  worktree removal.

There is no supported API for creating, listing, starting, resuming,
controlling, or deleting these legacy records. Existing rows are not recovered,
scheduled, dispatched, or drained. The generic interaction route now rejects a
request that is not associated with an active chat.

## Compatibility boundary

The residual schema is intentionally inert. It prevents an older database from
failing immediately on columns and relationships still referenced by storage
accounting and conservative deletion checks, but it does not promise backward
execution compatibility. Operators should not mark old runs or leases active:
because there is no workflow runtime to advance them, active legacy markers can
continue to block the guarded operation that detects them.

Cantrip does not currently ship a workflow-data cleanup command. Back up the
database before any manual intervention and treat direct edits as unsupported.
A future schema migration, rather than an application route, is the appropriate
place to remove or transform these tables.

## Source anchors

- [`build-app.ts`](../cantrip_server/src/app/build-app.ts) installs no
  durable-workflow API or scheduling runtime.
- [`background-job-runtime.ts`](../cantrip_server/src/app/runtime/background-job-runtime.ts)
  owns current project and chat background jobs only.
- [`agent-interactions.ts`](../cantrip_server/src/app/routes/agent-interactions.ts)
  accepts responses only for active chat-backed interactions.
- [`schema.ts`](../cantrip_server/src/db/schema.ts) retains the legacy workflow
  tables.
- [`worktree-lifecycle.ts`](../cantrip_server/src/db/repository/worktree-lifecycle.ts),
  [`project-replica-jobs.ts`](../cantrip_server/src/db/project-replica-jobs.ts),
  and
  [`project-github-conversion-jobs.ts`](../cantrip_server/src/db/project-github-conversion-jobs.ts)
  contain conservative legacy-row blockers.
- [`workflows.ts`](../packages/protocol/src/workflows.ts) and
  [`workflow-content.ts`](../packages/crypto/src/workflow-content.ts) retain
  historical wire and ciphertext contracts without making them public routes.

For historical implementation evidence, see
[WORKFLOW_IMPLEMENTATION_AUDIT.md](WORKFLOW_IMPLEMENTATION_AUDIT.md) and
[ADR 0004](adr/0004-codex-native-workflow-control-plane.md).
