import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("Task scheduling migration", () => {
  it("adds scheduling persistence without creating a default Task Worker", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const taskWorkers = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM task_workers",
      );
      expect(taskWorkers.rows[0]?.count).toBe(0);

      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('task_workers', 'task_dispatch_cycles')
        ORDER BY table_name
      `);
      expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
        "task_dispatch_cycles",
        "task_workers",
      ]);
      const dispatchColumns = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'task_dispatch_cycles'
          AND column_name = 'operation_id'
          AND is_nullable = 'NO'
      `);
      expect(dispatchColumns.rows).toEqual([{ column_name: "operation_id" }]);

      const taskColumns = await client.query<{
        column_name: string;
        column_default: string | null;
      }>(`
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tasks'
          AND column_name IN (
            'priority',
            'requested_task_worker_id',
            'continuity_family',
            'last_task_worker_id',
            'completed_at',
            'scheduler_revision'
          )
      `);
      expect(
        taskColumns.rows.map(({ column_name }) => column_name).sort(),
      ).toEqual([
        "completed_at",
        "continuity_family",
        "last_task_worker_id",
        "priority",
        "requested_task_worker_id",
        "scheduler_revision",
      ]);
      expect(
        taskColumns.rows.find(({ column_name }) => column_name === "priority")
          ?.column_default,
      ).toBe("0");

      const projectColumns = await client.query<{
        column_name: string;
        column_default: string | null;
      }>(`
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'projects'
          AND column_name IN (
            'task_scheduling_paused',
            'task_scheduling_paused_at',
            'task_scheduling_revision'
          )
      `);
      expect(
        projectColumns.rows.map(({ column_name }) => column_name).sort(),
      ).toEqual([
        "task_scheduling_paused",
        "task_scheduling_paused_at",
        "task_scheduling_revision",
      ]);
    } finally {
      await client.close();
    }
  });

  it("queues only inert legacy drafts and backfills completion time", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const migrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes("legacy-task-dispatch:"),
        ),
      );
      const migration = migrations[migrationIndex];
      expect(migration).toBeDefined();
      for (const earlier of migrations.slice(0, migrationIndex)) {
        for (const statement of earlier.sql) await client.exec(statement);
      }
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO projects (
          id, owner_id, protected_label, github_repository_blind_index
        ) VALUES ('project-1', 'owner-1', '{}', 'project-blind-index');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-1', 'project-1', 'worker-1', '/fixture', '/fixture'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'main', '/fixture', '/fixture',
          true, true, 'cantrip', 'ready'
        );

        INSERT INTO chats (
          id, project_id, protected_label, experience, active_worktree_id,
          archived_at, created_at, updated_at
        ) VALUES
          ('direct', 'project-1', '{}', 'task', 'worktree-1', NULL,
            '2026-08-24T10:00:00Z', '2026-08-24T10:05:00Z'),
          ('plan', 'project-1', '{}', 'task', 'worktree-1', NULL,
            '2026-08-24T11:00:00Z', '2026-08-24T11:05:00Z'),
          ('complete', 'project-1', '{}', 'task', 'worktree-1', NULL,
            '2026-08-24T12:00:00Z', '2026-08-24T12:05:00Z'),
          ('archived', 'project-1', '{}', 'task', 'worktree-1',
            '2026-08-24T13:06:00Z', '2026-08-24T13:00:00Z',
            '2026-08-24T13:05:00Z'),
          ('active', 'project-1', '{}', 'task', 'worktree-1', NULL,
            '2026-08-24T14:00:00Z', '2026-08-24T14:05:00Z'),
          ('review', 'project-1', '{}', 'task', 'worktree-1', NULL,
            '2026-08-24T15:00:00Z', '2026-08-24T15:05:00Z');

        INSERT INTO tasks (
          chat_id, state, plan_goal_enabled, active_operation_id,
          active_operation_kind, protected_content, created_at, updated_at
        ) VALUES
          ('direct', 'draft', false, NULL, NULL, '{}',
            '2026-08-24T10:00:00Z', '2026-08-24T10:05:00Z'),
          ('plan', 'draft', true, NULL, NULL, '{}',
            '2026-08-24T11:00:00Z', '2026-08-24T11:05:00Z'),
          ('complete', 'complete', false, NULL, NULL, '{}',
            '2026-08-24T12:00:00Z', '2026-08-24T12:05:00Z'),
          ('archived', 'draft', false, NULL, NULL, '{}',
            '2026-08-24T13:00:00Z', '2026-08-24T13:05:00Z'),
          ('active', 'planning', true, 'active-operation', 'initial-plan', '{}',
            '2026-08-24T14:00:00Z', '2026-08-24T14:05:00Z'),
          ('review', 'review', true, NULL, NULL, '{}',
            '2026-08-24T15:00:00Z', '2026-08-24T15:05:00Z');
      `);
      for (const statement of migration!.sql) await client.exec(statement);

      const dispatches = await client.query<{
        chat_id: string;
        operation_kind: string;
        fifo_created_at: Date;
        queued_at: Date;
      }>(`
        SELECT chat_id, operation_kind, fifo_created_at, queued_at
        FROM task_dispatch_cycles
        ORDER BY fifo_created_at
      `);
      expect(
        dispatches.rows.map(({ chat_id, operation_kind }) => ({
          chatId: chat_id,
          operationKind: operation_kind,
        })),
      ).toEqual([
        { chatId: "direct", operationKind: "direct" },
        { chatId: "plan", operationKind: "initial-plan" },
      ]);
      expect(dispatches.rows[0]?.fifo_created_at.toISOString()).toBe(
        "2026-08-24T10:00:00.000Z",
      );
      expect(dispatches.rows[0]?.queued_at.toISOString()).toBe(
        "2026-08-24T10:00:00.000Z",
      );

      const completed = await client.query<{ completed_at: Date }>(`
        SELECT completed_at FROM tasks WHERE chat_id = 'complete'
      `);
      expect(completed.rows[0]?.completed_at.toISOString()).toBe(
        "2026-08-24T12:05:00.000Z",
      );
      const taskWorkers = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM task_workers",
      );
      expect(taskWorkers.rows[0]?.count).toBe(0);
    } finally {
      await client.close();
    }
  });
});
