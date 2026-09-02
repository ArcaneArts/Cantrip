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

describe("external Git conversion capability default migration", () => {
  it("updates new worker defaults without rewriting existing reports", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 185);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-before', 'owner-1', 'Before', 'linux', 'x64', now(), now()
        );
      `);

      const before = await database.query<{
        managed_folder_capabilities: Record<string, boolean>;
      }>(`
        SELECT managed_folder_capabilities
        FROM workers
        WHERE id = 'worker-before'
      `);
      expect(
        before.rows[0]?.managed_folder_capabilities.convertExternalGitToGithub,
      ).toBeUndefined();

      await applyMigrations(database, 186, 186);
      await database.exec(`
        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-after', 'owner-1', 'After', 'linux', 'x64', now(), now()
        );
      `);

      const workers = await database.query<{
        id: string;
        managed_folder_capabilities: Record<string, boolean>;
      }>(`
        SELECT id, managed_folder_capabilities
        FROM workers
        ORDER BY id
      `);
      expect(workers.rows).toEqual([
        {
          id: "worker-after",
          managed_folder_capabilities: {
            attachExisting: false,
            attachWorkspaceRoot: false,
            convertExternalGitToGithub: false,
            convertToGithub: false,
            create: false,
            discoverWorkspaceRepositories: false,
            remove: false,
            workspaceScopedRoots: false,
          },
        },
        {
          id: "worker-before",
          managed_folder_capabilities:
            before.rows[0]!.managed_folder_capabilities,
        },
      ]);
    } finally {
      await database.close();
    }
  });
});
