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
): Promise<void> {
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

describe("standalone Chat contract migration", () => {
  it("backfills project Chats and enforces tagged ownership and roots", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 165);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES
          ('owner-1', 'anonymous', 'Owner One'),
          ('owner-2', 'anonymous', 'Owner Two');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO projects (
          id, owner_id, protected_label, github_repository_blind_index
        ) VALUES (
          'project-1', 'owner-1', '{}', 'standalone-contract-project'
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

        INSERT INTO user_settings (user_id) VALUES ('owner-1');

        INSERT INTO chats (
          id, project_id, protected_label, active_worktree_id
        ) VALUES (
          '11111111-1111-4111-8111-111111111111',
          'project-1', '{}', 'worktree-1'
        );

        INSERT INTO chat_runtime_sessions (
          id, chat_id, worker_id, worktree_id
        ) VALUES (
          'runtime-project', '11111111-1111-4111-8111-111111111111',
          'worker-1', 'worktree-1'
        );

        INSERT INTO chat_execution_lanes (
          id, chat_id, worktree_id, worker_id, acquiring_actor, state
        ) VALUES (
          'lane-project', '11111111-1111-4111-8111-111111111111',
          'worktree-1', 'worker-1', 'agent', 'suspended'
        );

        INSERT INTO agent_interaction_requests (
          id, request_key, project_id, chat_id, worker_id, thread_id, kind
        ) VALUES (
          'interaction-project', 'interaction-project-key', 'project-1',
          '11111111-1111-4111-8111-111111111111', 'worker-1', 'thread-1',
          'permissions'
        );
      `);

      await applyMigrations(database, 166, 166);

      const backfilled = await database.query<{
        active_scratch_root_id: string | null;
        context_kind: string;
        owner_id: string;
        project_id: string | null;
      }>(`
        SELECT owner_id, context_kind, project_id, active_scratch_root_id
        FROM chats
        WHERE id = '11111111-1111-4111-8111-111111111111'
      `);
      expect(backfilled.rows[0]).toEqual({
        active_scratch_root_id: null,
        context_kind: "project",
        owner_id: "owner-1",
        project_id: "project-1",
      });

      const settings = await database.query<{
        default_chat_model_id: string | null;
        default_chat_permission_profile_id: string;
        destination_revision: number;
        last_app_mode: string | null;
      }>(`
        SELECT default_chat_model_id, default_chat_permission_profile_id,
               destination_revision, last_app_mode
        FROM user_settings WHERE user_id = 'owner-1'
      `);
      expect(settings.rows[0]).toEqual({
        default_chat_model_id: null,
        default_chat_permission_profile_id: ":workspace",
        destination_revision: 1,
        last_app_mode: null,
      });

      const interactions = await database.query<{
        owner_id: string;
        project_id: string | null;
      }>(`
        SELECT owner_id, project_id FROM agent_interaction_requests
        WHERE id = 'interaction-project'
      `);
      expect(interactions.rows[0]).toEqual({
        owner_id: "owner-1",
        project_id: "project-1",
      });

      const projectRoots = await database.query<{
        lane_scratch_root_id: string | null;
        lane_worktree_id: string | null;
        runtime_scratch_root_id: string | null;
        runtime_worktree_id: string | null;
      }>(`
        SELECT runtime.worktree_id AS runtime_worktree_id,
               runtime.scratch_root_id AS runtime_scratch_root_id,
               lane.worktree_id AS lane_worktree_id,
               lane.scratch_root_id AS lane_scratch_root_id
        FROM chat_runtime_sessions AS runtime
        INNER JOIN chat_execution_lanes AS lane
          ON lane.chat_id = runtime.chat_id
        WHERE runtime.id = 'runtime-project'
      `);
      expect(projectRoots.rows[0]).toEqual({
        lane_scratch_root_id: null,
        lane_worktree_id: "worktree-1",
        runtime_scratch_root_id: null,
        runtime_worktree_id: "worktree-1",
      });

      await database.exec(`
        BEGIN;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO chats (
          id, owner_id, context_kind, project_id, protected_label, experience,
          active_worker_id, active_worktree_id, active_scratch_root_id,
          worktree_mode
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', 'owner-1', 'standalone',
          NULL, '{}', 'agent', 'worker-1', NULL,
          '33333333-3333-4333-8333-333333333333', NULL
        );
        INSERT INTO standalone_chat_roots (
          id, chat_id, owner_id, worker_id, protected_path_handle
        ) VALUES (
          '33333333-3333-4333-8333-333333333333',
          '22222222-2222-4222-8222-222222222222',
          'owner-1', 'worker-1', 'opaque-root-handle'
        );
        COMMIT;

        INSERT INTO chat_runtime_sessions (
          id, chat_id, worker_id, scratch_root_id
        ) VALUES (
          'runtime-standalone', '22222222-2222-4222-8222-222222222222',
          'worker-1', '33333333-3333-4333-8333-333333333333'
        );

        INSERT INTO chat_execution_lanes (
          id, chat_id, scratch_root_id, worker_id, acquiring_actor, state
        ) VALUES (
          'lane-standalone', '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333', 'worker-1', 'user',
          'suspended'
        );

        INSERT INTO agent_interaction_requests (
          id, request_key, owner_id, project_id, chat_id, worker_id,
          thread_id, kind
        ) VALUES (
          'interaction-standalone', 'interaction-standalone-key', 'owner-1',
          NULL, '22222222-2222-4222-8222-222222222222', 'worker-1',
          'thread-2', 'permissions'
        );
      `);

      const standalone = await database.query<{
        active_scratch_root_id: string;
        active_worktree_id: string | null;
        context_kind: string;
        project_id: string | null;
      }>(`
        SELECT context_kind, project_id, active_worktree_id,
               active_scratch_root_id
        FROM chats
        WHERE id = '22222222-2222-4222-8222-222222222222'
      `);
      expect(standalone.rows[0]).toEqual({
        active_scratch_root_id: "33333333-3333-4333-8333-333333333333",
        active_worktree_id: null,
        context_kind: "standalone",
        project_id: null,
      });

      await expect(
        database.exec(`
          INSERT INTO chat_runtime_sessions (
            id, chat_id, worker_id, worktree_id, scratch_root_id
          ) VALUES (
            'runtime-invalid', '22222222-2222-4222-8222-222222222222',
            'worker-1', 'worktree-1',
            '33333333-3333-4333-8333-333333333333'
          )
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          UPDATE chats SET owner_id = 'owner-2'
          WHERE id = '11111111-1111-4111-8111-111111111111'
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO chat_runtime_sessions (
            id, chat_id, worker_id, scratch_root_id
          ) VALUES (
            'runtime-wrong-chat',
            '11111111-1111-4111-8111-111111111111', 'worker-1',
            '33333333-3333-4333-8333-333333333333'
          )
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO agent_interaction_requests (
            id, request_key, owner_id, project_id, chat_id, worker_id,
            thread_id, kind
          ) VALUES (
            'interaction-wrong-owner', 'interaction-wrong-owner-key',
            'owner-2', NULL, '22222222-2222-4222-8222-222222222222',
            'worker-1', 'thread-wrong-owner', 'permissions'
          )
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          UPDATE chats SET experience = 'task'
          WHERE id = '22222222-2222-4222-8222-222222222222'
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
