import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

async function applyMigrations(
  database: PGlite,
  firstIndex: number,
  lastIndex: number,
) {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
    .filter((name) => {
      const index = Number.parseInt(name.slice(0, 4), 10);
      return index >= firstIndex && index <= lastIndex;
    });
  for (const migrationFile of migrationFiles) {
    await database.exec(
      await readFile(`${migrationsDirectory}/${migrationFile}`, "utf8"),
    );
  }
}

describe("terminal private-state reset migration", () => {
  it("deletes only terminals and their tab memberships", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 108);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', NOW(), NOW()
        );

        INSERT INTO project_workspaces (id, owner_id, name, position, is_default)
        VALUES ('workspace-1', 'owner-1', 'Workspace', 0, TRUE);

        INSERT INTO projects (
          id, owner_id, protected_label, position, tab_layout_revision
        ) VALUES ('project-1', 'owner-1', '{}'::jsonb, 0, 7);

        INSERT INTO project_workspace_memberships (workspace_id, project_id)
        VALUES ('workspace-1', 'project-1');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-1', 'project-1', 'worker-1', '/workspace/Cantrip', 'Cantrip'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Primary',
          '/workspace/Cantrip', 'Cantrip', TRUE, TRUE, 'cantrip', 'ready'
        );

        INSERT INTO terminals (
          id, project_id, protected_label, directory_path, position,
          active_worker_id, worktree_id, service_enabled, service_command
        ) VALUES
          ('terminal-1', 'project-1', '{}'::jsonb, 'private/one', 0,
           'worker-1', 'worktree-1', TRUE, 'pnpm one'),
          ('terminal-2', 'project-1', '{}'::jsonb, 'private/two', 1,
           'worker-1', 'worktree-1', TRUE, 'pnpm two'),
          ('terminal-3', 'project-1', '{}'::jsonb, 'private/three', 2,
           'worker-1', 'worktree-1', FALSE, '');

        INSERT INTO explorers (
          id, project_id, protected_label, position, active_worker_id,
          worktree_id
        ) VALUES
          ('explorer-1', 'project-1', '{}'::jsonb, 3, 'worker-1', 'worktree-1'),
          ('explorer-2', 'project-1', '{}'::jsonb, 4, 'worker-1', 'worktree-1');

        INSERT INTO tab_groups (
          id, project_id, protected_label, position, anchor_tab_key
        ) VALUES
          ('group-repair', 'project-1', '{}'::jsonb, 0, 'terminal:terminal-1'),
          ('group-keep', 'project-1', '{}'::jsonb, 1, 'explorer:explorer-2'),
          ('group-delete', 'project-1', '{}'::jsonb, 2, 'terminal:terminal-3');

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          ('terminal:terminal-1', 'group-repair', 'project-1', 'terminal', 'terminal-1', 0),
          ('explorer:explorer-1', 'group-repair', 'project-1', 'explorer', 'explorer-1', 1),
          ('explorer:explorer-2', 'group-keep', 'project-1', 'explorer', 'explorer-2', 0),
          ('terminal:terminal-2', 'group-keep', 'project-1', 'terminal', 'terminal-2', 1),
          ('terminal:terminal-3', 'group-delete', 'project-1', 'terminal', 'terminal-3', 0);
      `);

      await applyMigrations(database, 109, 109);

      for (const table of [
        "users",
        "workers",
        "project_workspaces",
        "projects",
        "project_workspace_memberships",
        "project_sources",
        "project_worktrees",
      ]) {
        const result = await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table}`,
        );
        expect(result.rows[0]?.count, table).toBe(1);
      }
      expect(
        (
          await database.query<{ id: string }>(
            "SELECT id FROM terminals ORDER BY id",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.query<{ id: string }>(
            "SELECT id FROM explorers ORDER BY id",
          )
        ).rows,
      ).toEqual([{ id: "explorer-1" }, { id: "explorer-2" }]);
      expect(
        (
          await database.query<{
            anchor_tab_key: string;
            id: string;
            protected_label: unknown | null;
          }>(`
            SELECT id, anchor_tab_key, protected_label
            FROM tab_groups
            ORDER BY id
          `)
        ).rows,
      ).toEqual([
        {
          id: "group-keep",
          anchor_tab_key: "explorer:explorer-2",
          protected_label: null,
        },
        {
          id: "group-repair",
          anchor_tab_key: "explorer:explorer-1",
          protected_label: null,
        },
      ]);
      expect(
        (
          await database.query<{ tab_key: string }>(
            "SELECT tab_key FROM tab_group_members ORDER BY tab_key",
          )
        ).rows,
      ).toEqual([
        { tab_key: "explorer:explorer-1" },
        { tab_key: "explorer:explorer-2" },
      ]);
      expect(
        (
          await database.query<{ tab_layout_revision: number }>(
            "SELECT tab_layout_revision FROM projects WHERE id = 'project-1'",
          )
        ).rows[0]?.tab_layout_revision,
      ).toBe(8);

      const columns = await database.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'terminals'
      `);
      const names = columns.rows.map(({ column_name }) => column_name);
      expect(names).toContain("protected_state");
      expect(names).not.toContain("directory_path");
      expect(names).not.toContain("service_command");
    } finally {
      await database.close();
    }
  });
});
