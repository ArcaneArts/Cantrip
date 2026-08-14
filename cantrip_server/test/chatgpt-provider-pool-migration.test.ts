import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("ChatGPT provider pool migration", () => {
  it("consolidates providers while preserving credential homes and route history", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const poolMigration = migrations.at(-1);
      expect(poolMigration).toBeDefined();
      for (const migration of migrations.slice(0, -1)) {
        for (const statement of migration.sql) await client.exec(statement);
      }
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO model_providers (
          id, owner_id, name, kind, base_url, created_at
        ) VALUES
          ('chatgpt-a', 'owner-1', 'Personal', 'chatgpt', 'https://api.openai.com/v1', '2026-01-01'),
          ('chatgpt-b', 'owner-1', 'Work', 'chatgpt', 'https://api.openai.com/v1', '2026-01-02');

        INSERT INTO model_profiles (id, owner_id, name)
        VALUES ('model-1', 'owner-1', 'GPT Test');

        INSERT INTO provider_models (
          id, provider_id, native_model_id, display_name, metadata_source
        ) VALUES
          ('provider-model-a', 'chatgpt-a', 'gpt-test', 'GPT Test', 'codex'),
          ('provider-model-b', 'chatgpt-b', 'gpt-test', 'GPT Test', 'codex');

        INSERT INTO model_routes (
          id, model_id, provider_id, provider_model_id, model_name, position
        ) VALUES
          ('route-a', 'model-1', 'chatgpt-a', 'provider-model-a', 'gpt-test', 0),
          ('route-b', 'model-1', 'chatgpt-b', 'provider-model-b', 'gpt-test', 1);

        INSERT INTO token_usage_records (
          id, owner_id, source_key, model_id, model_route_id, provider_id,
          model_name, provider_name, provider_model_name
        ) VALUES (
          'usage-1', 'owner-1', 'legacy-turn', 'model-1', 'route-b', 'chatgpt-b',
          'GPT Test', 'Work', 'gpt-test'
        );
      `);
      for (const statement of poolMigration!.sql) await client.exec(statement);

      const providers = await client.query<{ id: string }>(`
        SELECT id FROM model_providers WHERE owner_id = 'owner-1' AND kind = 'chatgpt'
      `);
      expect(providers.rows).toEqual([{ id: "chatgpt-a" }]);

      const accounts = await client.query<{
        credential_home_key: string;
        position: number;
        provider_id: string;
      }>(`
        SELECT provider_id, credential_home_key, position
        FROM model_provider_accounts
        ORDER BY position
      `);
      expect(accounts.rows).toEqual([
        {
          provider_id: "chatgpt-a",
          credential_home_key: "chatgpt-a",
          position: 0,
        },
        {
          provider_id: "chatgpt-a",
          credential_home_key: "chatgpt-b",
          position: 1,
        },
      ]);

      const routes = await client.query<{
        id: string;
        provider_id: string;
        provider_model_id: string;
      }>(`
        SELECT id, provider_id, provider_model_id FROM model_routes
      `);
      expect(routes.rows).toEqual([
        {
          id: "route-a",
          provider_id: "chatgpt-a",
          provider_model_id: "provider-model-a",
        },
      ]);

      const usage = await client.query<{
        model_route_id: string;
        provider_id: string;
      }>(`
        SELECT model_route_id, provider_id FROM token_usage_records WHERE id = 'usage-1'
      `);
      expect(usage.rows).toEqual([
        { model_route_id: "route-a", provider_id: "chatgpt-a" },
      ]);
    } finally {
      await client.close();
    }
  });
});
