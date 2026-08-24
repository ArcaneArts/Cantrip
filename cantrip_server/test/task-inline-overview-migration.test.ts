import { readFile, readdir } from "node:fs/promises";
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

describe("Task inline overview migration", () => {
  it("removes legacy Task tabs and repairs their remaining groups", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 163);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO projects (
          id, owner_id, protected_label, github_repository_blind_index,
          tab_layout_revision
        ) VALUES (
          'project-1', 'owner-1', '{}', 'project-blind-index', 7
        );

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
          id, project_id, protected_label, experience, active_worktree_id
        ) VALUES
          ('task-mixed', 'project-1', '{}', 'task', 'worktree-1'),
          ('task-only', 'project-1', '{}', 'task', 'worktree-1'),
          ('agent', 'project-1', '{}', 'agent', 'worktree-1');

        INSERT INTO tab_groups (
          id, project_id, position, anchor_tab_key, protected_label
        ) VALUES
          ('mixed', 'project-1', 0, 'chat:task-mixed', '{}'),
          ('task-only', 'project-1', 1, 'chat:task-only', '{}');

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          ('chat:task-mixed', 'mixed', 'project-1', 'chat', 'task-mixed', 0),
          ('chat:agent', 'mixed', 'project-1', 'chat', 'agent', 1),
          ('chat:task-only', 'task-only', 'project-1', 'chat', 'task-only', 0);
      `);

      await applyMigrations(database, 164, 164);

      const members = await database.query<{
        group_id: string;
        tab_key: string;
      }>(`
        SELECT group_id, tab_key FROM tab_group_members ORDER BY tab_key
      `);
      expect(members.rows).toEqual([
        { group_id: "mixed", tab_key: "chat:agent" },
      ]);

      const groups = await database.query<{
        anchor_tab_key: string;
        id: string;
        protected_label: unknown;
      }>(`
        SELECT id, anchor_tab_key, protected_label FROM tab_groups ORDER BY id
      `);
      expect(groups.rows).toEqual([
        {
          anchor_tab_key: "chat:agent",
          id: "mixed",
          protected_label: null,
        },
      ]);

      const projects = await database.query<{ tab_layout_revision: number }>(`
        SELECT tab_layout_revision FROM projects WHERE id = 'project-1'
      `);
      expect(projects.rows[0]?.tab_layout_revision).toBe(8);
    } finally {
      await database.close();
    }
  });
});
