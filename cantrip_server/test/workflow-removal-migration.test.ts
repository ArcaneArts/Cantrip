import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  clearSensitiveBytes,
  decryptProjectAutomationContent,
  deriveComponentKey,
  encryptProjectAutomationContent,
  generateAccountMasterKey,
} from "../../packages/crypto/src/index.js";
import {
  projectAutomationProtectedConditionSchema,
  projectAutomationProtectedNameSchema,
  projectAutomationProtectedPromptSchema,
} from "@cantrip/protocol/automations";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { accountStorageMeasurementQuery } from "../src/db/account-resource-usage.js";
import { DesktopUpdateStateRepository } from "../src/db/repository/desktop-update-state.js";
import * as schema from "../src/db/schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const workflowTables = [
  "workflow_trigger_deliveries",
  "workflow_automation_triggers",
  "workflow_approval_gates",
  "workflow_run_events",
  "workflow_worktree_leases",
  "workflow_node_attempts",
  "workflow_run_node_dependencies",
  "workflow_run_node_items",
  "workflow_run_nodes",
  "workflow_runs",
  "workflow_revision_edges",
  "workflow_revision_nodes",
  "workflow_revisions",
  "workflow_definitions",
] as const;

async function migrateToWorkflowRemoval(client: PGlite) {
  const migrations = readMigrationFiles({ migrationsFolder });
  const removalIndex = migrations.findIndex((migration) =>
    migration.sql.some((statement) =>
      statement.includes('DROP TABLE "workflow_definitions"'),
    ),
  );
  expect(removalIndex).toBeGreaterThan(0);
  for (const migration of migrations.slice(0, removalIndex)) {
    for (const statement of migration.sql) await client.exec(statement);
  }
  return migrations[removalIndex]!;
}

async function tableNames(client: PGlite, names: readonly string[]) {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [names],
  );
  return result.rows.map(({ table_name }) => table_name);
}

async function preservedState(client: PGlite): Promise<unknown> {
  const result = await client.query<{ state: unknown }>(`
    SELECT jsonb_build_object(
      'project', (SELECT jsonb_build_object(
        'id', id, 'protectedLabel', protected_label,
        'repositoryBlindIndex', github_repository_blind_index
      ) FROM projects WHERE id = 'project-1'),
      'worktree', (SELECT jsonb_build_object(
        'id', id, 'branch', branch, 'head', head, 'lifecycle', lifecycle_state
      ) FROM project_worktrees WHERE id = 'worktree-1'),
      'chat', (SELECT jsonb_build_object(
        'id', id, 'protectedLabel', protected_label, 'status', status
      ) FROM chats WHERE id = 'chat-1'),
      'task', (SELECT jsonb_build_object(
        'chatId', chat_id, 'state', state, 'protectedContent', protected_content
      ) FROM tasks WHERE chat_id = 'chat-1'),
      'automation', (SELECT jsonb_build_object(
        'id', id, 'protectedName', protected_name,
        'protectedPrompt', protected_prompt,
        'protectedCondition', protected_condition,
        'schedule', schedule, 'revision', revision
      ) FROM project_automations WHERE id = 'automation-1'),
      'automationRun', (SELECT jsonb_build_object(
        'id', id, 'status', status, 'automationRevision', automation_revision
      ) FROM project_automation_runs WHERE id = 'automation-run-1'),
      'settings', (SELECT jsonb_build_object(
        'theme', theme, 'contentGutters', content_gutters
      ) FROM user_settings WHERE user_id = 'owner-1'),
      'encryptionProfile', (SELECT jsonb_build_object(
        'formatVersion', format_version,
        'masterKeyRevision', active_master_key_revision,
        'migrationStatus', payload_migration_status
      ) FROM account_encryption_profiles WHERE owner_id = 'owner-1'),
      'principal', (SELECT jsonb_build_object(
        'id', id, 'publicKey', public_key, 'state', state
      ) FROM encryption_principals WHERE id = 'principal-1'),
      'grant', (SELECT jsonb_build_object(
        'id', id, 'component', component, 'wrappedKey', wrapped_key,
        'state', state
      ) FROM encryption_key_grants WHERE id = 'grant-1'),
      'interaction', (SELECT jsonb_build_object(
        'id', id, 'requestKey', request_key, 'payload', payload,
        'status', status
      ) FROM agent_interaction_requests WHERE id = 'interaction-normal'),
      'branchLease', (SELECT jsonb_build_object(
        'id', id, 'branchName', branch_name, 'state', state
      ) FROM project_branch_leases WHERE id = 'chat-branch-lease'),
      'tunnel', (SELECT jsonb_build_object(
        'id', id, 'origin', origin, 'management', management,
        'protectedContent', protected_content
      ) FROM tunnels WHERE id = 'tunnel-user'),
      'currentUsage', (SELECT jsonb_build_object(
        'category', category, 'logicalBytes', logical_bytes::text,
        'rowCount', row_count::text, 'basisVersion', basis_version
      ) FROM account_storage_usage_current
        WHERE owner_id = 'owner-1' AND category = 'projects'),
      'usageHistory', (SELECT jsonb_build_object(
        'category', category, 'logicalBytes', logical_bytes::text,
        'rowCount', row_count::text, 'basisVersion', basis_version
      ) FROM account_storage_usage_snapshots
        WHERE owner_id = 'owner-1' AND category = 'projects')
    ) AS state
  `);
  return result.rows[0]?.state;
}

describe("durable workflow removal migration", () => {
  it("removes workflow-owned state while preserving unrelated durable data", async () => {
    const client = new PGlite();
    const accountMasterKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey,
      ownerId: "owner-1",
      component: "workflow-content",
      keyRevision: 1,
    });
    try {
      const removal = await migrateToWorkflowRemoval(client);
      const [protectedName, protectedPrompt, protectedCondition] =
        await Promise.all([
          encryptProjectAutomationContent({
            ownerId: "owner-1",
            context: {
              recordKind: "project-automation",
              recordId: "automation-1",
              field: "name",
            },
            keyRevision: 1,
            componentKey,
            content: { version: 1 as const, name: "Preserved automation" },
            schema: projectAutomationProtectedNameSchema,
          }),
          encryptProjectAutomationContent({
            ownerId: "owner-1",
            context: {
              recordKind: "project-automation",
              recordId: "automation-1",
              field: "prompt",
            },
            keyRevision: 1,
            componentKey,
            content: {
              version: 1 as const,
              prompt: "Preserve this ciphertext",
            },
            schema: projectAutomationProtectedPromptSchema,
          }),
          encryptProjectAutomationContent({
            ownerId: "owner-1",
            context: {
              recordKind: "project-automation",
              recordId: "automation-1",
              field: "condition",
            },
            keyRevision: 1,
            componentKey,
            content: { version: 1 as const, condition: null },
            schema: projectAutomationProtectedConditionSchema,
          }),
        ]);

      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO user_settings (user_id, theme)
        VALUES ('owner-1', 'dark');

        INSERT INTO account_storage_usage_current (
          owner_id, storage_class, category, logical_bytes, row_count,
          basis_version, measured_at
        ) VALUES
          ('owner-1', 'server', 'projects', 700, 7, 'fixture-v1', now()),
          ('owner-1', 'server', 'workflows', 900, 9, 'fixture-v1', now());

        INSERT INTO account_storage_usage_snapshots (
          owner_id, bucket_start, resolution, storage_class, category,
          logical_bytes, row_count, basis_version, measured_at
        ) VALUES
          ('owner-1', '2026-09-03T00:00:00Z', 'hour', 'server', 'projects',
            700, 7, 'fixture-v1', '2026-09-03T00:01:00Z'),
          ('owner-1', '2026-09-03T00:00:00Z', 'hour', 'server', 'workflows',
            900, 9, 'fixture-v1', '2026-09-03T00:01:00Z');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO account_encryption_profiles (
          owner_id, format_version, active_master_key_revision,
          initialization_status, payload_migration_status
        ) VALUES ('owner-1', 1, 1, 'initialized', 'complete');

        INSERT INTO encryption_principals (
          id, owner_id, kind, public_key, state, approved_at
        ) VALUES (
          'principal-1', 'owner-1', 'client', '{"fixture":"public-key"}',
          'approved', now()
        );

        INSERT INTO encryption_key_grants (
          id, owner_id, principal_id, component, key_revision, wrapped_key
        ) VALUES (
          'grant-1', 'owner-1', 'principal-1', 'workflow-content', 1,
          '{"fixture":"wrapped-key"}'
        );

        INSERT INTO projects (
          id, owner_id, protected_label, github_repository_blind_index
        ) VALUES (
          'project-1', 'owner-1', '{"fixture":"project-label"}',
          'project-blind-index'
        );

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-1', 'project-1', 'worker-1', '/fixture', '/fixture'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state, branch, head
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Primary', '/fixture',
          '/fixture', true, true, 'cantrip', 'ready', 'main', 'abc123'
        );

        INSERT INTO chats (
          id, owner_id, project_id, protected_label, active_worker_id,
          active_worktree_id
        ) VALUES (
          'chat-1', 'owner-1', 'project-1', '{"fixture":"chat-label"}',
          'worker-1', 'worktree-1'
        );

        INSERT INTO tasks (chat_id, protected_content)
        VALUES ('chat-1', '{"fixture":"task-content"}');

        INSERT INTO chat_execution_lanes (
          id, chat_id, worktree_id, worker_id, acquiring_actor, state
        ) VALUES (
          'lane-1', 'chat-1', 'worktree-1', 'worker-1', 'user', 'released'
        );

        INSERT INTO project_branch_leases (
          id, project_id, branch_name, chat_execution_lane_id, worktree_id,
          worker_id, state
        ) VALUES (
          'chat-branch-lease', 'project-1', 'chat-branch', 'lane-1',
          'worktree-1', 'worker-1', 'released'
        );

        INSERT INTO agent_interaction_requests (
          id, request_key, owner_id, project_id, chat_id, worker_id, thread_id,
          kind, payload
        ) VALUES (
          'interaction-normal', 'request-normal', 'owner-1', 'project-1',
          'chat-1', 'worker-1', 'thread-normal', 'userInput',
          '{"kind":"userInput","questions":[]}'
        );

        INSERT INTO tunnels (
          id, owner_id, project_id, origin, management, protocol_hint,
          source_kind, destination_kind, destination_worker_id,
          protected_content, protected_operation_id, protected_revision
        ) VALUES (
          'tunnel-user', 'owner-1', 'project-1', 'user', 'user-managed', 'tcp',
          'desktop-loopback', 'worker-tcp', 'worker-1',
          '{"fixture":"tunnel-content"}', 'operation-user', 1
        );

        INSERT INTO workflow_definitions (
          id, owner_id, project_id, scope, slug_blind_index, protected_slug,
          protected_name, protected_description, protected_provenance
        ) VALUES (
          'workflow-1', 'owner-1', 'project-1', 'project', 'workflow-blind',
          '{}', '{}', '{}', '{}'
        );

        INSERT INTO workflow_revisions (
          id, workflow_id, revision, source, protected_provenance,
          content_blind_index, protected_content_hash, protected_definition
        ) VALUES (
          'workflow-revision-1', 'workflow-1', 1, 'cantrip', '{}',
          'workflow-content-blind', '{}', '{}'
        );

        INSERT INTO workflow_revision_nodes (
          id, revision_id, node_key, node_type, name, position
        ) VALUES
          ('revision-node-1', 'workflow-revision-1', 'first', 'agent', 'First', 0),
          ('revision-node-2', 'workflow-revision-1', 'second', 'agent', 'Second', 1);

        INSERT INTO workflow_revision_edges (
          id, revision_id, from_node_id, to_node_id
        ) VALUES (
          'revision-edge-1', 'workflow-revision-1', 'revision-node-1',
          'revision-node-2'
        );

        INSERT INTO workflow_runs (
          id, workflow_id, workflow_revision_id, owner_id, project_id,
          idempotency_key, structured_input, protected_input, worktree_id,
          worker_id
        ) VALUES (
          'workflow-run-1', 'workflow-1', 'workflow-revision-1', 'owner-1',
          'project-1', 'workflow-run-idempotency', '{}', '{}', 'worktree-1',
          'worker-1'
        );

        INSERT INTO workflow_automation_triggers (
          id, workflow_id, workflow_revision_id, owner_id, project_id, type,
          protected_name, protected_configuration, protected_input, last_run_id
        ) VALUES (
          'workflow-trigger-1', 'workflow-1', 'workflow-revision-1', 'owner-1',
          'project-1', 'schedule', '{}', '{}', '{}', 'workflow-run-1'
        );

        INSERT INTO workflow_trigger_deliveries (
          id, trigger_id, run_id, idempotency_key
        ) VALUES (
          'workflow-delivery-1', 'workflow-trigger-1', 'workflow-run-1',
          'workflow-delivery-idempotency'
        );

        INSERT INTO workflow_run_nodes (
          id, run_id, revision_node_id, node_key, node_type, structured_input,
          worktree_id, worker_id
        ) VALUES
          ('run-node-1', 'workflow-run-1', 'revision-node-1', 'first', 'agent',
            '{}', 'worktree-1', 'worker-1'),
          ('run-node-2', 'workflow-run-1', 'revision-node-2', 'second', 'agent',
            '{}', 'worktree-1', 'worker-1');

        INSERT INTO workflow_run_node_dependencies (
          id, run_id, revision_edge_id, from_node_id, to_node_id
        ) VALUES (
          'run-dependency-1', 'workflow-run-1', 'revision-edge-1',
          'run-node-1', 'run-node-2'
        );

        INSERT INTO workflow_run_node_items (
          id, run_node_id, item_key, position, structured_input
        ) VALUES ('run-item-1', 'run-node-1', 'item-1', 0, '{}');

        INSERT INTO workflow_node_attempts (
          id, run_node_id, run_node_item_id, attempt, idempotency_key,
          structured_input
        ) VALUES (
          'attempt-1', 'run-node-1', 'run-item-1', 1,
          'workflow-attempt-idempotency', '{}'
        );

        INSERT INTO workflow_worktree_leases (
          id, run_id, run_node_id, run_node_item_id, project_source_id,
          worker_id, requested_worktree_id, worktree_id, lease_key, branch_name
        ) VALUES (
          'workflow-lease-1', 'workflow-run-1', 'run-node-1', 'run-item-1',
          'source-1', 'worker-1', 'requested-worktree-1', 'worktree-1',
          'workflow-lease-key', 'workflow-branch'
        );

        INSERT INTO project_branch_leases (
          id, project_id, branch_name, workflow_worktree_lease_id, worktree_id,
          worker_id
        ) VALUES (
          'workflow-branch-lease', 'project-1', 'workflow-branch',
          'workflow-lease-1', 'worktree-1', 'worker-1'
        );

        INSERT INTO workflow_run_events (
          run_id, run_node_id, attempt_id, sequence, event_key, type,
          actor_type
        ) VALUES (
          'workflow-run-1', 'run-node-1', 'attempt-1', 0,
          'workflow-event-key', 'run-started', 'system'
        );

        INSERT INTO workflow_approval_gates (
          id, run_id, run_node_id, gate_key, requested_by_type
        ) VALUES (
          'workflow-gate-1', 'workflow-run-1', 'run-node-1',
          'workflow-gate-key', 'system'
        );

        INSERT INTO agent_interaction_requests (
          id, request_key, owner_id, project_id, chat_id, worker_id, thread_id,
          workflow_run_id, workflow_node_id, kind, payload
        ) VALUES (
          'interaction-workflow', 'request-workflow', 'owner-1', 'project-1',
          'chat-1', 'worker-1', 'thread-workflow', 'workflow-run-1',
          'run-node-1', 'userInput', '{"kind":"userInput","questions":[]}'
        );

        INSERT INTO tunnels (
          id, owner_id, project_id, origin, management, protocol_hint,
          source_kind, destination_kind, destination_worker_id,
          protected_content, protected_operation_id, protected_revision,
          managed_by_kind, managed_by_id
        ) VALUES (
          'tunnel-workflow', 'owner-1', 'project-1', 'workflow',
          'managed-durable', 'tcp', 'desktop-loopback', 'worker-tcp',
          'worker-1', '{"fixture":"workflow-tunnel"}', 'operation-workflow', 1,
          'workflow', 'workflow-run-1'
        );
      `);

      await client.query(
        `INSERT INTO project_automations (
           id, owner_id, project_id, chat_id, protected_name, protected_prompt,
           schedule, protected_condition
         ) VALUES (
           'automation-1', 'owner-1', 'project-1', 'chat-1',
           $1::jsonb, $2::jsonb,
           '{"kind":"interval","every":1,"unit":"hour","startsAt":"2026-09-03T00:00:00.000Z"}',
           $3::jsonb
         )`,
        [
          JSON.stringify(protectedName),
          JSON.stringify(protectedPrompt),
          JSON.stringify(protectedCondition),
        ],
      );
      await client.exec(`
        INSERT INTO project_automation_runs (
          id, automation_id, owner_id, project_id, chat_id, worker_id,
          automation_revision, scheduled_for, dispatch_instance_id, lease_token,
          lease_expires_at
        ) VALUES (
          'automation-run-1', 'automation-1', 'owner-1', 'project-1', 'chat-1',
          'worker-1', 1, '2026-09-03T01:00:00Z', 'dispatch-1', 'lease-token-1',
          '2026-09-03T01:05:00Z'
        );
      `);

      const stateBeforeRemoval = await preservedState(client);
      for (const statement of removal.sql) await client.exec(statement);

      expect(await tableNames(client, workflowTables)).toEqual([]);
      const removedColumns = await client.query<{ column_name: string }>(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (
             (table_name = 'agent_interaction_requests'
               AND column_name IN ('workflow_run_id', 'workflow_node_id'))
             OR
             (table_name = 'project_branch_leases'
               AND column_name = 'workflow_worktree_lease_id')
           )
      `);
      expect(removedColumns.rows).toEqual([]);

      const workflowSchemaObjects = await client.query<{ name: string }>(`
        SELECT constraint_name AS name
          FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND constraint_name LIKE '%workflow%'
        UNION ALL
        SELECT indexname AS name
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname LIKE '%workflow%'
        ORDER BY name
      `);
      expect(workflowSchemaObjects.rows).toEqual([]);
      expect(await preservedState(client)).toEqual(stateBeforeRemoval);

      const activeWork = await new DesktopUpdateStateRepository(
        drizzle(client, { schema }),
      ).desktopUpdateActiveWork("owner-1");
      expect(activeWork).toEqual({
        activeChats: 0,
        queuedPrompts: 0,
        terminalServices: 0,
        backgroundJobs: 1,
      });

      const preserved = await client.query<{
        automations: number;
        automation_runs: number;
        branch_leases: number;
        chats: number;
        encryption_grants: number;
        interactions: number;
        projects: number;
        tasks: number;
        tunnels: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM projects) AS projects,
          (SELECT count(*)::int FROM chats) AS chats,
          (SELECT count(*)::int FROM tasks) AS tasks,
          (SELECT count(*)::int FROM project_automations) AS automations,
          (SELECT count(*)::int FROM project_automation_runs) AS automation_runs,
          (SELECT count(*)::int FROM encryption_key_grants) AS encryption_grants,
          (SELECT count(*)::int FROM agent_interaction_requests) AS interactions,
          (SELECT count(*)::int FROM project_branch_leases) AS branch_leases,
          (SELECT count(*)::int FROM tunnels) AS tunnels
      `);
      expect(preserved.rows[0]).toEqual({
        projects: 1,
        chats: 1,
        tasks: 1,
        automations: 1,
        automation_runs: 1,
        encryption_grants: 1,
        interactions: 1,
        branch_leases: 1,
        tunnels: 1,
      });

      const settings = await client.query<{ theme: string }>(
        "SELECT theme FROM user_settings WHERE user_id = 'owner-1'",
      );
      expect(settings.rows).toEqual([{ theme: "dark" }]);

      const usageHistory = await client.query<{
        category: string;
        logical_bytes: string;
        row_count: string;
        source: string;
      }>(
        `SELECT 'current' AS source, category,
                logical_bytes::text, row_count::text
           FROM account_storage_usage_current
         UNION ALL
         SELECT 'snapshot' AS source, category,
                logical_bytes::text, row_count::text
           FROM account_storage_usage_snapshots
          ORDER BY source, category`,
      );
      expect(usageHistory.rows).toEqual([
        {
          source: "current",
          category: "projects",
          logical_bytes: "700",
          row_count: "7",
        },
        {
          source: "snapshot",
          category: "projects",
          logical_bytes: "700",
          row_count: "7",
        },
      ]);

      const automation = await client.query<{ protected_prompt: unknown }>(
        "SELECT protected_prompt FROM project_automations WHERE id = 'automation-1'",
      );
      await expect(
        decryptProjectAutomationContent({
          ownerId: "owner-1",
          context: {
            recordKind: "project-automation",
            recordId: "automation-1",
            field: "prompt",
          },
          keyRevision: 1,
          componentKey,
          encrypted: automation.rows[0]!.protected_prompt as never,
          schema: projectAutomationProtectedPromptSchema,
        }),
      ).resolves.toEqual({
        version: 1,
        prompt: "Preserve this ciphertext",
      });

      const measurementSql = accountStorageMeasurementQuery();
      expect(measurementSql).toContain('"tasks"');
      expect(measurementSql).toContain('"project_automations"');
      expect(measurementSql).not.toContain("workflow_");
      const measurements = await client.query<{ category: string }>(
        measurementSql,
      );
      expect(
        measurements.rows.some(({ category }) => category === "projects"),
      ).toBe(true);
      expect(
        measurements.rows.some(({ category }) => category === "conversations"),
      ).toBe(true);
      expect(
        measurements.rows.some(({ category }) => category === "workflows"),
      ).toBe(false);

      await expect(
        client.exec(`
          INSERT INTO tunnels (
            id, owner_id, origin, management, protocol_hint, source_kind,
            destination_kind, destination_worker_id, protected_content,
            protected_operation_id, protected_revision, managed_by_kind,
            managed_by_id
          ) VALUES (
            'forbidden-workflow-tunnel', 'owner-1', 'workflow',
            'managed-durable', 'tcp', 'desktop-loopback', 'worker-tcp',
            'worker-1', '{}', 'operation-forbidden', 1, 'workflow', 'run'
          )
        `),
      ).rejects.toThrow();
      await expect(
        client.exec(`
          INSERT INTO project_branch_leases (
            id, project_id, branch_name, worktree_id, worker_id
          ) VALUES (
            'holderless-branch', 'project-1', 'holderless', 'worktree-1',
            'worker-1'
          )
        `),
      ).rejects.toThrow();
    } finally {
      clearSensitiveBytes(componentKey);
      clearSensitiveBytes(accountMasterKey);
      await client.close();
    }
  });

  it("creates a workflow-free schema and does not replay the migration journal", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      await migrate(database, { migrationsFolder });
      expect(await tableNames(client, workflowTables)).toEqual([]);

      const journal = await client.query<{ count: number }>(`
        SELECT count(*)::int AS count
          FROM drizzle.__drizzle_migrations
         WHERE hash = (
           SELECT hash
             FROM drizzle.__drizzle_migrations
            ORDER BY created_at DESC
            LIMIT 1
         )
      `);
      expect(journal.rows).toEqual([{ count: 1 }]);
    } finally {
      await client.close();
    }
  });
});
