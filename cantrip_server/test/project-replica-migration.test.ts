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

describe("project replica persistence migration", () => {
  it("preserves the legacy source and permits one replica per worker", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 52);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-1', 'anonymous', 'Local User');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES
          ('worker-1', 'user-1', 'Desk Mac', 'darwin', 'arm64', now(), now()),
          ('worker-2', 'user-1', 'Build Host', 'linux', 'x64', now(), now());

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-1', 'user-1', 'Cantrip');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path,
          repository_fingerprint
        ) VALUES (
          'source-1', 'project-1', 'worker-1', '/workspace/Cantrip',
          'ArcaneArts/Cantrip', 'legacy-fingerprint'
        );
      `);

      await applyMigrations(database, 53, 53);
      await database.exec(`
        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-2', 'project-1', 'worker-2', '/srv/Cantrip',
          'BuildHost/ArcaneArts/Cantrip'
        );
      `);

      const replicas = await database.query<{
        id: string;
        repository_fingerprint: string | null;
        worker_id: string;
      }>(`
        SELECT id, worker_id, repository_fingerprint
        FROM project_sources
        WHERE project_id = 'project-1'
        ORDER BY id
      `);
      expect(replicas.rows).toEqual([
        {
          id: "source-1",
          worker_id: "worker-1",
          repository_fingerprint: "legacy-fingerprint",
        },
        {
          id: "source-2",
          worker_id: "worker-2",
          repository_fingerprint: null,
        },
      ]);

      await expect(
        database.exec(`
          INSERT INTO project_sources (
            id, project_id, worker_id, absolute_path, display_path
          ) VALUES (
            'source-duplicate', 'project-1', 'worker-2', '/tmp/duplicate',
            'duplicate'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
