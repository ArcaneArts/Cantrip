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

describe("project origin persistence migration", () => {
  it("backfills Git kinds and enforces managed-folder shapes", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 94);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-origin', 'anonymous', 'Origin User');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-origin', 'user-origin', 'Origin Worker', 'linux', 'x64', now(), now()
        );

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-git', 'user-origin', 'Existing project');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-git', 'project-git', 'worker-origin', '/workspace/git', 'git'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state, branch, head
        ) VALUES (
          'root-git', 'source-git', 'worker-origin', 'Primary', '/workspace/git',
          'git', true, true, 'cantrip', 'ready', 'main', 'abc123'
        );
      `);

      await applyMigrations(database, 95, 95);

      const backfill = await database.query<{
        origin_kind: string;
        root_kind: string;
        source_kind: string;
      }>(`
        SELECT p.origin_kind, s.source_kind, w.root_kind
        FROM projects p
        JOIN project_sources s ON s.project_id = p.id
        JOIN project_worktrees w ON w.project_source_id = s.id
        WHERE p.id = 'project-git'
      `);
      expect(backfill.rows).toEqual([
        {
          origin_kind: "github",
          source_kind: "git",
          root_kind: "git-worktree",
        },
      ]);

      await database.exec(`
        INSERT INTO projects (
          id, owner_id, name, origin_kind, worktree_policy
        ) VALUES (
          'project-folder', 'user-origin', 'Existing project',
          'managed-folder', 'direct'
        );

        INSERT INTO project_sources (
          id, project_id, worker_id, source_kind, absolute_path, display_path
        ) VALUES (
          'source-folder', 'project-folder', 'worker-origin', 'folder',
          '/workspace/folder', 'folder'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, root_kind, name, absolute_path,
          display_path, is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'root-folder', 'source-folder', 'worker-origin', 'folder-root',
          'Folder', '/workspace/folder', 'folder', true, true, 'cantrip', 'ready'
        );
      `);

      await expect(
        database.exec(`
          INSERT INTO projects (
            id, owner_id, name, origin_kind, worktree_policy,
            github_repository_id, github_repository_full_name, github_repository_url
          ) VALUES (
            'invalid-folder', 'user-origin', 'Invalid', 'managed-folder', 'direct',
            'repository-id', 'ArcaneArts/Invalid', 'https://github.com/ArcaneArts/Invalid'
          );
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO project_worktrees (
            id, project_source_id, worker_id, root_kind, name, absolute_path,
            display_path, is_primary, is_default, origin, lifecycle_state
          ) VALUES (
            'invalid-root', 'source-folder', 'worker-origin', 'folder-root',
            'Invalid', '/workspace/invalid', 'invalid', false, false, 'agent', 'ready'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
