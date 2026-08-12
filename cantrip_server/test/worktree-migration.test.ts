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
  it("backfills one logical owner per project branch", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 63);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-lease', 'anonymous', 'Lease User');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES
          ('worker-lease-a', 'user-lease', 'Lease A', 'darwin', 'arm64', now(), now()),
          ('worker-lease-b', 'user-lease', 'Lease B', 'linux', 'x64', now(), now());

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-lease', 'user-lease', 'Cantrip');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES
          ('source-lease-a', 'project-lease', 'worker-lease-a', '/repo-a', 'repo-a'),
          ('source-lease-b', 'project-lease', 'worker-lease-b', '/repo-b', 'repo-b');

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state, branch, head
        ) VALUES
          ('primary-lease-a', 'source-lease-a', 'worker-lease-a', 'Primary', '/repo-a', 'repo-a', true, true, 'cantrip', 'ready', 'main', 'abc123'),
          ('primary-lease-b', 'source-lease-b', 'worker-lease-b', 'Primary', '/repo-b', 'repo-b', true, true, 'cantrip', 'ready', 'main', 'abc123'),
          ('feature-lease-b', 'source-lease-b', 'worker-lease-b', 'Feature', '/feature-b', 'feature-b', false, false, 'agent', 'ready', 'feature', 'def456');

        INSERT INTO chats (
          id, project_id, title, status, active_worker_id, active_worktree_id
        ) VALUES
          ('chat-lease-active', 'project-lease', 'Active', 'running', 'worker-lease-a', 'primary-lease-a'),
          ('chat-lease-idle', 'project-lease', 'Idle', 'idle', 'worker-lease-b', 'primary-lease-b'),
          ('chat-lease-feature', 'project-lease', 'Feature', 'idle', 'worker-lease-b', 'feature-lease-b');

        INSERT INTO chat_execution_lanes (
          id, chat_id, worktree_id, worker_id, acquiring_actor, exclusive,
          state, purpose
        ) VALUES
          ('lane-lease-active', 'chat-lease-active', 'primary-lease-a', 'worker-lease-a', 'agent', false, 'active', 'Active turn'),
          ('lane-lease-idle', 'chat-lease-idle', 'primary-lease-b', 'worker-lease-b', 'agent', false, 'suspended', 'Idle Primary'),
          ('lane-lease-feature', 'chat-lease-feature', 'feature-lease-b', 'worker-lease-b', 'agent', true, 'suspended', 'Retained feature');
      `);

      await applyMigrations(database, 64, 64);

      const leases = await database.query<{
        branch_name: string;
        chat_execution_lane_id: string;
      }>(`
        SELECT branch_name, chat_execution_lane_id
        FROM project_branch_leases
        ORDER BY branch_name
      `);
      expect(leases.rows).toEqual([
        {
          branch_name: "feature",
          chat_execution_lane_id: "lane-lease-feature",
        },
        {
          branch_name: "main",
          chat_execution_lane_id: "lane-lease-active",
        },
      ]);
      await expect(
        database.exec(`
          INSERT INTO project_branch_leases (
            id, project_id, branch_name, chat_execution_lane_id
          ) VALUES (
            'duplicate-main', 'project-lease', 'main', 'lane-lease-idle'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

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

  it("makes Primary shareable while preserving exclusive secondary leases", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 17);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-runtime', 'anonymous', 'Runtime User');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-runtime', 'user-runtime', 'Runtime Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-runtime', 'user-runtime', 'Cantrip');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-runtime', 'project-runtime', 'worker-runtime', '/repo', 'repo'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES
          ('primary-runtime', 'source-runtime', 'worker-runtime', 'Primary', '/repo', 'repo', true, true, 'cantrip', 'ready'),
          ('secondary-runtime', 'source-runtime', 'worker-runtime', 'Review', '/worktrees/review', 'review', false, false, 'agent', 'ready');

        INSERT INTO chats (
          id, project_id, title, active_worker_id, active_worktree_id
        ) VALUES
          ('chat-primary-1', 'project-runtime', 'Primary one', 'worker-runtime', 'primary-runtime'),
          ('chat-primary-2', 'project-runtime', 'Primary two', 'worker-runtime', 'primary-runtime'),
          ('chat-secondary-1', 'project-runtime', 'Secondary one', 'worker-runtime', 'secondary-runtime'),
          ('chat-secondary-2', 'project-runtime', 'Secondary two', 'worker-runtime', 'secondary-runtime');

        INSERT INTO chat_execution_lanes (
          id, chat_id, worktree_id, worker_id, acquiring_actor, state
        ) VALUES (
          'lane-primary-1', 'chat-primary-1', 'primary-runtime', 'worker-runtime', 'user', 'suspended'
        );
      `);

      await applyMigrations(database, 18, 18);

      const backfilled = await database.query<{ exclusive: boolean }>(`
        SELECT exclusive FROM chat_execution_lanes WHERE id = 'lane-primary-1'
      `);
      expect(backfilled.rows).toEqual([{ exclusive: false }]);

      await database.exec(`
        INSERT INTO chat_execution_lanes (
          id, chat_id, worktree_id, worker_id, acquiring_actor, exclusive, state
        ) VALUES (
          'lane-primary-2', 'chat-primary-2', 'primary-runtime', 'worker-runtime', 'user', false, 'suspended'
        );
        INSERT INTO chat_execution_lanes (
          id, chat_id, worktree_id, worker_id, acquiring_actor, exclusive, state
        ) VALUES (
          'lane-secondary-1', 'chat-secondary-1', 'secondary-runtime', 'worker-runtime', 'user', true, 'suspended'
        );
      `);

      await expect(
        database.exec(`
          INSERT INTO chat_execution_lanes (
            id, chat_id, worktree_id, worker_id, acquiring_actor, exclusive, state
          ) VALUES (
            'lane-secondary-2', 'chat-secondary-2', 'secondary-runtime', 'worker-runtime', 'user', true, 'suspended'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  it("detaches legacy Codex threads and permits one pending transition per chat", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 18);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-transition', 'anonymous', 'Transition User');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-transition', 'user-transition', 'Transition Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-transition', 'user-transition', 'Cantrip');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-transition', 'project-transition', 'worker-transition', '/repo', 'repo'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES
          ('primary-transition', 'source-transition', 'worker-transition', 'Primary', '/repo', 'repo', true, true, 'cantrip', 'ready'),
          ('secondary-transition', 'source-transition', 'worker-transition', 'Agent', '/worktrees/agent', 'agent', false, false, 'agent', 'ready');

        INSERT INTO chats (
          id, project_id, title, active_worker_id, active_worktree_id
        ) VALUES (
          'chat-transition', 'project-transition', 'Transition chat', 'worker-transition', 'primary-transition'
        );

        INSERT INTO chat_runtime_sessions (
          id, chat_id, worker_id, worktree_id, codex_thread_id, status
        ) VALUES (
          'runtime-transition', 'chat-transition', 'worker-transition', 'primary-transition', 'legacy-thread', 'idle'
        );

        INSERT INTO chat_execution_lanes (
          id, chat_id, worktree_id, worker_id, acquiring_actor, exclusive,
          state, runtime_session_id, codex_thread_id
        ) VALUES (
          'lane-transition', 'chat-transition', 'primary-transition', 'worker-transition', 'agent', false,
          'suspended', 'runtime-transition', 'legacy-thread'
        );
      `);

      await applyMigrations(database, 19, 19);

      const runtime = await database.query<{
        codex_thread_id: string | null;
        status: string;
      }>(`
        SELECT codex_thread_id, status
        FROM chat_runtime_sessions
        WHERE id = 'runtime-transition'
      `);
      expect(runtime.rows).toEqual([
        { codex_thread_id: null, status: "detached" },
      ]);
      const lane = await database.query<{
        codex_thread_id: string | null;
        transition_kind: string | null;
      }>(`
        SELECT codex_thread_id, transition_kind
        FROM chat_execution_lanes
        WHERE id = 'lane-transition'
      `);
      expect(lane.rows).toEqual([
        { codex_thread_id: null, transition_kind: null },
      ]);

      await database.exec(`
        UPDATE chat_execution_lanes
        SET state = 'delivering', transition_kind = 'switch'
        WHERE id = 'lane-transition';
      `);
      await expect(
        database.exec(`
          INSERT INTO chat_execution_lanes (
            id, chat_id, worktree_id, worker_id, acquiring_actor, exclusive,
            state, transition_kind
          ) VALUES (
            'lane-transition-two', 'chat-transition', 'secondary-transition', 'worker-transition', 'agent', false,
            'delivering', 'switch'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
