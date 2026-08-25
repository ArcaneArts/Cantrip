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

describe("standalone Chat execution migration", () => {
  it("attributes every message to exactly one authorized execution root", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 167);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('execution-owner', 'anonymous', 'Execution Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'execution-worker', 'execution-owner', 'Execution Worker', 'linux',
          'x64', now(), now()
        );

        INSERT INTO projects (
          id, owner_id, protected_label, github_repository_blind_index
        ) VALUES (
          'execution-project', 'execution-owner', '{}',
          'standalone-execution-project'
        );
        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'execution-source', 'execution-project', 'execution-worker',
          '/project', '/project'
        );
        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'execution-worktree', 'execution-source', 'execution-worker', 'main',
          '/project', '/project', true, true, 'cantrip', 'ready'
        );

        INSERT INTO chats (
          id, owner_id, context_kind, project_id, protected_label,
          active_worker_id, active_worktree_id, worktree_mode
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'execution-owner',
          'project', 'execution-project', '{}', 'execution-worker',
          'execution-worktree', 'agent-managed'
        );

        BEGIN;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO chats (
          id, owner_id, context_kind, project_id, protected_label, experience,
          active_worker_id, active_worktree_id, active_scratch_root_id,
          worktree_mode
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', 'execution-owner',
          'standalone', NULL, '{}', 'agent', 'execution-worker', NULL,
          '33333333-3333-4333-8333-333333333333', NULL
        );
        INSERT INTO standalone_chat_roots (
          id, chat_id, owner_id, worker_id, protected_path_handle, status
        ) VALUES (
          '33333333-3333-4333-8333-333333333333',
          '22222222-2222-4222-8222-222222222222', 'execution-owner',
          'execution-worker',
          'ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ready'
        );
        COMMIT;
      `);

      await applyMigrations(database, 168, 168);
      await database.exec(`
        INSERT INTO chat_messages (
          id, chat_id, worktree_id, role, content
        ) VALUES (
          'project-message', '11111111-1111-4111-8111-111111111111',
          'execution-worktree', 'user', '[]'
        );
        INSERT INTO chat_messages (
          id, chat_id, scratch_root_id, role, content
        ) VALUES (
          'standalone-message', '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333', 'user', '[]'
        );
      `);

      const roots = await database.query<{
        id: string;
        scratch_root_id: string | null;
        worktree_id: string | null;
      }>(`
        SELECT id, worktree_id, scratch_root_id
        FROM chat_messages ORDER BY id
      `);
      expect(roots.rows).toEqual([
        {
          id: "project-message",
          scratch_root_id: null,
          worktree_id: "execution-worktree",
        },
        {
          id: "standalone-message",
          scratch_root_id: "33333333-3333-4333-8333-333333333333",
          worktree_id: null,
        },
      ]);

      await expect(
        database.exec(`
          INSERT INTO chat_messages (id, chat_id, role, content)
          VALUES (
            'missing-root', '22222222-2222-4222-8222-222222222222',
            'user', '[]'
          );
        `),
      ).rejects.toThrow();
      await expect(
        database.exec(`
          INSERT INTO chat_messages (
            id, chat_id, worktree_id, scratch_root_id, role, content
          ) VALUES (
            'two-roots', '22222222-2222-4222-8222-222222222222',
            'execution-worktree', '33333333-3333-4333-8333-333333333333',
            'user', '[]'
          );
        `),
      ).rejects.toThrow();
      await expect(
        database.exec(`
          INSERT INTO chat_messages (
            id, chat_id, scratch_root_id, role, content
          ) VALUES (
            'cross-chat-root', '11111111-1111-4111-8111-111111111111',
            '33333333-3333-4333-8333-333333333333', 'user', '[]'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
