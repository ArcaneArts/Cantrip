# Retired workflow data operations

Cantrip has no durable workflow service to operate. The public UI and APIs,
server scheduler/executor/repositories, and worker workflow handlers have all
been removed. Existing definition, run, trigger, gate, event, and lease rows are
legacy database state only: they are not recovered, scheduled, dispatched, or
drained.

## Operator checklist

1. Continue normal PostgreSQL backups. The legacy tables remain part of the
   current schema and therefore remain part of database backup/restore.
2. Do not use former `/api/workflows`, `/api/workflow-runs`, trigger, gate,
   generation, or repository paths as a health check. They are unregistered and
   return the ordinary not-found response.
3. Do not expect worker reconnects or server restarts to advance a legacy run.
   No workflow command handlers or scheduler are registered.
4. If an update, project conversion, replica removal, or worktree removal is
   blocked by an old active workflow marker, preserve a backup and investigate
   the affected rows. Cantrip does not ship a supported workflow cleanup API or
   command.
5. Monitor project automations independently. They remain supported and use
   their own routes, repository, scheduler, and worker condition evaluator.

## Current evidence

- [`build-app.ts`](../cantrip_server/src/app/build-app.ts) contains no
  durable-workflow runtime construction or route registration.
- [`background-job-runtime.ts`](../cantrip_server/src/app/runtime/background-job-runtime.ts)
  constructs project/chat jobs and the worktree coordinator, not a workflow
  executor.
- [`index.ts`](../cantrip_worker/src/index.ts) registers project-automation
  handling but no durable-workflow commands.
- [`schema.ts`](../cantrip_server/src/db/schema.ts) retains legacy workflow
  tables and relationships.
- [`desktop-update-state.ts`](../cantrip_server/src/db/repository/desktop-update-state.ts)
  and the lifecycle repositories conservatively count or block on old active
  rows.

See [WORKFLOW_ORCHESTRATION.md](WORKFLOW_ORCHESTRATION.md) for the complete
current boundary. The [implementation audit](WORKFLOW_IMPLEMENTATION_AUDIT.md)
and [ADR 0004](adr/0004-codex-native-workflow-control-plane.md) are historical
records of the removed feature.
