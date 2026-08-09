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

describe("project tab group migration", () => {
  it("backfills singleton groups in legacy order and excludes linked consoles", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 36);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-1', 'anonymous', 'Local User');

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
          'source-1', 'project-1', 'worker-1', '/workspace/Cantrip',
          'ArcaneArts/Cantrip'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Primary',
          '/workspace/Cantrip', 'ArcaneArts/Cantrip', true, true,
          'cantrip', 'ready'
        );

        INSERT INTO chats (
          id, project_id, title, position, active_worker_id, active_worktree_id
        ) VALUES (
          'chat-1', 'project-1', 'Chat', 4, 'worker-1', 'worktree-1'
        );

        INSERT INTO terminals (
          id, project_id, title, position, active_worker_id, worktree_id,
          linked_chat_id
        ) VALUES
          ('terminal-1', 'project-1', 'Terminal', 2, 'worker-1', 'worktree-1', null),
          ('console-1', 'project-1', 'Codex console', 4, 'worker-1', 'worktree-1', 'chat-1');

        INSERT INTO explorers (
          id, project_id, title, position, active_worker_id, worktree_id
        ) VALUES (
          'explorer-1', 'project-1', 'Explorer', 3, 'worker-1', 'worktree-1'
        );

        INSERT INTO browsers (id, project_id, title, position)
        VALUES ('browser-1', 'project-1', 'Browser', 0);

        INSERT INTO code_tabs (
          id, project_id, title, position, active_worker_id, worktree_id,
          profile_id, theme_mode, status
        ) VALUES (
          'code-1', 'project-1', 'Code', 5, 'worker-1', 'worktree-1',
          'default', 'follow-cantrip', 'idle'
        );

        INSERT INTO project_views (id, project_id, title, kind, position)
        VALUES
          ('history-1', 'project-1', 'History', 'history', 1),
          ('issues-1', 'project-1', 'Issues', 'issues', 6);
      `);

      await applyMigrations(database, 37, 37);

      const groups = await database.query<{
        anchor_tab_key: string;
        id: string;
        position: number;
      }>(`
        SELECT id, position, anchor_tab_key
        FROM tab_groups
        WHERE project_id = 'project-1'
        ORDER BY position
      `);
      expect(groups.rows).toEqual([
        {
          id: "singleton:browser:browser-1",
          position: 0,
          anchor_tab_key: "browser:browser-1",
        },
        {
          id: "singleton:view:history-1",
          position: 1,
          anchor_tab_key: "view:history-1",
        },
        {
          id: "singleton:terminal:terminal-1",
          position: 2,
          anchor_tab_key: "terminal:terminal-1",
        },
        {
          id: "singleton:explorer:explorer-1",
          position: 3,
          anchor_tab_key: "explorer:explorer-1",
        },
        {
          id: "singleton:chat:chat-1",
          position: 4,
          anchor_tab_key: "chat:chat-1",
        },
        {
          id: "singleton:code:code-1",
          position: 5,
          anchor_tab_key: "code:code-1",
        },
        {
          id: "singleton:view:issues-1",
          position: 6,
          anchor_tab_key: "view:issues-1",
        },
      ]);

      const members = await database.query<{
        position: number;
        tab_key: string;
        tab_kind: string;
      }>(`
        SELECT tab_key, tab_kind, position
        FROM tab_group_members
        WHERE project_id = 'project-1'
        ORDER BY tab_key
      `);
      expect(members.rows).toHaveLength(7);
      expect(members.rows).not.toContainEqual(
        expect.objectContaining({ tab_key: "terminal:console-1" }),
      );
      expect(members.rows.every(({ position }) => position === 0)).toBe(true);
      expect(
        (
          await database.query<{ tab_layout_revision: number }>(`
            SELECT tab_layout_revision FROM projects WHERE id = 'project-1'
          `)
        ).rows[0]?.tab_layout_revision,
      ).toBe(1);

      await database.exec(`
        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-2', 'user-1', 'Other');
        INSERT INTO tab_groups (id, project_id, position, anchor_tab_key)
        VALUES ('group-2', 'project-2', 0, 'chat:missing');
      `);
      await expect(
        database.exec(`
          INSERT INTO tab_group_members (
            tab_key, group_id, project_id, tab_kind, tab_id, position
          ) VALUES (
            'chat:mismatch', 'group-2', 'project-1', 'chat', 'mismatch', 0
          );
        `),
      ).rejects.toThrow();

      await database.exec(`DELETE FROM projects WHERE id = 'project-1';`);
      expect(
        (
          await database.query<{ count: number }>(`
            SELECT count(*)::int AS count FROM tab_groups
          `)
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await database.query<{ count: number }>(`
            SELECT count(*)::int AS count FROM tab_group_members
          `)
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await database.close();
    }
  });
});
