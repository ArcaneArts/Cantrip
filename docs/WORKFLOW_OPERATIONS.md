# Retired workflow data operations

Cantrip has no durable workflow service to operate. The public UI and APIs,
server scheduler/executor/repositories, and worker workflow handlers have all
been removed. Migration `0191_wakeful_vector.sql` also deletes workflow-linked
shared rows and drops the definition, run, trigger, gate, event, and lease
tables.

## Operator checklist

1. Continue normal PostgreSQL backups. Backups from before migration `0191`
   contain workflow state that current code does not restore or interpret.
2. Do not use former `/api/workflows`, `/api/workflow-runs`, trigger, gate,
   generation, or repository paths as a health check. They are unregistered and
   return the ordinary not-found response.
3. Do not expect worker reconnects or server restarts to advance a legacy run.
   No workflow command handlers or scheduler are registered.
4. Do not attempt to copy durable-workflow tables from a pre-removal backup into
   a current database. Use matching historical application code if that data
   must be inspected.
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
- [`0191_wakeful_vector.sql`](../cantrip_server/drizzle/0191_wakeful_vector.sql)
  removes workflow tables, shared-table columns, and workflow-linked rows.
- [`workflow-removal-migration.test.ts`](../cantrip_server/test/workflow-removal-migration.test.ts)
  verifies upgrade cleanup and fresh-schema behavior.

See [WORKFLOW_ORCHESTRATION.md](WORKFLOW_ORCHESTRATION.md) for the complete
current boundary. The [implementation audit](WORKFLOW_IMPLEMENTATION_AUDIT.md)
and [ADR 0004](adr/0004-codex-native-workflow-control-plane.md) are historical
records of the removed feature.
