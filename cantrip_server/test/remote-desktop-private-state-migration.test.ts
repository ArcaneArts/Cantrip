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

describe("Remote Desktop private-state reset migration", () => {
  it("removes only Remote Desktops and preserves account, project, chat, History, and Issues rows", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 111);
      await database.exec(`
        INSERT INTO users (
          id, kind, role, status, display_name, email, normalized_email,
          password_hash
        ) VALUES (
          'owner-1', 'account', 'owner', 'active', 'Owner',
          'owner@example.com', 'owner@example.com', 'auth-hash'
        );

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', NOW(), NOW()
        );

        INSERT INTO projects (
          id, owner_id, protected_label, position, tab_layout_revision
        ) VALUES ('project-1', 'owner-1', '{}'::jsonb, 0, 7);

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
          id, project_id, protected_label, experience,
          active_worker_id, active_worktree_id
        ) VALUES (
          'chat-1', 'project-1', '{}'::jsonb, 'agent',
          'worker-1', 'worktree-1'
        );

        INSERT INTO project_views (
          id, project_id, protected_label, kind, position
        ) VALUES
          ('desktop-1', 'project-1', '{}'::jsonb, 'remote-desktop', 0),
          ('desktop-2', 'project-1', '{}'::jsonb, 'remote-desktop', 1),
          ('history-1', 'project-1', '{}'::jsonb, 'history', 2),
          ('issues-1', 'project-1', '{}'::jsonb, 'issues', 3);

        INSERT INTO remote_surfaces (
          id, project_id, worker_id, kind, configuration,
          protected_state, state_revision
        ) VALUES
          ('desktop-1', 'project-1', 'worker-1', 'desktop',
           '{"kind":"desktop","target":{"kind":"window","id":"secret-window","application":"Secret App","title":"Secret Window"}}'::jsonb,
           NULL, NULL),
          ('desktop-2', 'project-1', 'worker-1', 'desktop',
           '{"kind":"desktop","target":{"kind":"monitor","id":null,"name":"Secret Display"}}'::jsonb,
           NULL, NULL),
          ('browser-1', 'project-1', 'worker-1', 'browser',
           '{"kind":"browser","profileId":null}'::jsonb,
           '{}'::jsonb, 1);

        INSERT INTO tab_groups (
          id, project_id, protected_label, position, anchor_tab_key
        ) VALUES
          ('group-repair', 'project-1', '{}'::jsonb, 0, 'remote-desktop:desktop-1'),
          ('group-delete', 'project-1', '{}'::jsonb, 1, 'remote-desktop:desktop-2');

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          ('remote-desktop:desktop-1', 'group-repair', 'project-1', 'remote-desktop', 'desktop-1', 0),
          ('history:history-1', 'group-repair', 'project-1', 'history', 'history-1', 1),
          ('remote-desktop:desktop-2', 'group-delete', 'project-1', 'remote-desktop', 'desktop-2', 0);
      `);

      await applyMigrations(database, 112, 112);

      for (const [table, count] of [
        ["users", 1],
        ["workers", 1],
        ["projects", 1],
        ["chats", 1],
      ] as const) {
        const result = await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table}`,
        );
        expect(result.rows[0]?.count, table).toBe(count);
      }
      expect(
        (
          await database.query<{ id: string; kind: string }>(
            "SELECT id, kind FROM project_views ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "history-1", kind: "history" },
        { id: "issues-1", kind: "issues" },
      ]);
      expect(
        (
          await database.query<{ id: string }>(
            "SELECT id FROM remote_surfaces ORDER BY id",
          )
        ).rows,
      ).toEqual([{ id: "browser-1" }]);
      expect(
        (
          await database.query<{
            anchor_tab_key: string;
            id: string;
            protected_label: unknown | null;
          }>(
            "SELECT id, anchor_tab_key, protected_label FROM tab_groups ORDER BY id",
          )
        ).rows,
      ).toEqual([
        {
          id: "group-repair",
          anchor_tab_key: "history:history-1",
          protected_label: null,
        },
      ]);
      expect(
        (await database.query("SELECT tab_key FROM tab_group_members")).rows,
      ).toEqual([{ tab_key: "history:history-1" }]);
      expect(
        (
          await database.query<{ tab_layout_revision: number }>(
            "SELECT tab_layout_revision FROM projects WHERE id = 'project-1'",
          )
        ).rows[0]?.tab_layout_revision,
      ).toBe(8);

      await expect(
        database.exec(`
          INSERT INTO remote_surfaces (
            id, project_id, worker_id, kind, configuration
          ) VALUES (
            'invalid-desktop', 'project-1', 'worker-1', 'desktop',
            '{"kind":"desktop","target":{"kind":"monitor","id":null,"name":null}}'::jsonb
          )
        `),
      ).rejects.toThrow(/remote_surfaces_desktop_private_state_check/u);
      await expect(
        database.exec(`
          INSERT INTO remote_surfaces (
            id, project_id, worker_id, kind, configuration,
            protected_state, state_revision
          ) VALUES (
            'encrypted-desktop', 'project-1', 'worker-1', 'desktop',
            '{"kind":"desktop"}'::jsonb, '{}'::jsonb, 1
          )
        `),
      ).resolves.toBeDefined();
    } finally {
      await database.close();
    }
  });
});
