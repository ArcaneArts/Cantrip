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

async function reapplyDetachedPaneBackfill(database: PGlite) {
  const migrationFile = (await migrationFiles()).find((name) =>
    name.startsWith("0196_"),
  );
  expect(migrationFile).toBeDefined();
  const statements = (
    await readFile(`${migrationsDirectory}/${migrationFile!}`, "utf8")
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const firstDataStatement = statements.findIndex((statement) =>
    statement.startsWith(
      'CREATE TEMP TABLE "_detached_pane_migration_projects" AS',
    ),
  );
  const lastDataStatement = statements.findIndex((statement) =>
    statement.startsWith('DROP TABLE "_detached_pane_migration_projects"'),
  );
  expect(firstDataStatement).toBeGreaterThan(-1);
  expect(lastDataStatement).toBeGreaterThan(firstDataStatement);
  for (const statement of statements.slice(
    firstDataStatement,
    lastDataStatement + 1,
  )) {
    await database.exec(statement);
  }
}

async function migratedState(database: PGlite) {
  const [settings, project, panes, members] = await Promise.all([
    database.query<{ workspace_layout_profile: string }>(`
      SELECT workspace_layout_profile
      FROM user_settings
      WHERE user_id = 'owner-1'
    `),
    database.query<{
      center_layout_root: unknown;
      tab_layout_revision: number;
    }>(`
      SELECT center_layout_root, tab_layout_revision
      FROM projects
      WHERE id = 'project-1'
    `),
    database.query<{ id: string; position: number; region: string }>(`
      SELECT id, position, region
      FROM tab_groups
      WHERE project_id = 'project-1'
      ORDER BY position, id
    `),
    database.query<{ group_id: string; tab_key: string }>(`
      SELECT group_id, tab_key
      FROM tab_group_members
      WHERE project_id = 'project-1'
      ORDER BY tab_key
    `),
  ]);
  return {
    members: members.rows,
    panes: panes.rows,
    project: project.rows[0],
    settings: settings.rows[0],
  };
}

describe("workspace layout profile migration", () => {
  it("defaults existing users and recovers durable detached panes idempotently", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 195);
      await database.exec(`
        INSERT INTO users (
          id, kind, role, status, display_name, email, normalized_email,
          password_hash
        ) VALUES (
          'owner-1', 'account', 'owner', 'active', 'Owner',
          'owner@example.com', 'owner@example.com', 'auth-hash'
        );

        INSERT INTO user_settings (user_id) VALUES ('owner-1');

        INSERT INTO projects (
          id, owner_id, protected_label, position, tab_layout_revision,
          center_layout_root, github_repository_blind_index
        ) VALUES (
          'project-1', 'owner-1', '{}'::jsonb, 0, 10,
          '{"kind":"pane","paneId":"center-pane"}'::jsonb,
          'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
        );

        INSERT INTO tab_groups (
          id, project_id, region, position, anchor_tab_key
        ) VALUES
          ('center-pane', 'project-1', 'center', 0, 'chat:center'),
          ('legacy-detached-pane', 'project-1', 'detached', 8, 'browser:legacy');

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          ('chat:center', 'center-pane', 'project-1', 'chat', 'center', 0),
          (
            'browser:legacy', 'legacy-detached-pane', 'project-1',
            'browser', 'legacy', 0
          );
      `);

      await applyMigrations(database, 196, 196);
      const first = await migratedState(database);
      expect(first).toEqual({
        members: [
          { group_id: "legacy-detached-pane", tab_key: "browser:legacy" },
          { group_id: "center-pane", tab_key: "chat:center" },
        ],
        panes: [
          { id: "center-pane", position: 0, region: "center" },
          {
            id: "legacy-detached-pane",
            position: 1,
            region: "center",
          },
        ],
        project: {
          center_layout_root: {
            direction: "horizontal",
            first: { kind: "pane", paneId: "center-pane" },
            fraction: 0.5,
            id: "migration:center:project-1:1",
            kind: "split",
            second: { kind: "pane", paneId: "legacy-detached-pane" },
          },
          tab_layout_revision: 11,
        },
        settings: { workspace_layout_profile: "hybrid" },
      });

      await reapplyDetachedPaneBackfill(database);
      expect(await migratedState(database)).toEqual(first);

      await database.exec(`
        UPDATE user_settings
        SET workspace_layout_profile = 'ide'
        WHERE user_id = 'owner-1'
      `);
      await expect(
        database.exec(`
          UPDATE user_settings
          SET workspace_layout_profile = 'floating'
          WHERE user_id = 'owner-1'
        `),
      ).rejects.toThrow(/user_settings_workspace_layout_profile_check/u);
      await expect(
        database.exec(`
          INSERT INTO tab_groups (
            id, project_id, region, position, anchor_tab_key
          ) VALUES (
            'invalid-detached-pane', 'project-1', 'detached', 2, 'chat:center'
          )
        `),
      ).rejects.toThrow(/tab_groups_region_check/u);
    } finally {
      await database.close();
    }
  });
});
