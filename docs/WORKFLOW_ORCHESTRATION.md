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

## What remains

Only historical records remain:

- pre-removal database migrations followed by the removal migration;
- historical documentation, ADRs, and implementation records; and
- Git history.

There is no supported API for creating, listing, starting, resuming, or
controlling durable workflows. Current source has no dedicated workflow
protocol module, crypto helper, live scope, persistence, or account-usage
category. The `workflow-content` component name still protects the independent
project-automation feature; that name does not restore the retired graph
workflow domain.

## Persistence removal

Migration `0191_wakeful_vector.sql` deletes workflow-linked interaction,
tunnel, branch-lease, and storage-accounting rows, removes workflow-only
columns and constraints from shared tables, and drops every durable-workflow
table. A fresh schema is workflow-free, and an upgraded database does not
retain dormant definitions, runs, gates, events, triggers, or leases. Restore a
pre-removal backup only with application code from the same historical schema;
current code neither preserves nor interprets that data.

## Source anchors

- [`build-app.ts`](../cantrip_server/src/app/build-app.ts) installs no
  durable-workflow API or scheduling runtime.
- [`background-job-runtime.ts`](../cantrip_server/src/app/runtime/background-job-runtime.ts)
  owns current project and chat background jobs only.
- [`agent-interactions.ts`](../cantrip_server/src/app/routes/agent-interactions.ts)
  accepts responses only for active chat-backed interactions.
- [`0191_wakeful_vector.sql`](../cantrip_server/drizzle/0191_wakeful_vector.sql)
  removes persisted workflow data and shared-table residue during upgrade.
- [`workflow-removal-migration.test.ts`](../cantrip_server/test/workflow-removal-migration.test.ts)
  verifies both upgrade cleanup and a workflow-free fresh schema.
- [`project-automation-content.ts`](../packages/crypto/src/project-automation-content.ts)
  owns the current project-automation encryption helper.
- [`live.ts`](../packages/protocol/src/live.ts) defines only current-user,
  project, and chat subscription scopes.

For historical implementation evidence, see
[WORKFLOW_IMPLEMENTATION_AUDIT.md](WORKFLOW_IMPLEMENTATION_AUDIT.md) and
[ADR 0004](adr/0004-codex-native-workflow-control-plane.md).
