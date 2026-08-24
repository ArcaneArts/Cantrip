import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
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
});
