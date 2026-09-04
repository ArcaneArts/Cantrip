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

async function reapplyCanonicalization(database: PGlite) {
  const migrationFile = (await migrationFiles()).find((name) =>
    name.startsWith("0192_"),
  );
  expect(migrationFile).toBeDefined();
  const statements = (
    await readFile(`${migrationsDirectory}/${migrationFile!}`, "utf8")
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const firstDataStatement = statements.findIndex((statement) =>
    statement.startsWith('WITH "ranked_legacy_views"'),
  );
  const lastDataStatement = statements.findIndex((statement) =>
    statement.startsWith('DROP TABLE "_builtin_surface_member_migration"'),
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
  const [project, views, states, surfaces, groups, members] = await Promise.all(
    [
      database.query<{ tab_layout_revision: number }>(`
        SELECT tab_layout_revision
        FROM projects
        WHERE id = 'project-1'
      `),
      database.query<{ id: string; kind: string }>(`
        SELECT id, kind FROM project_views ORDER BY id
      `),
      database.query<{
        definition_id: string;
        project_id: string;
        worktree_id: string | null;
      }>(`
        SELECT project_id, definition_id, worktree_id
        FROM project_builtin_surface_states
        ORDER BY definition_id
      `),
      database.query<{ id: string; kind: string }>(`
        SELECT id, kind FROM remote_surfaces ORDER BY id
      `),
      database.query<{
        anchor_tab_key: string;
        id: string;
        position: number;
        protected_label: unknown | null;
      }>(`
        SELECT id, position, anchor_tab_key, protected_label
        FROM tab_groups
        WHERE project_id = 'project-1'
        ORDER BY position
      `),
      database.query<{
        group_id: string;
        position: number;
        tab_id: string;
        tab_key: string;
        tab_kind: string;
      }>(`
        SELECT group_id, tab_key, tab_kind, tab_id, position
        FROM tab_group_members
        WHERE project_id = 'project-1'
        ORDER BY group_id, position
      `),
    ],
  );
  return {
    revision: project.rows[0]?.tab_layout_revision,
    views: views.rows,
    states: states.rows,
    surfaces: surfaces.rows,
    groups: groups.rows,
    members: members.rows,
  };
}

describe("built-in singleton surface migration", () => {
  it("canonicalizes legacy History and Issues idempotently while preserving unrelated surfaces", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 191);
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
        ) VALUES (
          'project-1', 'owner-1', '{}'::jsonb, 0, 41,
          'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
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
          'chat-1', 'owner-1', 'project-1', '{}'::jsonb, 'agent',
          'worker-1', 'worktree-1'
        );

        INSERT INTO project_views (
          id, project_id, protected_label, kind, worktree_id, position
        ) VALUES
          ('history-canonical', 'project-1', '{}'::jsonb, 'history', 'worktree-1', 0),
          ('history-duplicate', 'project-1', '{}'::jsonb, 'history', NULL, 1),
          ('issues-canonical', 'project-1', '{}'::jsonb, 'issues', 'worktree-1', 2),
          ('desktop-1', 'project-1', '{}'::jsonb, 'remote-desktop', 'worktree-1', 3);

        INSERT INTO remote_surfaces (
          id, project_id, worker_id, kind, configuration,
          protected_state, state_revision
        ) VALUES (
          'desktop-1', 'project-1', 'worker-1', 'desktop',
          '{"kind":"desktop"}'::jsonb, '{}'::jsonb, 1
        );

        INSERT INTO tab_groups (
          id, project_id, protected_label, position, anchor_tab_key
        ) VALUES
          ('group-history', 'project-1', '{}'::jsonb, 0, 'view:history-canonical'),
          ('group-duplicate', 'project-1', '{}'::jsonb, 1, 'view:history-duplicate'),
          ('group-issues', 'project-1', '{}'::jsonb, 2, 'view:issues-canonical');

        INSERT INTO tab_group_members (
          tab_key, group_id, project_id, tab_kind, tab_id, position
        ) VALUES
          ('view:history-canonical', 'group-history', 'project-1', 'history', 'history-canonical', 0),
          ('view:desktop-1', 'group-history', 'project-1', 'remote-desktop', 'desktop-1', 1),
          ('view:history-duplicate', 'group-duplicate', 'project-1', 'history', 'history-duplicate', 0),
          ('chat:chat-1', 'group-duplicate', 'project-1', 'chat', 'chat-1', 1),
          ('view:issues-canonical', 'group-issues', 'project-1', 'issues', 'issues-canonical', 0);
      `);

      await applyMigrations(database, 192, 192);
      const first = await migratedState(database);
      expect(first).toEqual({
        revision: 42,
        views: [{ id: "desktop-1", kind: "remote-desktop" }],
        states: [
          {
            project_id: "project-1",
            definition_id: "git.history",
            worktree_id: "worktree-1",
          },
          {
            project_id: "project-1",
            definition_id: "github.issues",
            worktree_id: "worktree-1",
          },
        ],
        surfaces: [{ id: "desktop-1", kind: "desktop" }],
        groups: [
          {
            id: "group-history",
            position: 0,
            anchor_tab_key: "builtin:project-1:git.history",
            protected_label: {},
          },
          {
            id: "group-duplicate",
            position: 1,
            anchor_tab_key: "chat:chat-1",
            protected_label: null,
          },
          {
            id: "group-issues",
            position: 2,
            anchor_tab_key: "builtin:project-1:github.issues",
            protected_label: null,
          },
        ],
        members: [
          {
            group_id: "group-duplicate",
            tab_key: "chat:chat-1",
            tab_kind: "chat",
            tab_id: "chat-1",
            position: 0,
          },
          {
            group_id: "group-history",
            tab_key: "builtin:project-1:git.history",
            tab_kind: "builtin",
            tab_id: "git.history",
            position: 0,
          },
          {
            group_id: "group-history",
            tab_key: "view:desktop-1",
            tab_kind: "remote-desktop",
            tab_id: "desktop-1",
            position: 1,
          },
          {
            group_id: "group-issues",
            tab_key: "builtin:project-1:github.issues",
            tab_kind: "builtin",
            tab_id: "github.issues",
            position: 0,
          },
        ],
      });

      await reapplyCanonicalization(database);
      expect(await migratedState(database)).toEqual(first);

      await database.exec(`
        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state
        ) VALUES (
          'worktree-removable', 'source-1', 'worker-1', 'Removable',
          '/workspace/Cantrip-removable', 'Cantrip-removable', FALSE, FALSE,
          'agent', 'ready'
        );

        UPDATE project_builtin_surface_states
        SET worktree_id = 'worktree-removable'
        WHERE project_id = 'project-1' AND definition_id = 'git.history';

        DELETE FROM project_worktrees WHERE id = 'worktree-removable';
      `);
      const clearedState = await database.query<{
        worktree_id: string | null;
      }>(`
        SELECT worktree_id
        FROM project_builtin_surface_states
        WHERE project_id = 'project-1' AND definition_id = 'git.history'
      `);
      expect(clearedState.rows).toEqual([{ worktree_id: null }]);
    } finally {
      await database.close();
    }
  });
});
