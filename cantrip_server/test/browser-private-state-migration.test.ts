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

describe("browser private-state reset migration", () => {
  it("resets only browser rows, browser surfaces, and their tab memberships", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 110);
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
        ) VALUES ('project-1', 'owner-1', '{}'::jsonb, 0, 12);

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
        ) VALUES (
          'chat-1', 'project-1', '{}'::jsonb, 'agent', 'worker-1', 'worktree-1'
        );

        INSERT INTO terminals (
          id, project_id, protected_label, protected_state, position,
          active_worker_id, worktree_id
        ) VALUES (
          'terminal-1', 'project-1', '{}'::jsonb, '{}'::jsonb, 0,
          'worker-1', 'worktree-1'
        );

        INSERT INTO explorers (
          id, project_id, protected_label, protected_state, file_mode, position,
          active_worker_id, worktree_id
        ) VALUES (
          'explorer-1', 'project-1', '{}'::jsonb, '{}'::jsonb, 'edit', 1,
          'worker-1', 'worktree-1'
        );

        INSERT INTO browsers (id, project_id, protected_label, position, url)
        VALUES
          ('browser-1', 'project-1', '{}'::jsonb, 2, 'https://private.one/'),
          ('browser-2', 'project-1', '{}'::jsonb, 3, 'https://private.two/');

        INSERT INTO remote_surfaces (
          id, project_id, worker_id, kind, protected_label, configuration
        ) VALUES
          ('browser-1', 'project-1', 'worker-1', 'browser', NULL,
           '{"kind":"browser","initialUrl":"https://private.one/","profileId":null}'::jsonb),
          ('standalone-browser', 'project-1', 'worker-1', 'browser', '{}'::jsonb,
           '{"kind":"browser","initialUrl":"https://private.standalone/","profileId":null}'::jsonb),
          ('desktop-1', 'project-1', 'worker-1', 'desktop', '{}'::jsonb,
           '{"kind":"desktop","target":{"kind":"monitor","id":null,"name":null}}'::jsonb);

        INSERT INTO tab_groups (
          id, project_id, protected_label, position, anchor_tab_key
        ) VALUES
          ('group-repair', 'project-1', '{}'::jsonb, 0, 'browser:browser-1'),
          ('group-delete', 'project-1', '{}'::jsonb, 1, 'browser:browser-2');

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          ('browser:browser-1', 'group-repair', 'project-1', 'browser', 'browser-1', 0),
          ('explorer:explorer-1', 'group-repair', 'project-1', 'explorer', 'explorer-1', 1),
          ('browser:browser-2', 'group-delete', 'project-1', 'browser', 'browser-2', 0);
      `);

      await applyMigrations(database, 111, 111);

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
        ["chats", 1],
        ["terminals", 1],
        ["explorers", 1],
      ] as const) {
        const result = await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table}`,
        );
        expect(result.rows[0]?.count, table).toBe(count);
      }
      expect((await database.query("SELECT id FROM browsers")).rows).toEqual(
        [],
      );
      expect(
        (
          await database.query<{ id: string }>(
            "SELECT id FROM remote_surfaces ORDER BY id",
          )
        ).rows,
      ).toEqual([{ id: "desktop-1" }]);
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
          id: "group-repair",
          anchor_tab_key: "explorer:explorer-1",
          protected_label: null,
        },
      ]);
      expect(
        (await database.query("SELECT tab_key FROM tab_group_members")).rows,
      ).toEqual([{ tab_key: "explorer:explorer-1" }]);
      expect(
        (
          await database.query<{ tab_layout_revision: number }>(
            "SELECT tab_layout_revision FROM projects WHERE id = 'project-1'",
          )
        ).rows[0]?.tab_layout_revision,
      ).toBe(13);

      const browserColumns = await database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'browsers'
      `);
      const browserColumnNames = browserColumns.rows.map(
        ({ column_name }) => column_name,
      );
      expect(browserColumnNames).toContain("protected_state");
      expect(browserColumnNames).toContain("state_revision");
      expect(browserColumnNames).not.toContain("url");

      const remoteSurfaceColumns = await database.query<{
        column_name: string;
      }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'remote_surfaces'
      `);
      const remoteSurfaceColumnNames = remoteSurfaceColumns.rows.map(
        ({ column_name }) => column_name,
      );
      expect(remoteSurfaceColumnNames).toContain("protected_state");
      expect(remoteSurfaceColumnNames).toContain("state_revision");
    } finally {
      await database.close();
    }
  });
});
