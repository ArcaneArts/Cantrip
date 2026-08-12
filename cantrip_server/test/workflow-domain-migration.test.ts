import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { ServerRepository } from "../src/db/repository.js";
import { SecretVault } from "../src/security/secret-vault.js";
import * as schema from "../src/db/schema.js";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

async function applyMigrations(database: PGlite) {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();

  for (const migrationFile of migrationFiles) {
    await database.exec(
      await readFile(`${migrationsDirectory}/${migrationFile}`, "utf8"),
    );
  }
}

describe("workflow domain migration", () => {
  it("persists a revision graph and its independently attributed run graph", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-1', 'anonymous', 'Workflow Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'user-1', 'Local Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-1', 'user-1', 'Cantrip');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-1', 'project-1', 'worker-1', '/workspace/Cantrip', 'ArcaneArts/Cantrip'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state, branch, head
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Workflow lane',
          '/worktrees/workflow-1', 'worktrees/workflow-1', false, false,
          'cantrip', 'ready', 'cantrip/workflow/run-1/inspect', 'abc123'
        );

        INSERT INTO workflow_definitions (
          id, owner_id, project_id, scope, slug, name, source, trust_state
        ) VALUES (
          'workflow-1', 'user-1', 'project-1', 'project', 'audit',
          'Audit workflow', 'manual', 'trusted'
        );

        INSERT INTO workflow_revisions (
          id, workflow_id, revision, definition, source, content_hash,
          created_by_user_id, trust_state
        ) VALUES (
          'revision-1', 'workflow-1', 1,
          '{"version":1,"nodes":["inspect","verify"]}'::jsonb,
          'manual', 'sha256:revision-1', 'user-1', 'trusted'
        );

        INSERT INTO workflow_revision_nodes (
          id, revision_id, node_key, node_type, name, position, mutation_mode
        ) VALUES
          ('revision-node-1', 'revision-1', 'inspect', 'agent', 'Inspect', 0, 'write'),
          ('revision-node-2', 'revision-1', 'verify', 'verify', 'Verify', 1, 'read-only'),
          ('revision-node-3', 'revision-1', 'pipeline', 'pipeline', 'Pipeline', 2, 'read-only');

        INSERT INTO workflow_revision_edges (
          id, revision_id, from_node_id, to_node_id, position
        ) VALUES (
          'revision-edge-1', 'revision-1', 'revision-node-1', 'revision-node-2', 0
        );

        INSERT INTO workflow_runs (
          id, workflow_id, workflow_revision_id, owner_id, project_id, status,
          trigger_type, trigger_provenance, idempotency_key, structured_input, budget,
          permission_manifest, worker_id, worktree_id, recovery_state
        ) VALUES (
          'run-1', 'workflow-1', 'revision-1', 'user-1', 'project-1', 'running',
          'manual', '{"actorType":"user","actorId":"user-1","deliveredAt":"2026-08-08T17:00:00.000Z","metadata":{}}'::jsonb,
          'launch-1', '{"target":"src"}'::jsonb, '{}'::jsonb,
          '{"filesystem":"workspace-write"}'::jsonb, 'worker-1', 'worktree-1', 'stable'
        );

        INSERT INTO workflow_run_nodes (
          id, run_id, revision_node_id, node_key, node_type, status,
          structured_input, worker_id, worktree_id, codex_thread_id,
          write_capable
        ) VALUES
          (
            'run-node-1', 'run-1', 'revision-node-1', 'inspect', 'agent',
            'running', '{"target":"src"}'::jsonb, 'worker-1', 'worktree-1',
            'thread-1', true
          ),
          (
            'run-node-2', 'run-1', 'revision-node-2', 'verify', 'verify',
            'blocked', '{}'::jsonb, null, null, null, false
          ),
          (
            'run-node-3', 'run-1', 'revision-node-3', 'pipeline', 'pipeline',
            'completed', '{"items":["alpha"]}'::jsonb, null, null, null,
            false
          );

        INSERT INTO workflow_run_node_dependencies (
          id, run_id, revision_edge_id, from_node_id, to_node_id, status
        ) VALUES (
          'dependency-1', 'run-1', 'revision-edge-1', 'run-node-1',
          'run-node-2', 'blocked'
        );

        INSERT INTO workflow_node_attempts (
          id, run_node_id, attempt, status, idempotency_key, structured_input,
          worker_id, worktree_id, codex_thread_id, codex_turn_id,
          starting_revision
        ) VALUES (
          'attempt-1', 'run-node-1', 1, 'running', 'dispatch-1',
          '{"target":"src"}'::jsonb, 'worker-1', 'worktree-1', 'thread-1',
          'turn-1', 'abc123'
        );

        INSERT INTO workflow_run_node_items (
          id, run_node_id, item_key, position, structured_input, worker_id,
          worktree_id, attempt_count, execution_state
        ) VALUES (
          'run-node-item-1', 'run-node-3', 'alpha', 0,
          '{"item":"alpha"}'::jsonb, 'worker-1', 'worktree-1', 1,
          '{"kind":"pipeline","currentStepPosition":1,"currentStepAttemptCount":0,"completedSteps":[{"key":"inspect","name":"Inspect","position":0,"structuredResult":{},"measuredUsage":{},"codexThreadId":"thread-1","codexTurnId":"turn-1","completedAt":"2026-08-08T17:00:00.000Z"}]}'::jsonb
        );

        INSERT INTO workflow_node_attempts (
          id, run_node_id, run_node_item_id, attempt, status, idempotency_key,
          structured_input, worker_id, worktree_id, execution_unit_key
        ) VALUES (
          'attempt-item-1', 'run-node-3', 'run-node-item-1', 1, 'completed',
          'dispatch-item-1', '{"item":"alpha"}'::jsonb, 'worker-1',
          'worktree-1', 'inspect'
        );

        INSERT INTO workflow_run_events (
          run_id, run_node_id, attempt_id, sequence, event_key, type, payload,
          actor_type, actor_id
        ) VALUES (
          'run-1', 'run-node-1', 'attempt-1', 0, 'run-created', 'run.started',
          '{"status":"running"}'::jsonb, 'user', 'user-1'
        );

        INSERT INTO workflow_approval_gates (
          id, run_id, run_node_id, gate_key, prompt, requested_by_type,
          requested_by_id, permission_manifest
        ) VALUES (
          'gate-1', 'run-1', 'run-node-2', 'verify-release',
          'Approve the verification stage?', 'workflow-node', 'run-node-2',
          '{"filesystem":"read-only"}'::jsonb
        );
      `);

      const repository = new ServerRepository(
        drizzle(database, { schema }),
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 1) }],
        }),
      );
      await database.exec(`
        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-2', 'user-1', 'Remote Worker', 'linux', 'x64', now(), now()
        );

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-2', 'project-1', 'worker-2', '/workspace/Cantrip-remote',
          'ArcaneArts/Cantrip (remote)'
        );

        INSERT INTO workflow_runs (
          id, workflow_id, workflow_revision_id, owner_id, project_id, status,
          trigger_type, trigger_provenance, idempotency_key, structured_input,
          budget, permission_manifest, worker_id, recovery_state
        ) VALUES (
          'run-2', 'workflow-1', 'revision-1', 'user-1', 'project-1', 'running',
          'manual',
          '{"actorType":"user","actorId":"user-1","deliveredAt":"2026-08-08T17:00:00.000Z","metadata":{}}'::jsonb,
          'launch-2', '{}'::jsonb, '{}'::jsonb,
          '{"filesystem":"workspace-write"}'::jsonb, 'worker-2', 'stable'
        );

        INSERT INTO workflow_run_nodes (
          id, run_id, revision_node_id, node_key, node_type, status,
          structured_input, worker_id, write_capable
        ) VALUES (
          'run-node-remote', 'run-2', 'revision-node-1', 'inspect', 'agent',
          'running', '{}'::jsonb, 'worker-2', true
        );
      `);
      const reservation = await repository.workflowRuns.reserveWorktreeLease(
        "user-1",
        {
          runId: "run-1",
          runNodeId: "run-node-1",
          runNodeItemId: null,
          projectSourceId: "source-1",
          workerId: "worker-1",
          requestedWorktreeId: "worktree-1",
          branchName: "cantrip/workflow/run-1/inspect",
          baseRevision: "abc123",
        },
      );
      expect(reservation).toMatchObject({
        created: true,
        lease: {
          requestedWorktreeId: "worktree-1",
          state: "allocating",
        },
      });
      await expect(
        repository.workflowRuns.reserveWorktreeLease("user-1", {
          runId: "run-2",
          runNodeId: "run-node-remote",
          runNodeItemId: null,
          projectSourceId: "source-2",
          workerId: "worker-2",
          requestedWorktreeId: "worktree-remote",
          branchName: "cantrip/workflow/run-1/inspect",
          baseRevision: "abc123",
        }),
      ).rejects.toThrow(/Logical branch .* is already leased/u);
      await database.exec(`
        INSERT INTO chats (
          id, project_id, title, active_worker_id, active_worktree_id
        ) VALUES (
          'chat-branch-contender', 'project-1', 'Branch contender',
          'worker-1', 'worktree-1'
        );
      `);
      await expect(
        repository.startChatExecutionLane(
          "user-1",
          "chat-branch-contender",
          "agent",
          "Attempt workflow-owned branch",
        ),
      ).rejects.toThrow(/Logical branch .* is already leased/u);
      expect(
        await repository.getWorktreeRemovalBlockers(
          "user-1",
          "project-1",
          "worktree-1",
        ),
      ).toMatchObject({ workflowLeaseIds: [reservation!.lease.id] });
      await expect(
        repository.workflowRuns.reserveWorktreeLease("user-1", {
          runId: "run-1",
          runNodeId: "run-node-1",
          runNodeItemId: null,
          projectSourceId: "source-1",
          workerId: "worker-1",
          requestedWorktreeId: "ignored-on-replay",
          branchName: "cantrip/workflow/run-1/inspect",
          baseRevision: "abc123",
        }),
      ).resolves.toMatchObject({
        created: false,
        lease: { id: reservation!.lease.id, state: "allocating" },
      });
      await expect(
        repository.workflowRuns.reserveWorktreeLease("user-1", {
          runId: "run-1",
          runNodeId: "run-node-1",
          runNodeItemId: null,
          projectSourceId: "source-1",
          workerId: "worker-1",
          branchName: "cantrip/workflow/run-1/different",
          baseRevision: "abc123",
        }),
      ).rejects.toThrow(/different worktree reservation/u);
      await expect(
        repository.workflowRuns.activateWorktreeLease(
          "user-1",
          reservation!.lease.id,
          { worktreeId: "different-worktree", startingRevision: "abc123" },
        ),
      ).rejects.toThrow(/reserved identity/u);
      await expect(
        repository.workflowRuns.activateWorktreeLease(
          "user-1",
          reservation!.lease.id,
          { worktreeId: "worktree-1", startingRevision: "abc123" },
        ),
      ).resolves.toMatchObject({
        id: reservation!.lease.id,
        state: "active",
        startingRevision: "abc123",
        worktreeId: "worktree-1",
      });
      await expect(
        repository.workflowRuns.activateWorktreeLease(
          "user-1",
          reservation!.lease.id,
          { worktreeId: "worktree-1", startingRevision: "abc123" },
        ),
      ).resolves.toMatchObject({ state: "active" });
      expect(
        (
          await database.query<{
            state: string;
            worker_id: string | null;
            worktree_id: string | null;
          }>(`
            SELECT state, worker_id, worktree_id
            FROM project_branch_leases
            WHERE workflow_worktree_lease_id = '${reservation!.lease.id}'
          `)
        ).rows,
      ).toEqual([
        {
          state: "active",
          worker_id: "worker-1",
          worktree_id: "worktree-1",
        },
      ]);
      await expect(
        repository.workflowRuns.activateWorktreeLease(
          "user-1",
          reservation!.lease.id,
          { worktreeId: "worktree-1", startingRevision: "different" },
        ),
      ).rejects.toThrow(/already active elsewhere/u);
      await database.exec(`
        UPDATE workflow_run_nodes
        SET status = 'completed'
        WHERE id = 'run-node-1';
      `);
      await expect(
        repository.workflowRuns.reserveWorktreeLease("user-1", {
          runId: "run-1",
          runNodeId: "run-node-1",
          runNodeItemId: null,
          projectSourceId: "source-1",
          workerId: "worker-1",
          branchName: "cantrip/workflow/run-1/inspect",
          baseRevision: "abc123",
        }),
      ).resolves.toMatchObject({
        created: false,
        lease: { id: reservation!.lease.id, state: "active" },
      });
      await database.exec(`
        UPDATE workflow_run_nodes
        SET status = 'running'
        WHERE id = 'run-node-1';
      `);

      const graph = await database.query<{
        attempts: number;
        dependencies: number;
        events: number;
        gates: number;
        items: number;
        item_state_kind: string;
        nodes: number;
        recovery_state: string;
        revisions: number;
        run_worktree_id: string | null;
        unit_key: string;
        worktree_leases: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM workflow_revisions WHERE workflow_id = 'workflow-1') AS revisions,
          (SELECT count(*)::int FROM workflow_run_nodes WHERE run_id = 'run-1') AS nodes,
          (SELECT count(*)::int FROM workflow_run_node_dependencies WHERE run_id = 'run-1') AS dependencies,
          (SELECT count(*)::int FROM workflow_node_attempts WHERE run_node_id IN (SELECT id FROM workflow_run_nodes WHERE run_id = 'run-1')) AS attempts,
          (SELECT count(*)::int FROM workflow_run_node_items WHERE run_node_id = 'run-node-3') AS items,
          (SELECT execution_state->>'kind' FROM workflow_run_node_items WHERE id = 'run-node-item-1') AS item_state_kind,
          (SELECT execution_unit_key FROM workflow_node_attempts WHERE id = 'attempt-item-1') AS unit_key,
          (SELECT count(*)::int FROM workflow_run_events WHERE run_id = 'run-1') AS events,
          (SELECT count(*)::int FROM workflow_approval_gates WHERE run_id = 'run-1') AS gates,
          (SELECT count(*)::int FROM workflow_worktree_leases WHERE run_id = 'run-1') AS worktree_leases,
          (SELECT recovery_state FROM workflow_runs WHERE id = 'run-1') AS recovery_state,
          (SELECT worktree_id FROM workflow_runs WHERE id = 'run-1') AS run_worktree_id
      `);
      expect(graph.rows).toEqual([
        {
          attempts: 2,
          dependencies: 1,
          events: 3,
          gates: 1,
          items: 1,
          item_state_kind: "pipeline",
          nodes: 3,
          recovery_state: "stable",
          revisions: 1,
          run_worktree_id: "worktree-1",
          unit_key: "inspect",
          worktree_leases: 1,
        },
      ]);

      expect(
        (await repository.workflowRuns.getRun("user-1", "run-1"))
          ?.worktreeLeases,
      ).toEqual([
        expect.objectContaining({
          id: reservation!.lease.id,
          requestedWorktreeId: "worktree-1",
          startingRevision: "abc123",
          state: "active",
          worktreeId: "worktree-1",
        }),
      ]);
      expect(
        await repository.getWorktreeRemovalBlockers(
          "user-1",
          "project-1",
          "worktree-1",
        ),
      ).toMatchObject({ workflowLeaseIds: [reservation!.lease.id] });
      await database.exec(`
        UPDATE workflow_worktree_leases
        SET state = 'released', released_at = now()
        WHERE run_id = 'run-1';

        UPDATE project_branch_leases
        SET state = 'released', released_at = now(), updated_at = now()
        WHERE workflow_worktree_lease_id = '${reservation!.lease.id}';
      `);
      expect(
        await repository.getWorktreeRemovalBlockers(
          "user-1",
          "project-1",
          "worktree-1",
        ),
      ).toMatchObject({ workflowLeaseIds: [] });

      const retainedChatLane = await repository.startChatExecutionLane(
        "user-1",
        "chat-branch-contender",
        "agent",
        "Retain a secondary branch",
      );
      expect(retainedChatLane).not.toBeNull();
      await repository.finishChatExecutionLane(
        "chat-branch-contender",
        retainedChatLane!.executionLaneId,
        "idle",
      );
      await expect(
        repository.workflowRuns.reserveWorktreeLease("user-1", {
          runId: "run-1",
          runNodeId: "run-node-1",
          runNodeItemId: null,
          projectSourceId: "source-1",
          workerId: "worker-1",
          requestedWorktreeId: "blocked-by-chat",
          branchName: "cantrip/workflow/run-1/inspect",
          baseRevision: "abc123",
        }),
      ).rejects.toThrow(/Logical branch .* is already leased/u);
      await expect(
        repository.releaseChatExecutionLane(
          "user-1",
          "chat-branch-contender",
          retainedChatLane!.executionLaneId,
          false,
        ),
      ).resolves.toMatchObject({ returnedToPrimary: false });

      const retryReservation =
        await repository.workflowRuns.reserveWorktreeLease("user-1", {
          runId: "run-1",
          runNodeId: "run-node-1",
          runNodeItemId: null,
          projectSourceId: "source-1",
          workerId: "worker-1",
          requestedWorktreeId: "retry-worktree",
          branchName: "cantrip/workflow/run-1/inspect",
          baseRevision: "abc123",
        });
      await expect(
        repository.workflowRuns.failWorktreeLeaseAllocation(
          "user-1",
          retryReservation!.lease.id,
          {
            code: "worker-offline",
            message: "The selected worker disconnected.",
            recoverable: true,
          },
        ),
      ).resolves.toMatchObject({
        errorCode: "worker-offline",
        state: "recovering",
      });
      await expect(
        repository.workflowRuns.failWorktreeLeaseAllocation(
          "user-1",
          retryReservation!.lease.id,
          {
            code: "branch-conflict",
            message: "The reserved branch cannot be reconciled.",
            recoverable: false,
          },
        ),
      ).resolves.toMatchObject({
        errorCode: "branch-conflict",
        state: "failed",
      });
      expect(
        (
          await database.query<{ state: string }>(`
            SELECT state
            FROM project_branch_leases
            WHERE workflow_worktree_lease_id = '${retryReservation!.lease.id}'
          `)
        ).rows,
      ).toEqual([{ state: "released" }]);
      await expect(
        repository.workflowRuns.activateWorktreeLease(
          "user-1",
          retryReservation!.lease.id,
          { worktreeId: "retry-worktree", startingRevision: "abc123" },
        ),
      ).rejects.toThrow(/cannot be activated/u);
    } finally {
      await database.close();
    }
  });

  it("enforces scope, graph, revision, event, and launch invariants", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-guard', 'anonymous', 'Guard Owner');

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-guard', 'user-guard', 'Guarded Project');

        INSERT INTO workflow_definitions (
          id, owner_id, project_id, scope, slug, name
        ) VALUES (
          'workflow-guard', 'user-guard', 'project-guard', 'project',
          'guarded', 'Guarded workflow'
        );

        INSERT INTO workflow_revisions (
          id, workflow_id, revision, definition, source, content_hash
        ) VALUES (
          'revision-guard', 'workflow-guard', 1, '{}'::jsonb,
          'manual', 'sha256:guard'
        );

        INSERT INTO workflow_revision_nodes (
          id, revision_id, node_key, node_type, name, position
        ) VALUES (
          'revision-node-guard', 'revision-guard', 'only', 'agent', 'Only', 0
        );

        INSERT INTO workflow_runs (
          id, workflow_id, workflow_revision_id, owner_id, project_id,
          idempotency_key, structured_input
        ) VALUES (
          'run-guard', 'workflow-guard', 'revision-guard', 'user-guard',
          'project-guard', 'launch-guard', '{}'::jsonb
        );

        INSERT INTO workflow_run_nodes (
          id, run_id, revision_node_id, node_key, node_type, structured_input
        ) VALUES (
          'run-node-guard', 'run-guard', 'revision-node-guard', 'only',
          'agent', '{}'::jsonb
        );

        INSERT INTO workflow_run_events (
          run_id, sequence, event_key, type, actor_type
        ) VALUES (
          'run-guard', 0, 'event-guard', 'run.created', 'server'
        );
      `);

      await expect(
        database.exec(`
          INSERT INTO workflow_definitions (
            id, owner_id, project_id, scope, slug, name
          ) VALUES (
            'invalid-personal', 'user-guard', 'project-guard', 'personal',
            'invalid', 'Invalid personal workflow'
          );
        `),
      ).rejects.toThrow();

      await database.exec(`
        INSERT INTO workflow_worktree_leases (
          id, run_id, run_node_id, requested_worktree_id, lease_key, state
        ) VALUES (
          'lease-guard', 'run-guard', 'run-node-guard',
          'requested-worktree-guard', 'lease-guard', 'allocating'
        );
      `);

      await expect(
        database.exec(`
          INSERT INTO workflow_worktree_leases (
            id, run_id, run_node_id, requested_worktree_id, lease_key, state
          ) VALUES (
            'duplicate-active-node-lease', 'run-guard', 'run-node-guard',
            'requested-worktree-duplicate', 'lease-duplicate', 'active'
          );
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          UPDATE workflow_worktree_leases
          SET state = 'invented'
          WHERE id = 'lease-guard';
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO workflow_revisions (
            id, workflow_id, revision, definition, source, content_hash
          ) VALUES (
            'duplicate-revision', 'workflow-guard', 1, '{}'::jsonb,
            'manual', 'sha256:different'
          );
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO workflow_revision_edges (
            id, revision_id, from_node_id, to_node_id
          ) VALUES (
            'self-edge', 'revision-guard', 'revision-node-guard',
            'revision-node-guard'
          );
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO workflow_runs (
            id, workflow_id, workflow_revision_id, owner_id, project_id,
            idempotency_key, structured_input
          ) VALUES (
            'duplicate-launch', 'workflow-guard', 'revision-guard',
            'user-guard', 'project-guard', 'launch-guard', '{}'::jsonb
          );
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO workflow_run_events (
            run_id, sequence, event_key, type, actor_type
          ) VALUES (
            'run-guard', 1, 'event-guard', 'run.duplicate', 'server'
          );
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          UPDATE workflow_runs SET status = 'invented' WHERE id = 'run-guard';
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
