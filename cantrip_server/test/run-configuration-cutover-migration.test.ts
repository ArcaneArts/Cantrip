import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../drizzle/0159_wandering_silk_fever.sql", import.meta.url),
);

describe("Run configuration cutover migration", () => {
  it("retires legacy runs and setup jobs without leaving worktrees blocked", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE project_worktrees (
          id text PRIMARY KEY,
          lifecycle_state text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE terminals (
          id text PRIMARY KEY,
          status text NOT NULL,
          service_enabled boolean NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE run_instances (
          id text PRIMARY KEY,
          terminal_id text
        );
        CREATE TABLE worktree_setup_jobs (id text PRIMARY KEY);

        INSERT INTO project_worktrees (id, lifecycle_state) VALUES
          ('preparing', 'preparing'),
          ('failed', 'setup-failed'),
          ('stale', 'setup-stale'),
          ('missing', 'missing');
        INSERT INTO terminals (id, status, service_enabled) VALUES
          ('legacy-run-terminal', 'running', true),
          ('ordinary-terminal', 'running', true);
        INSERT INTO run_instances (id, terminal_id) VALUES
          ('legacy-run', 'legacy-run-terminal');
        INSERT INTO worktree_setup_jobs (id) VALUES ('legacy-setup');
      `);

      await database.exec(await readFile(migrationPath, "utf8"));

      const worktrees = await database.query<{
        id: string;
        lifecycle_state: string;
      }>(`
        SELECT id, lifecycle_state FROM project_worktrees ORDER BY id
      `);
      expect(worktrees.rows).toEqual([
        { id: "failed", lifecycle_state: "ready" },
        { id: "missing", lifecycle_state: "missing" },
        { id: "preparing", lifecycle_state: "ready" },
        { id: "stale", lifecycle_state: "ready" },
      ]);

      const terminals = await database.query<{
        id: string;
        service_enabled: boolean;
        status: string;
      }>(`
        SELECT id, status, service_enabled FROM terminals ORDER BY id
      `);
      expect(terminals.rows).toEqual([
        {
          id: "legacy-run-terminal",
          service_enabled: false,
          status: "exited",
        },
        {
          id: "ordinary-terminal",
          service_enabled: true,
          status: "running",
        },
      ]);

      const retiredTables = await database.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('run_instances', 'worktree_setup_jobs')
      `);
      expect(retiredTables.rows).toEqual([]);
    } finally {
      await database.close();
    }
  });
});
