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

describe("project display-label reset migration", () => {
  it("deletes only the project domain and preserves account encryption custody", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 104);
      await database.exec(`
        INSERT INTO users (
          id, kind, role, status, display_name, email, normalized_email,
          password_hash
        ) VALUES (
          'owner-1', 'account', 'owner', 'active', 'Owner',
          'owner@example.com', 'owner@example.com', 'auth-hash'
        );

        INSERT INTO user_sessions (
          id, user_id, token_hash, csrf_token_hash, auth_method, expires_at
        ) VALUES (
          'session-1', 'owner-1', 'token-hash', 'csrf-hash', 'password',
          NOW() + INTERVAL '1 day'
        );

        INSERT INTO account_encryption_profiles (
          owner_id, format_version, active_master_key_revision,
          initialization_status, payload_migration_status
        ) VALUES ('owner-1', 1, 1, 'initialized', 'complete');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture,
          chat_relocation_capability, external_codex_history_capability,
          started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64',
          false, false, NOW(), NOW()
        );

        INSERT INTO worker_credentials (
          id, owner_id, worker_id, secret_hash
        ) VALUES ('credential-1', 'owner-1', 'worker-1', 'credential-hash');

        INSERT INTO encryption_principals (
          id, owner_id, kind, worker_id, label, public_key, state,
          approved_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'owner-1', 'worker',
          'worker-1', 'Worker encryption', '{}'::jsonb, 'approved', NOW()
        );

        INSERT INTO encryption_key_grants (
          id, owner_id, principal_id, component, key_revision, wrapped_key
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', 'owner-1',
          '11111111-1111-4111-8111-111111111111',
          'private-surface-metadata', 1, '{}'::jsonb
        );

        INSERT INTO user_settings (
          user_id, high_contrast, pro_mode,
          automatic_replica_provisioning
        ) VALUES ('owner-1', FALSE, FALSE, FALSE);

        INSERT INTO project_workspaces (
          id, owner_id, name, position, is_default
        ) VALUES ('workspace-1', 'owner-1', 'Workspace Keep', 0, TRUE);

        INSERT INTO projects (id, owner_id, name, position)
        VALUES ('project-1', 'owner-1', 'Sentinel Project Name', 0);

        INSERT INTO project_workspace_memberships (workspace_id, project_id)
        VALUES ('workspace-1', 'project-1');
      `);

      await applyMigrations(database, 105, 105);

      for (const table of [
        "users",
        "user_sessions",
        "account_encryption_profiles",
        "workers",
        "worker_credentials",
        "encryption_principals",
        "encryption_key_grants",
        "user_settings",
        "project_workspaces",
      ]) {
        const result = await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table}`,
        );
        expect(result.rows[0]?.count, table).toBe(1);
      }
      for (const table of ["projects", "project_workspace_memberships"]) {
        const result = await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${table}`,
        );
        expect(result.rows[0]?.count, table).toBe(0);
      }
      const columns = await database.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects'
      `);
      expect(columns.rows.map(({ column_name }) => column_name)).toContain(
        "protected_label",
      );
      expect(columns.rows.map(({ column_name }) => column_name)).not.toContain(
        "name",
      );
    } finally {
      await database.close();
    }
  });
});
