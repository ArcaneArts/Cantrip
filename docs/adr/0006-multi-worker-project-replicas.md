# ADR 0006: Multi-worker project replicas and execution placement

- Status: Accepted
- Date: 2026-08-11

## Context

Cantrip accounts can enroll and manage several workers, but a project still has
one `project_sources` row and most project-level creation paths infer that
source's worker. Chats and several filesystem-backed surfaces already persist
worker and worktree identity, while Remote Surfaces persist a worker. These
pieces cannot safely become multi-worker through ad hoc worker selectors:
replica identity, target authorization, synchronization, and relocation need a
shared contract.

## Decision

A logical project may have one worker-local **project replica** per worker.
Existing project-source rows retain their IDs and become the initial replicas;
the table and internal `projectSourceId` name remain compatibility details
during the migration. Every replica has its own Primary worktree.

Every executing surface has a server-resolved `ExecutionPlacement`. Requests
use a strict `ExecutionTarget` selector; even an explicit worker selector never
establishes placement or authorization by itself. The server loads the
referenced resource under the authenticated owner and project, resolves its
relationships, checks lifecycle and capabilities, authorizes the operation,
and routes it to the selected worker. Workers never connect to one another.

The app talks only to the server. The server remains authoritative for durable
state, jobs, placement transitions, leases, and conversation history. Workers
remain authoritative for paths, Git state, files, processes, provider secrets,
and local capabilities.

Replica synchronization materializes an expected immutable revision. It does
not mean unconditional pull and never silently changes a dirty worktree. Chat
relocation occurs only at an idle boundary, prepares a worker-specific runtime
from a durable context handoff, and atomically changes future execution after
preparation succeeds. Live PTYs, Codex processes, Code processes, browser
sessions, and desktop streams are not migrated.

The complete terminology, wire shapes, authority matrix, state machines,
compatibility rules, and staged rollout are canonical in
[the multi-worker architecture contract](../MULTI_WORKER_ARCHITECTURE.md).
`@cantrip/protocol` owns the corresponding additive placement and target
schemas.

## Consequences

- The singular project-source constraint must migrate to uniqueness per
  project and worker without changing existing identities.
- Project responses need an additive replica list and a temporary singular
  source projection for rolling clients.
- Surface creation and agent tools converge on one target-resolution path.
- Provisioning, synchronization, relocation, and removal become durable,
  idempotent jobs rather than request-scoped worker calls.
- Cross-replica branch mutation requires a logical-branch lease beyond current
  worker-local worktree IDs.
- Worker enrollment can remain enabled while worker switching and Git sync
  capability flags remain disabled until their complete lifecycles ship.
- Single-worker Cantrip keeps deterministic implicit placement and does not
  need fleet controls in its common path.
