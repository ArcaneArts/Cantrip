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

describe("Explorer view-state migration", () => {
  it("backfills a browser surface and persists its selected editor state", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 68);
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
          'source-1', 'project-1', 'worker-1', '/workspace/Cantrip', 'Cantrip'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Primary',
          '/workspace/Cantrip', 'Cantrip', true, true, 'cantrip', 'ready'
        );

        INSERT INTO explorers (
          id, project_id, title, active_worker_id, worktree_id
        ) VALUES (
          'explorer-1', 'project-1', 'Explorer', 'worker-1', 'worktree-1'
        );
      `);

      await applyMigrations(database, 69, 69);

      expect(
        (
          await database.query<{
            selected_path: string | null;
            file_mode: string;
          }>(`
            SELECT selected_path, file_mode
            FROM explorers
            WHERE id = 'explorer-1'
          `)
        ).rows,
      ).toEqual([{ selected_path: null, file_mode: "preview" }]);

      await database.exec(`
        UPDATE explorers
        SET selected_path = 'src/App.tsx', file_mode = 'edit'
        WHERE id = 'explorer-1';
      `);
      expect(
        (
          await database.query<{
            selected_path: string | null;
            file_mode: string;
          }>(`
            SELECT selected_path, file_mode
            FROM explorers
            WHERE id = 'explorer-1'
          `)
        ).rows,
      ).toEqual([{ selected_path: "src/App.tsx", file_mode: "edit" }]);
    } finally {
      await database.close();
    }
  });
});
