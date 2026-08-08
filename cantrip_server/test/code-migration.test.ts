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

describe("Cantrip Code persistence migration", () => {
  it("backfills worker capability and enforces durable tab/session identity", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 28);
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

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Primary',
          '/workspace/Cantrip', 'ArcaneArts/Cantrip', true, true,
          'cantrip', 'ready'
        );
      `);

      await applyMigrations(database, 29, 29);

      const workers = await database.query<{
        code_capabilities: {
          available: boolean;
          transport: string;
        };
      }>(`
        SELECT code_capabilities FROM workers WHERE id = 'worker-1'
      `);
      expect(workers.rows[0]?.code_capabilities).toMatchObject({
        available: false,
        transport: "web-proxy",
      });

      await database.exec(`
        INSERT INTO code_tabs (
          id, project_id, title, position, active_worker_id, worktree_id,
          profile_id, theme_mode, status
        ) VALUES (
          'code-1', 'project-1', 'Code', 4, 'worker-1', 'worktree-1',
          'default', 'follow-cantrip', 'running'
        );

        INSERT INTO code_sessions (
          id, code_tab_id, project_id, worker_id, worktree_id, profile_id,
          editor_version, editor_upstream_revision, editor_patchset,
          editor_fingerprint, status
        ) VALUES (
          'session-1', 'code-1', 'project-1', 'worker-1', 'worktree-1',
          'default', '1.109.5',
          '4ffe2270acdf711bbefecc3e8c79f4b3631640e5', 1,
          '${"a".repeat(64)}', 'running'
        );
      `);

      const sessions = await database.query<{
        code_tab_id: string;
        status: string;
        worktree_id: string;
      }>(`
        SELECT code_tab_id, status, worktree_id FROM code_sessions
      `);
      expect(sessions.rows).toEqual([
        {
          code_tab_id: "code-1",
          status: "running",
          worktree_id: "worktree-1",
        },
      ]);

      await expect(
        database.exec(`
          INSERT INTO code_sessions (
            id, code_tab_id, project_id, worker_id, worktree_id, profile_id,
            editor_version, editor_upstream_revision, editor_patchset,
            editor_fingerprint, status
          ) VALUES (
            'session-duplicate', 'code-1', 'project-1', 'worker-1',
            'worktree-1', 'default', '1.109.5',
            '4ffe2270acdf711bbefecc3e8c79f4b3631640e5', 1,
            '${"a".repeat(64)}', 'running'
          );
        `),
      ).rejects.toThrow();

      await database.exec(`DELETE FROM code_tabs WHERE id = 'code-1';`);
      expect(
        (
          await database.query<{ count: number }>(`
          SELECT count(*)::int AS count FROM code_sessions
        `)
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await database.close();
    }
  });
});
