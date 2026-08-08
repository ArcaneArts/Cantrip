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

describe("worktree persistence migration", () => {
  it("backfills Primary routing and historical execution attribution", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 15);
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
          'source-1', 'project-1', 'worker-1', '/workspace/Cantrip', 'ArcaneArts/Cantrip'
        );

        INSERT INTO chats (id, project_id, title, active_worker_id)
        VALUES ('chat-1', 'project-1', 'Legacy chat', 'worker-1');

        INSERT INTO chat_runtime_sessions (id, chat_id, worker_id, codex_thread_id)
        VALUES ('runtime-1', 'chat-1', 'worker-1', 'thread-1');

        INSERT INTO chat_messages (id, chat_id, role, content)
        VALUES (
          'message-1',
          'chat-1',
          'assistant',
          '[{"type":"text","text":"Legacy response"}]'::jsonb
        );

        INSERT INTO terminals (id, project_id, title, active_worker_id)
        VALUES ('terminal-1', 'project-1', 'Terminal', 'worker-1');

        INSERT INTO explorers (id, project_id, title, active_worker_id)
        VALUES ('explorer-1', 'project-1', 'Explorer', 'worker-1');

        INSERT INTO project_views (id, project_id, title, kind)
        VALUES
          ('history-1', 'project-1', 'History', 'history'),
          ('issues-1', 'project-1', 'Issues', 'issues');
      `);

      await applyMigrations(database, 16, 16);

      const worktrees = await database.query<{
        absolute_path: string;
        id: string;
        is_default: boolean;
        is_primary: boolean;
        lifecycle_state: string;
      }>(`
        SELECT id, absolute_path, is_primary, is_default, lifecycle_state
        FROM project_worktrees
      `);
      expect(worktrees.rows).toEqual([
        {
          id: "primary:source-1",
          absolute_path: "/workspace/Cantrip",
          is_primary: true,
          is_default: true,
          lifecycle_state: "ready",
        },
      ]);

      const bindings = await database.query<{
        chat_worktree: string;
        explorer_worktree: string;
        history_worktree: string;
        issues_worktree: string | null;
        message_lane: string;
        message_worktree: string;
        runtime_worktree: string;
        terminal_worktree: string;
      }>(`
        SELECT
          (SELECT active_worktree_id FROM chats WHERE id = 'chat-1') AS chat_worktree,
          (SELECT worktree_id FROM terminals WHERE id = 'terminal-1') AS terminal_worktree,
          (SELECT worktree_id FROM explorers WHERE id = 'explorer-1') AS explorer_worktree,
          (SELECT worktree_id FROM project_views WHERE id = 'history-1') AS history_worktree,
          (SELECT worktree_id FROM project_views WHERE id = 'issues-1') AS issues_worktree,
          (SELECT worktree_id FROM chat_runtime_sessions WHERE id = 'runtime-1') AS runtime_worktree,
          (SELECT worktree_id FROM chat_messages WHERE id = 'message-1') AS message_worktree,
          (SELECT execution_lane_id FROM chat_messages WHERE id = 'message-1') AS message_lane
      `);
      expect(bindings.rows[0]).toEqual({
        chat_worktree: "primary:source-1",
        terminal_worktree: "primary:source-1",
        explorer_worktree: "primary:source-1",
        history_worktree: "primary:source-1",
        issues_worktree: null,
        runtime_worktree: "primary:source-1",
        message_worktree: "primary:source-1",
        message_lane: "legacy-primary-lane:chat-1",
      });

      const lanes = await database.query<{
        codex_thread_id: string | null;
        runtime_session_id: string | null;
        state: string;
      }>(`
        SELECT state, runtime_session_id, codex_thread_id
        FROM chat_execution_lanes
        WHERE chat_id = 'chat-1'
      `);
      expect(lanes.rows).toEqual([
        {
          state: "released",
          runtime_session_id: "runtime-1",
          codex_thread_id: "thread-1",
        },
      ]);
    } finally {
      await database.close();
    }
  });
});
