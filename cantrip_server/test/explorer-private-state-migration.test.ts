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

describe("Explorer private-state reset migration", () => {
  it("deletes only Explorers and their tab memberships", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 109);
      await database.exec(`
        INSERT INTO users (
          id, kind, role, status, display_name, email, normalized_email,
          password_hash
        ) VALUES (
          'owner-1', 'account', 'owner', 'active', 'Owner',
          'owner@example.com', 'owner@example.com', 'auth-hash'
        );

        INSERT INTO account_encryption_profiles (
          owner_id, format_version, active_master_key_revision,
          initialization_status, payload_migration_status
        ) VALUES ('owner-1', 1, 1, 'initialized', 'complete');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', NOW(), NOW()
        );

        INSERT INTO encryption_principals (
          id, owner_id, kind, worker_id, label, public_key, state, approved_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'owner-1', 'worker',
          'worker-1', 'Worker encryption', '{}'::jsonb, 'approved', NOW()
        );

        INSERT INTO encryption_key_grants (
          id, owner_id, principal_id, component, key_revision, wrapped_key
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', 'owner-1',
          '11111111-1111-4111-8111-111111111111',
          'surface-private-state', 1, '{}'::jsonb
        );

        INSERT INTO project_workspaces (id, owner_id, name, position, is_default)
        VALUES ('workspace-1', 'owner-1', 'Workspace', 0, TRUE);

        INSERT INTO projects (
          id, owner_id, protected_label, position, tab_layout_revision
        ) VALUES ('project-1', 'owner-1', '{}'::jsonb, 0, 9);

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

        INSERT INTO chats (
          id, project_id, protected_label, experience, active_worker_id,
          active_worktree_id
        ) VALUES
          ('chat-1', 'project-1', '{}'::jsonb, 'agent', 'worker-1', 'worktree-1'),
          ('task-chat-1', 'project-1', '{}'::jsonb, 'task', 'worker-1', 'worktree-1');

        INSERT INTO tasks (chat_id, protected_content)
        VALUES ('task-chat-1', '{}'::jsonb);

        INSERT INTO terminals (
          id, project_id, protected_label, protected_state, position,
          active_worker_id, worktree_id
        ) VALUES
          ('terminal-1', 'project-1', '{}'::jsonb, '{}'::jsonb, 0,
           'worker-1', 'worktree-1'),
          ('terminal-2', 'project-1', '{}'::jsonb, '{}'::jsonb, 1,
           'worker-1', 'worktree-1');

        INSERT INTO explorers (
          id, project_id, protected_label, selected_path, file_mode, position,
          active_worker_id, worktree_id
        ) VALUES
          ('explorer-1', 'project-1', '{}'::jsonb, 'private/one.ts', 'edit', 1,
           'worker-1', 'worktree-1'),
          ('explorer-2', 'project-1', '{}'::jsonb, 'private/two.ts', 'visual', 2,
           'worker-1', 'worktree-1'),
          ('explorer-3', 'project-1', '{}'::jsonb, NULL, 'preview', 3,
           'worker-1', 'worktree-1');

        INSERT INTO tab_groups (
          id, project_id, protected_label, position, anchor_tab_key
        ) VALUES
          ('group-repair', 'project-1', '{}'::jsonb, 0, 'explorer:explorer-1'),
          ('group-keep', 'project-1', '{}'::jsonb, 1, 'terminal:terminal-2'),
          ('group-delete', 'project-1', '{}'::jsonb, 2, 'explorer:explorer-3');

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          ('explorer:explorer-1', 'group-repair', 'project-1', 'explorer', 'explorer-1', 0),
          ('terminal:terminal-1', 'group-repair', 'project-1', 'terminal', 'terminal-1', 1),
          ('terminal:terminal-2', 'group-keep', 'project-1', 'terminal', 'terminal-2', 0),
          ('explorer:explorer-2', 'group-keep', 'project-1', 'explorer', 'explorer-2', 1),
          ('explorer:explorer-3', 'group-delete', 'project-1', 'explorer', 'explorer-3', 0);
      `);

      await applyMigrations(database, 110, 110);

      for (const [table, count] of [
        ["users", 1],
        ["account_encryption_profiles", 1],
        ["encryption_principals", 1],
        ["encryption_key_grants", 1],
        ["workers", 1],
        ["project_workspaces", 1],
        ["projects", 1],
        ["project_workspace_memberships", 1],
        ["project_sources", 1],
        ["project_worktrees", 1],
        ["chats", 2],
        ["tasks", 1],
        ["terminals", 2],
      ] as const) {
        const result = await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table}`,
        );
        expect(result.rows[0]?.count, table).toBe(count);
      }
      expect(
        (
          await database.query<{ id: string }>(
            "SELECT id FROM explorers ORDER BY id",
          )
        ).rows,
      ).toEqual([]);
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
          anchor_tab_key: "terminal:terminal-2",
          protected_label: null,
        },
        {
          id: "group-repair",
          anchor_tab_key: "terminal:terminal-1",
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
        { tab_key: "terminal:terminal-1" },
        { tab_key: "terminal:terminal-2" },
      ]);
      expect(
        (
          await database.query<{ tab_layout_revision: number }>(
            "SELECT tab_layout_revision FROM projects WHERE id = 'project-1'",
          )
        ).rows[0]?.tab_layout_revision,
      ).toBe(10);

      const columns = await database.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'explorers'
      `);
      const names = columns.rows.map(({ column_name }) => column_name);
      expect(names).toContain("protected_state");
      expect(names).not.toContain("selected_path");
    } finally {
      await database.close();
    }
  });
});
