import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

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
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Workflow lane',
          '/worktrees/workflow-1', 'worktrees/workflow-1', false, false,
          'workflow', 'ready'
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
          ('revision-node-1', 'revision-1', 'inspect', 'agent', 'Inspect', 0, 'read-only'),
          ('revision-node-2', 'revision-1', 'verify', 'verify', 'Verify', 1, 'read-only'),
          ('revision-node-3', 'revision-1', 'map', 'map', 'Map', 2, 'read-only');

        INSERT INTO workflow_revision_edges (
          id, revision_id, from_node_id, to_node_id, position
        ) VALUES (
          'revision-edge-1', 'revision-1', 'revision-node-1', 'revision-node-2', 0
        );

        INSERT INTO workflow_runs (
          id, workflow_id, workflow_revision_id, owner_id, project_id, status,
          trigger_type, idempotency_key, structured_input, budget,
          permission_manifest, worker_id, worktree_id, recovery_state
        ) VALUES (
          'run-1', 'workflow-1', 'revision-1', 'user-1', 'project-1', 'running',
          'manual', 'launch-1', '{"target":"src"}'::jsonb,
          '{"maxTokens":20000,"maxSeconds":600}'::jsonb,
          '{"filesystem":"read"}'::jsonb, 'worker-1', 'worktree-1', 'stable'
        );

        INSERT INTO workflow_run_nodes (
          id, run_id, revision_node_id, node_key, node_type, status,
          structured_input, worker_id, worktree_id, codex_thread_id
        ) VALUES
          (
            'run-node-1', 'run-1', 'revision-node-1', 'inspect', 'agent',
            'running', '{"target":"src"}'::jsonb, 'worker-1', 'worktree-1',
            'thread-1'
          ),
          (
            'run-node-2', 'run-1', 'revision-node-2', 'verify', 'verify',
            'blocked', '{}'::jsonb, null, null, null
          ),
          (
            'run-node-3', 'run-1', 'revision-node-3', 'map', 'map',
            'completed', '{"items":["alpha"]}'::jsonb, null, null, null
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
          worktree_id, attempt_count
        ) VALUES (
          'run-node-item-1', 'run-node-3', 'alpha', 0,
          '{"item":"alpha"}'::jsonb, 'worker-1', 'worktree-1', 1
        );

        INSERT INTO workflow_node_attempts (
          id, run_node_id, run_node_item_id, attempt, status, idempotency_key,
          structured_input, worker_id, worktree_id
        ) VALUES (
          'attempt-item-1', 'run-node-3', 'run-node-item-1', 1, 'completed',
          'dispatch-item-1', '{"item":"alpha"}'::jsonb, 'worker-1',
          'worktree-1'
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
          '{"filesystem":"read"}'::jsonb
        );
      `);

      const graph = await database.query<{
        attempts: number;
        dependencies: number;
        events: number;
        gates: number;
        items: number;
        nodes: number;
        recovery_state: string;
        revisions: number;
        run_worktree_id: string | null;
      }>(`
        SELECT
          (SELECT count(*)::int FROM workflow_revisions WHERE workflow_id = 'workflow-1') AS revisions,
          (SELECT count(*)::int FROM workflow_run_nodes WHERE run_id = 'run-1') AS nodes,
          (SELECT count(*)::int FROM workflow_run_node_dependencies WHERE run_id = 'run-1') AS dependencies,
          (SELECT count(*)::int FROM workflow_node_attempts WHERE run_node_id IN (SELECT id FROM workflow_run_nodes WHERE run_id = 'run-1')) AS attempts,
          (SELECT count(*)::int FROM workflow_run_node_items WHERE run_node_id = 'run-node-3') AS items,
          (SELECT count(*)::int FROM workflow_run_events WHERE run_id = 'run-1') AS events,
          (SELECT count(*)::int FROM workflow_approval_gates WHERE run_id = 'run-1') AS gates,
          (SELECT recovery_state FROM workflow_runs WHERE id = 'run-1') AS recovery_state,
          (SELECT worktree_id FROM workflow_runs WHERE id = 'run-1') AS run_worktree_id
      `);
      expect(graph.rows).toEqual([
        {
          attempts: 2,
          dependencies: 1,
          events: 1,
          gates: 1,
          items: 1,
          nodes: 3,
          recovery_state: "stable",
          revisions: 1,
          run_worktree_id: "worktree-1",
        },
      ]);
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
