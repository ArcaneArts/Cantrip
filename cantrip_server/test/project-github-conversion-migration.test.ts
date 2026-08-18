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

describe("project GitHub conversion migration", () => {
  it("adds durable conversion jobs and backfills the worker capability", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 96);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('conversion-owner', 'anonymous', 'Conversion Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'conversion-worker', 'conversion-owner', 'Conversion Worker',
          'linux', 'x64', now(), now()
        );

        INSERT INTO projects (
          id, owner_id, name, origin_kind, setup_status, worktree_policy,
          preferred_worker_id
        ) VALUES (
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb338', 'conversion-owner',
          'Scratch', 'managed-folder', 'ready', 'direct', 'conversion-worker'
        );

        INSERT INTO project_sources (
          id, project_id, worker_id, source_kind, absolute_path, display_path
        ) VALUES (
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb337',
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb338', 'conversion-worker',
          'folder', '/srv/cantrip/folders/019fe8aa-a7a3-7404-8a96-d3be7f0fb338',
          'folders/019fe8aa-a7a3-7404-8a96-d3be7f0fb338'
        );
      `);

      await applyMigrations(database, 97, 97);

      const workers = await database.query<{
        managed_folder_capabilities: Record<string, boolean>;
      }>(`
        SELECT managed_folder_capabilities FROM workers
        WHERE id = 'conversion-worker'
      `);
      expect(workers.rows[0]?.managed_folder_capabilities).toEqual({
        create: false,
        convertToGithub: false,
        remove: false,
      });

      await database.exec(`
        INSERT INTO project_github_conversion_jobs (
          id, owner_id, project_id, worker_id, repository_id,
          project_source_id, repository_full_name, repository_url,
          confirmation_token, state
        ) VALUES (
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb339', 'conversion-owner',
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb338', 'conversion-worker', '42',
          '019fe8aa-a7a3-7404-8a96-d3be7f0fb337',
          'ArcaneArts/Scratch', 'https://github.com/ArcaneArts/Scratch',
          '${"a".repeat(64)}', 'queued'
        );
      `);
      await expect(
        database.exec(`
          INSERT INTO project_github_conversion_jobs (
            id, owner_id, project_id, worker_id, repository_id,
            project_source_id, repository_full_name, repository_url,
            confirmation_token, state
          ) VALUES (
            '019fe8aa-a7a3-7404-8a96-d3be7f0fb340', 'conversion-owner',
            '019fe8aa-a7a3-7404-8a96-d3be7f0fb338', 'conversion-worker', '43',
            '019fe8aa-a7a3-7404-8a96-d3be7f0fb337',
            'ArcaneArts/Other', 'https://github.com/ArcaneArts/Other',
            '${"b".repeat(64)}', 'running'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
