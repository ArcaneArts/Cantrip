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

describe("workspace binding immutability migration", () => {
  it("rejects reassignment while preserving project and workspace cascades", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 186);
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
        ) VALUES (
          'project-1', 'owner-1', '{}'::jsonb, 'managed-folder', 'external',
          'direct', true, false
        );

        INSERT INTO project_workspaces (
          id, owner_id, name_envelope, name_blind_index,
          name_format_version, name_key_revision, position, is_default
        ) VALUES
          ('workspace-attached', 'owner-1', '{}'::jsonb,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 1, 0, false),
          ('workspace-managed', 'owner-1', '{}'::jsonb,
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 1, 1, false);

        INSERT INTO project_workspace_storage_profiles (
          workspace_id, kind, worker_id,
          protected_root_path_handle, protected_display_handle
        ) VALUES
          ('workspace-attached', 'attached', 'worker-1',
           'ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'ctrr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
          ('workspace-managed', 'managed', NULL, NULL, NULL);

        INSERT INTO project_workspace_memberships (workspace_id, project_id)
        VALUES ('workspace-attached', 'project-1');
      `);

      await applyMigrations(database, 187, 187);

      await expect(
        database.exec(`
          UPDATE project_workspace_memberships
          SET workspace_id = 'workspace-managed'
          WHERE project_id = 'project-1';
        `),
      ).rejects.toThrow(/project workspace membership is immutable/iu);
      await expect(
        database.exec(`
          DELETE FROM project_workspace_memberships
          WHERE project_id = 'project-1';
        `),
      ).rejects.toThrow(/cannot be removed while the project exists/iu);

      await expect(
        database.exec(`
          UPDATE project_workspace_storage_profiles
          SET worker_id = 'worker-2',
              protected_root_path_handle =
                'ctrr_ccccccccccccccccccccccccccccccccccccccccccc',
              protected_display_handle =
                'ctrr_ddddddddddddddddddddddddddddddddddddddddddd'
          WHERE workspace_id = 'workspace-attached';
        `),
      ).rejects.toThrow(/workspace storage identity is immutable/iu);
      await expect(
        database.exec(`
          DELETE FROM project_workspace_storage_profiles
          WHERE workspace_id = 'workspace-attached';
        `),
      ).rejects.toThrow(/cannot be removed while the workspace exists/iu);

      await database.exec(`
        UPDATE project_workspace_storage_profiles
        SET revision = revision + 1,
            updated_at = now()
        WHERE workspace_id = 'workspace-attached';

        DELETE FROM projects WHERE id = 'project-1';
        DELETE FROM project_workspaces WHERE id = 'workspace-attached';
      `);

      const remaining = await database.query<{
        memberships: number;
        profiles: number;
      }>(`
        SELECT
          (SELECT count(*)::integer
           FROM project_workspace_memberships) AS memberships,
          (SELECT count(*)::integer
           FROM project_workspace_storage_profiles
           WHERE workspace_id = 'workspace-attached') AS profiles
      `);
      expect(remaining.rows).toEqual([{ memberships: 0, profiles: 0 }]);
    } finally {
      await database.close();
    }
  });

  it("allows account deletion to cascade through nonempty workspaces", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 187);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-2', 'anonymous', 'Owner');

        INSERT INTO projects (
          id, owner_id, protected_label, origin_kind, folder_management,
          worktree_policy, git_capability, github_capability
        ) VALUES (
          'project-2', 'owner-2', '{}'::jsonb, 'managed-folder', 'external',
          'direct', true, false
        );

        INSERT INTO project_workspaces (
          id, owner_id, name_envelope, name_blind_index,
          name_format_version, name_key_revision, position, is_default
        ) VALUES (
          'workspace-2', 'owner-2', '{}'::jsonb,
          'ccccccccccccccccccccccccccccccccccccccccccc', 1, 1, 0, false
        );

        INSERT INTO project_workspace_storage_profiles (workspace_id, kind)
        VALUES ('workspace-2', 'managed');

        INSERT INTO project_workspace_memberships (workspace_id, project_id)
        VALUES ('workspace-2', 'project-2');

        DELETE FROM users WHERE id = 'owner-2';
      `);

      const remaining = await database.query<{ count: number }>(`
        SELECT (
          (SELECT count(*) FROM projects WHERE owner_id = 'owner-2') +
          (SELECT count(*) FROM project_workspaces WHERE owner_id = 'owner-2') +
          (SELECT count(*) FROM project_workspace_memberships) +
          (SELECT count(*) FROM project_workspace_storage_profiles)
        )::integer AS count
      `);
      expect(remaining.rows).toEqual([{ count: 0 }]);
    } finally {
      await database.close();
    }
  });
});
