import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.js";
import { attachProjectTab } from "../src/db/tab-layouts.js";

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

async function reapplyPaneRegionBackfill(database: PGlite) {
  const migrationFile = (await migrationFiles()).find((name) =>
    name.startsWith("0193_"),
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
      'CREATE TEMP TABLE "_pane_region_migration_projects" AS',
    ),
  );
  const lastDataStatement = statements.findIndex((statement) =>
    statement.startsWith('DROP TABLE "_pane_region_migration_projects"'),
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

async function legacyTopology(database: PGlite) {
  const [projects, groups, members, resources] = await Promise.all([
    database.query<{ id: string; tab_layout_revision: number }>(`
      SELECT id, tab_layout_revision
      FROM projects
      WHERE id IN ('project-1', 'project-empty')
      ORDER BY id
    `),
    database.query<{
      anchor_tab_key: string;
      id: string;
      position: number;
      project_id: string;
      protected_label: unknown | null;
    }>(`
      SELECT id, project_id, position, anchor_tab_key, protected_label
      FROM tab_groups
      WHERE project_id = 'project-1'
      ORDER BY position, id
    `),
    database.query<{
      group_id: string;
      position: number;
      project_id: string;
      tab_id: string;
      tab_key: string;
      tab_kind: string;
    }>(`
      SELECT tab_key, group_id, project_id, tab_kind, tab_id, position
      FROM tab_group_members
      WHERE project_id = 'project-1'
      ORDER BY group_id, position, tab_key
    `),
    database.query<{ id: string; resource_kind: string }>(`
      SELECT id, resource_kind
      FROM (
        SELECT id, 'browser' AS resource_kind FROM browsers
        UNION ALL
        SELECT id, 'chat' AS resource_kind FROM chats
        UNION ALL
        SELECT id, 'explorer' AS resource_kind FROM explorers
        UNION ALL
        SELECT id, 'terminal' AS resource_kind FROM terminals
      ) AS resources
      ORDER BY resource_kind, id
    `),
  ]);
  return {
    groups: groups.rows,
    members: members.rows,
    projects: projects.rows,
    resources: resources.rows,
  };
}

async function migratedState(database: PGlite) {
  const topology = await legacyTopology(database);
  const regions = await database.query<{ id: string; region: string }>(`
    SELECT id, region
    FROM tab_groups
    WHERE project_id = 'project-1'
    ORDER BY position, id
  `);
  return { ...topology, regions: regions.rows };
}

describe("project pane region migration", () => {
  it("preserves legacy panes and resources while backfilling center idempotently", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 192);
      await database.exec(`
        INSERT INTO users (
          id, kind, role, status, display_name, email, normalized_email,
          password_hash
        ) VALUES (
          'owner-1', 'account', 'owner', 'active', 'Owner',
          'owner@example.com', 'owner@example.com', 'auth-hash'
        );

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', NOW(), NOW()
        );

        INSERT INTO projects (
          id, owner_id, protected_label, position, tab_layout_revision,
          github_repository_blind_index
        ) VALUES
          (
            'project-1', 'owner-1', '{}'::jsonb, 0, 41,
            'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
          ),
          (
            'project-empty', 'owner-1', '{}'::jsonb, 1, 17,
            'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
          );

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
          '/workspace/Cantrip', 'Cantrip', TRUE, TRUE, 'cantrip', 'ready'
        );

        INSERT INTO chats (
          id, owner_id, project_id, protected_label, experience,
          active_worker_id, active_worktree_id
        ) VALUES (
          'chat-1', 'owner-1', 'project-1', '{"resource":"chat"}'::jsonb,
          'agent', 'worker-1', 'worktree-1'
        );

        INSERT INTO terminals (
          id, project_id, protected_label, protected_state,
          active_worker_id, worktree_id
        ) VALUES (
          'terminal-1', 'project-1', '{"resource":"terminal"}'::jsonb,
          '{}'::jsonb, 'worker-1', 'worktree-1'
        );

        INSERT INTO explorers (
          id, project_id, protected_label, protected_state, file_mode,
          active_worker_id, worktree_id
        ) VALUES (
          'explorer-1', 'project-1', '{"resource":"explorer"}'::jsonb,
          '{"opaque":"selected-path"}'::jsonb, 'edit',
          'worker-1', 'worktree-1'
        );

        INSERT INTO browsers (
          id, project_id, protected_label, protected_state
        ) VALUES (
          'browser-1', 'project-1', '{"resource":"browser"}'::jsonb,
          '{}'::jsonb
        );

        INSERT INTO project_builtin_surface_states (
          project_id, definition_id, worktree_id
        ) VALUES ('project-1', 'project.overview', NULL);

        INSERT INTO tab_groups (
          id, project_id, protected_label, position, anchor_tab_key
        ) VALUES
          (
            'legacy-file-pane', 'project-1', '{"pane":"file"}'::jsonb, 2,
            'explorer:explorer-1'
          ),
          (
            'legacy-mixed-pane', 'project-1', '{"pane":"mixed"}'::jsonb, 8,
            'chat:chat-1'
          );

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          (
            'explorer:explorer-1', 'legacy-file-pane', 'project-1',
            'explorer', 'explorer-1', 0
          ),
          (
            'terminal:terminal-1', 'legacy-file-pane', 'project-1',
            'terminal', 'terminal-1', 4
          ),
          (
            'chat:chat-1', 'legacy-mixed-pane', 'project-1',
            'chat', 'chat-1', 1
          ),
          (
            'browser:browser-1', 'legacy-mixed-pane', 'project-1',
            'browser', 'browser-1', 3
          ),
          (
            'builtin:project-1:project.overview', 'legacy-mixed-pane',
            'project-1', 'builtin', 'project.overview', 7
          );
      `);

      const before = await legacyTopology(database);
      expect(before.projects).toEqual([
        { id: "project-1", tab_layout_revision: 41 },
        { id: "project-empty", tab_layout_revision: 17 },
      ]);

      await applyMigrations(database, 193, 193);
      const first = await migratedState(database);
      expect(first.groups).toEqual(before.groups);
      expect(first.members).toEqual(before.members);
      expect(first.resources).toEqual(before.resources);
      expect(first.regions).toEqual([
        { id: "legacy-file-pane", region: "center" },
        { id: "legacy-mixed-pane", region: "center" },
      ]);
      expect(first.projects).toEqual([
        { id: "project-1", tab_layout_revision: 42 },
        { id: "project-empty", tab_layout_revision: 17 },
      ]);

      await expect(
        database.exec(`
          INSERT INTO tab_groups (
            id, project_id, region, position, anchor_tab_key
          ) VALUES (
            'invalid-region-pane', 'project-1', 'floating', 9, 'chat:chat-1'
          )
        `),
      ).rejects.toThrow(/tab_groups_region_check/u);

      await reapplyPaneRegionBackfill(database);
      expect(await migratedState(database)).toEqual(first);

      await attachProjectTab(drizzle(database, { schema }), {
        projectId: "project-1",
        paneId: "legacy-file-pane",
        tabId: "terminal-appended",
        tabKind: "terminal",
      });
      const appendedMembers = await database.query<{
        position: number;
        tab_key: string;
      }>(`
        SELECT tab_key, position
        FROM tab_group_members
        WHERE group_id = 'legacy-file-pane'
        ORDER BY position, tab_key
      `);
      expect(appendedMembers.rows).toEqual([
        { position: 0, tab_key: "explorer:explorer-1" },
        { position: 4, tab_key: "terminal:terminal-1" },
        { position: 5, tab_key: "terminal:terminal-appended" },
      ]);
    } finally {
      await database.close();
    }
  });
});
