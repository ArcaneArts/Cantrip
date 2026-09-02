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

describe("project workspace migration", () => {
  it("creates one Default workspace per owner and preserves project visibility", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 38);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES
          ('user-1', 'anonymous', 'Local User'),
          ('user-2', 'anonymous', 'Other User');

        INSERT INTO projects (id, owner_id, name, position)
        VALUES
          ('project-1', 'user-1', 'Cantrip', 0),
          ('project-2', 'user-1', 'Iris', 1),
          ('project-3', 'user-2', 'CareMap', 0);
      `);

      await applyMigrations(database, 39, 39);

      const workspaces = await database.query<{
        id: string;
        is_default: boolean;
        name: string;
        owner_id: string;
        position: number;
      }>(`
        SELECT id, owner_id, name, position, is_default
        FROM project_workspaces
        ORDER BY owner_id
      `);
      expect(workspaces.rows).toEqual([
        {
          id: "workspace:default:user-1",
          owner_id: "user-1",
          name: "Default",
          position: 0,
          is_default: true,
        },
        {
          id: "workspace:default:user-2",
          owner_id: "user-2",
          name: "Default",
          position: 0,
          is_default: true,
        },
      ]);

      const memberships = await database.query<{
        project_id: string;
        workspace_id: string;
      }>(`
        SELECT workspace_id, project_id
        FROM project_workspace_memberships
        ORDER BY project_id
      `);
      expect(memberships.rows).toEqual([
        {
          workspace_id: "workspace:default:user-1",
          project_id: "project-1",
        },
        {
          workspace_id: "workspace:default:user-1",
          project_id: "project-2",
        },
        {
          workspace_id: "workspace:default:user-2",
          project_id: "project-3",
        },
      ]);

      await expect(
        database.exec(`
          INSERT INTO project_workspaces (
            id, owner_id, name, position, is_default
          ) VALUES ('second-default', 'user-1', 'Other', 1, true);
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  it("reduces legacy memberships to one immutable workspace per project", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 38);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('user-1', 'anonymous', 'Local User');

        INSERT INTO projects (id, owner_id, name, position)
        VALUES
          ('project-default', 'user-1', 'Default project', 0),
          ('project-custom', 'user-1', 'Custom project', 1),
          ('project-unassigned', 'user-1', 'Unassigned project', 2);
      `);
      await applyMigrations(database, 39, 39);
      await database.exec(`
        INSERT INTO project_workspaces (
          id, owner_id, name, position, is_default
        ) VALUES
          ('workspace-custom-a', 'user-1', 'Custom A', 1, false),
          ('workspace-custom-b', 'user-1', 'Custom B', 2, false);

        INSERT INTO project_workspace_memberships (workspace_id, project_id)
        VALUES
          ('workspace-custom-a', 'project-custom'),
          ('workspace-custom-b', 'project-custom');

        DELETE FROM project_workspace_memberships
        WHERE project_id = 'project-unassigned';
      `);

      await applyMigrations(database, 179, 179);

      const memberships = await database.query<{
        project_id: string;
        workspace_id: string;
      }>(`
        SELECT workspace_id, project_id
        FROM project_workspace_memberships
        ORDER BY project_id
      `);
      expect(memberships.rows).toEqual([
        {
          workspace_id: "workspace-custom-a",
          project_id: "project-custom",
        },
        {
          workspace_id: "workspace:default:user-1",
          project_id: "project-default",
        },
        {
          workspace_id: "workspace:default:user-1",
          project_id: "project-unassigned",
        },
      ]);

      await expect(
        database.exec(`
          INSERT INTO project_workspace_memberships (workspace_id, project_id)
          VALUES ('workspace-custom-b', 'project-custom');
        `),
      ).rejects.toThrow();
      await expect(
        database.exec(`
          DELETE FROM project_workspaces WHERE id = 'workspace-custom-a';
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
