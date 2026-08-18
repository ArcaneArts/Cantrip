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

describe("project folder setup persistence migration", () => {
  it("backfills unavailable worker capability and persists one setup job per project", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 95);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('folder-owner', 'anonymous', 'Folder Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'folder-worker', 'folder-owner', 'Folder Worker', 'linux', 'x64', now(), now()
        );

        INSERT INTO projects (
          id, owner_id, name, origin_kind, setup_status, worktree_policy,
          preferred_worker_id
        ) VALUES (
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb338', 'folder-owner', 'Scratch',
          'managed-folder', 'preparing', 'direct', 'folder-worker'
        );
      `);
      await applyMigrations(database, 96, 96);

      const workers = await database.query<{
        managed_folder_capabilities: { create: boolean; remove: boolean };
      }>(`
        SELECT managed_folder_capabilities FROM workers
        WHERE id = 'folder-worker'
      `);
      expect(workers.rows[0]?.managed_folder_capabilities).toEqual({
        create: false,
        remove: false,
      });

      await database.exec(`
        INSERT INTO project_folder_setup_jobs (
          id, owner_id, project_id, worker_id, state
        ) VALUES (
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb339', 'folder-owner',
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb338', 'folder-worker', 'queued'
        );
      `);
      await expect(
        database.exec(`
          INSERT INTO project_folder_setup_jobs (
            id, owner_id, project_id, worker_id, state
          ) VALUES (
            '019fe8aa-a7a3-7404-8a96-d3be7f0fb340', 'folder-owner',
            '019fe8aa-a7a3-7404-8a96-d3be7f0fb338', 'folder-worker', 'queued'
          );
        `),
      ).rejects.toThrow();
      await expect(
        database.exec(`
          UPDATE project_folder_setup_jobs
          SET state = 'unknown'
          WHERE id = '019fe8aa-a7a3-7404-8a96-d3be7f0fb339';
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
