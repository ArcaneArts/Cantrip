import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

async function migrationFiles() {
  return (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
}

async function applyMigrations(
  database: PGlite,
  firstIndex: number,
  lastIndex: number,
) {
  for (const migrationFile of await migrationFiles()) {
    const index = Number.parseInt(migrationFile.slice(0, 4), 10);
    if (index < firstIndex || index > lastIndex) continue;
    await database.exec(
      await readFile(`${migrationsDirectory}/${migrationFile}`, "utf8"),
    );
  }
}

describe("project dock presentation migration", () => {
  it("adds constrained durable preferences without changing layout revisions", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 193);
      await database.exec(`
        INSERT INTO users (
          id, kind, role, status, display_name, email, normalized_email,
          password_hash
        ) VALUES (
          'owner-1', 'account', 'owner', 'active', 'Owner',
          'owner@example.com', 'owner@example.com', 'auth-hash'
        );

        INSERT INTO projects (
          id, owner_id, protected_label, position, tab_layout_revision,
          github_repository_blind_index
        ) VALUES (
          'project-1', 'owner-1', '{}'::jsonb, 0, 12,
          'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
        );
      `);

      await applyMigrations(database, 194, 194);

      const project = await database.query<{
        id: string;
        tab_layout_revision: number;
      }>(`
        SELECT id, tab_layout_revision
        FROM projects
        WHERE id = 'project-1'
      `);
      expect(project.rows).toEqual([
        { id: "project-1", tab_layout_revision: 12 },
      ]);

      await database.exec(`
        INSERT INTO project_dock_presentation_preferences (
          project_id, tab_key, region, preferred_mode, split_fraction,
          restore_fraction
        ) VALUES
          ('project-1', 'browser:one', 'right', 'full', 0.34, 0.31),
          ('project-1', 'browser:one', 'bottom', 'closed', 0.28, 0.26);
      `);
      const preferences = await database.query<{
        preferred_mode: string;
        region: string;
        restore_fraction: number;
        split_fraction: number;
        tab_key: string;
      }>(`
        SELECT tab_key, region, preferred_mode, split_fraction,
          restore_fraction
        FROM project_dock_presentation_preferences
        WHERE project_id = 'project-1'
        ORDER BY region
      `);
      expect(preferences.rows).toEqual([
        {
          preferred_mode: "closed",
          region: "bottom",
          restore_fraction: 0.26,
          split_fraction: 0.28,
          tab_key: "browser:one",
        },
        {
          preferred_mode: "full",
          region: "right",
          restore_fraction: 0.31,
          split_fraction: 0.34,
          tab_key: "browser:one",
        },
      ]);

      await expect(
        database.exec(`
          INSERT INTO project_dock_presentation_preferences (
            project_id, tab_key, region, preferred_mode, split_fraction,
            restore_fraction
          ) VALUES ('project-1', 'browser:center', 'center', 'split', 0.3, 0.3)
        `),
      ).rejects.toThrow();
      await expect(
        database.exec(`
          INSERT INTO project_dock_presentation_preferences (
            project_id, tab_key, region, preferred_mode, split_fraction,
            restore_fraction
          ) VALUES ('project-1', 'browser:edge', 'right', 'split', 0.01, 0.3)
        `),
      ).rejects.toThrow();

      await database.exec(`DELETE FROM projects WHERE id = 'project-1'`);
      const afterProjectDelete = await database.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
        FROM project_dock_presentation_preferences
      `);
      expect(afterProjectDelete.rows).toEqual([{ count: 0 }]);
    } finally {
      await database.close();
    }
  });
});
