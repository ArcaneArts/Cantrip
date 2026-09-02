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

describe("project source path uniqueness migration", () => {
  it("preserves legacy rows and rejects new active worker/path conflicts", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 184);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES
          ('worker-1', 'owner-1', 'Worker 1', 'linux', 'x64', now(), now()),
          ('worker-2', 'owner-1', 'Worker 2', 'linux', 'x64', now(), now());

        INSERT INTO projects (
          id, owner_id, protected_label, origin_kind, folder_management,
          worktree_policy, git_capability, github_capability
        ) VALUES
          ('project-1', 'owner-1', '{}'::jsonb, 'managed-folder', 'external',
           'direct', true, false),
          ('project-2', 'owner-1', '{}'::jsonb, 'managed-folder', 'external',
           'direct', true, false),
          ('project-3', 'owner-1', '{}'::jsonb, 'managed-folder', 'external',
           'direct', true, false),
          ('project-4', 'owner-1', '{}'::jsonb, 'managed-folder', 'external',
           'direct', true, false);

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path,
          placement_mode, ownership_kind, requested_path
        ) VALUES
          ('legacy-source-1', 'project-1', 'worker-1', 'protected-path-shared',
           'protected-display-1', 'direct', 'user', 'protected-path-shared'),
          ('legacy-source-2', 'project-2', 'worker-1', 'protected-path-shared',
           'protected-display-2', 'direct', 'user', 'protected-path-shared');
      `);

      await applyMigrations(database, 185, 185);

      expect(
        (
          await database.query<{ count: number }>(`
            SELECT count(*)::integer AS count
            FROM project_sources
            WHERE worker_id = 'worker-1'
              AND absolute_path = 'protected-path-shared'
              AND removed_at IS NULL
          `)
        ).rows,
      ).toEqual([{ count: 2 }]);

      await expect(
        database.exec(`
          INSERT INTO project_sources (
            id, project_id, worker_id, absolute_path, display_path,
            placement_mode, ownership_kind, requested_path
          ) VALUES (
            'conflicting-source', 'project-3', 'worker-1',
            'protected-path-shared', 'protected-display-3',
            'direct', 'user', 'protected-path-shared'
          );
        `),
      ).rejects.toThrow(
        /active project source already owns this worker path/iu,
      );

      await database.exec(`
        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path,
          placement_mode, ownership_kind, requested_path
        ) VALUES
          ('other-worker-source', 'project-3', 'worker-2',
           'protected-path-shared', 'protected-display-3',
           'direct', 'user', 'protected-path-shared'),
          ('unique-source', 'project-4', 'worker-1', 'protected-path-unique',
           'protected-display-4', 'direct', 'user', 'protected-path-unique');
      `);

      await expect(
        database.exec(`
          UPDATE project_sources
          SET absolute_path = 'protected-path-shared',
              requested_path = 'protected-path-shared'
          WHERE id = 'unique-source';
        `),
      ).rejects.toThrow(
        /active project source already owns this worker path/iu,
      );

      await database.exec(`
        UPDATE project_sources
        SET removed_at = now()
        WHERE id IN ('legacy-source-1', 'legacy-source-2');

        UPDATE project_sources
        SET absolute_path = 'protected-path-shared',
            requested_path = 'protected-path-shared'
        WHERE id = 'unique-source';
      `);

      await expect(
        database.exec(`
          UPDATE project_sources
          SET removed_at = NULL
          WHERE id = 'legacy-source-1';
        `),
      ).rejects.toThrow(
        /active project source already owns this worker path/iu,
      );
    } finally {
      await database.close();
    }
  });
});
