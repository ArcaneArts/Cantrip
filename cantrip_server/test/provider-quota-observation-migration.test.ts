import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("provider quota observation migration", () => {
  it("preserves the observation time of existing current-state projections", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const migrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('CREATE TABLE "provider_quota_observations"'),
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
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO model_providers (id, owner_id, name, kind, base_url)
        VALUES (
          'provider-1', 'owner-1', 'Observed', 'chatgpt',
          'https://chatgpt.com/backend-api/codex'
        );

        INSERT INTO model_provider_accounts (
          id, provider_id, label, position, credential_home_key,
          weekly_usage_used_basis_points, auth_last_synced_at
        ) VALUES (
          'account-1', 'provider-1', 'Primary', 0, 'account-1', 3750,
          '2026-08-16T12:00:00Z'
        );

        INSERT INTO model_provider_account_workers (
          account_id, worker_id, auth_state, weekly_usage_used_basis_points,
          last_synced_at
        ) VALUES (
          'account-1', 'worker-1', 'signed-in', 3750,
          '2026-08-16T11:59:00Z'
        );
      `);
      for (const statement of migration!.sql) await client.exec(statement);

      const account = await client.query<{ weekly_usage_observed_at: Date }>(`
        SELECT weekly_usage_observed_at FROM model_provider_accounts
        WHERE id = 'account-1'
      `);
      expect(account.rows[0]?.weekly_usage_observed_at.toISOString()).toBe(
        "2026-08-16T12:00:00.000Z",
      );
      const binding = await client.query<{ weekly_usage_observed_at: Date }>(`
        SELECT weekly_usage_observed_at FROM model_provider_account_workers
        WHERE account_id = 'account-1' AND worker_id = 'worker-1'
      `);
      expect(binding.rows[0]?.weekly_usage_observed_at.toISOString()).toBe(
        "2026-08-16T11:59:00.000Z",
      );
    } finally {
      await client.close();
    }
  });
});
