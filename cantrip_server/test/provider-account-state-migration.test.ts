import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("global provider account state migration", () => {
  it("backfills the most recently observed account quota", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const migrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes(
            'ADD COLUMN "weekly_usage_used_basis_points" integer',
          ),
        ),
      );
      const migration = migrations[migrationIndex];
      expect(migration).toBeDefined();
      for (const earlier of migrations.slice(0, migrationIndex)) {
        for (const statement of earlier.sql) await client.exec(statement);
      }
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES
          ('worker-old', 'owner-1', 'Old', 'linux', 'x64', now(), now()),
          ('worker-new', 'owner-1', 'New', 'win32', 'x64', now(), now());

        INSERT INTO model_providers (id, owner_id, name, kind, base_url)
        VALUES (
          'provider-1', 'owner-1', 'ChatGPT', 'chatgpt',
          'https://chatgpt.com/backend-api/codex'
        );

        INSERT INTO model_provider_accounts (
          id, provider_id, label, position, credential_home_key
        ) VALUES ('account-1', 'provider-1', 'Primary', 0, 'provider-1');

        INSERT INTO model_provider_account_workers (
          account_id, worker_id, auth_state, weekly_usage_used_basis_points,
          weekly_usage_resets_at, last_synced_at
        ) VALUES
          ('account-1', 'worker-old', 'signed-in', 2500,
           '2026-08-20T12:00:00Z', '2026-08-14T12:00:00Z'),
          ('account-1', 'worker-new', 'signed-in', 6250,
           '2026-08-22T12:00:00Z', '2026-08-15T12:00:00Z');

        INSERT INTO provider_models (
          id, provider_id, native_model_id, display_name, metadata_source
        ) VALUES ('model-1', 'provider-1', 'gpt-test', 'GPT Test', 'codex');

        INSERT INTO provider_model_availability (
          id, provider_model_id, scope_key, worker_id, provider_account_id,
          state, last_seen_at
        ) VALUES
          ('availability-old', 'model-1', 'worker:worker-old:chatgpt-account:account-1',
           'worker-old', 'account-1', 'stale', '2026-08-14T12:00:00Z'),
          ('availability-new', 'model-1', 'worker:worker-new:chatgpt-account:account-1',
           'worker-new', 'account-1', 'available', '2026-08-15T12:00:00Z');

        INSERT INTO provider_catalog_sync_states (
          id, provider_id, scope_key, worker_id, provider_account_id, status,
          last_success_at
        ) VALUES
          ('sync-old', 'provider-1', 'worker:worker-old:chatgpt-account:account-1',
           'worker-old', 'account-1', 'stale', '2026-08-14T12:00:00Z'),
          ('sync-new', 'provider-1', 'worker:worker-new:chatgpt-account:account-1',
           'worker-new', 'account-1', 'current', '2026-08-15T12:00:00Z');
      `);
      for (const statement of migration!.sql) await client.exec(statement);
      const result = await client.query<{
        auth_last_synced_at: Date;
        weekly_usage_resets_at: Date;
        weekly_usage_used_basis_points: number;
      }>(`
        SELECT auth_last_synced_at, weekly_usage_resets_at,
               weekly_usage_used_basis_points
        FROM model_provider_accounts WHERE id = 'account-1'
      `);
      expect(result.rows[0]).toMatchObject({
        weekly_usage_used_basis_points: 6250,
      });
      expect(result.rows[0]?.auth_last_synced_at.toISOString()).toBe(
        "2026-08-15T12:00:00.000Z",
      );
      expect(result.rows[0]?.weekly_usage_resets_at.toISOString()).toBe(
        "2026-08-22T12:00:00.000Z",
      );
      const availability = await client.query<{
        scope_key: string;
        state: string;
        worker_id: string | null;
      }>(`
        SELECT scope_key, state, worker_id
        FROM provider_model_availability WHERE provider_account_id = 'account-1'
      `);
      expect(availability.rows).toEqual([
        {
          scope_key: "chatgpt-account:account-1",
          state: "available",
          worker_id: null,
        },
      ]);
      const sync = await client.query<{
        scope_key: string;
        status: string;
        worker_id: string | null;
      }>(`
        SELECT scope_key, status, worker_id
        FROM provider_catalog_sync_states WHERE provider_account_id = 'account-1'
      `);
      expect(sync.rows).toEqual([
        {
          scope_key: "chatgpt-account:account-1",
          status: "current",
          worker_id: null,
        },
      ]);
    } finally {
      await client.close();
    }
  });
});
