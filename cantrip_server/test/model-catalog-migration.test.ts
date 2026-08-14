import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("model catalog migration", () => {
  it("persists worker/account-scoped catalogs without changing old providers", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Local Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO model_providers (
          id, owner_id, name, kind, base_url
        ) VALUES (
          'provider-1', 'owner-1', 'ChatGPT', 'chatgpt', 'https://chatgpt.com/backend-api'
        );

        INSERT INTO model_provider_accounts (
          id, provider_id, label, position, credential_home_key
        ) VALUES (
          'account-1', 'provider-1', 'Personal', 0, 'legacy-provider-1'
        );

        INSERT INTO model_provider_account_workers (
          account_id, worker_id, auth_state, weekly_usage_used_basis_points
        ) VALUES (
          'account-1', 'worker-1', 'signed-in', 4250
        );

        INSERT INTO provider_models (
          id, provider_id, native_model_id, canonical_model_id, display_name,
          context_window, metadata_source, supported_reasoning_efforts
        ) VALUES (
          'provider-model-1', 'provider-1', 'gpt-test', 'openai/gpt-test',
          'GPT Test', 131072, 'codex',
          '[{"effort":"low","description":"Fast"}]'::jsonb
        );

        INSERT INTO provider_model_availability (
          id, provider_model_id, scope_key, worker_id, provider_account_id
        ) VALUES (
          'availability-1', 'provider-model-1',
          'worker:worker-1:account:account-1', 'worker-1', 'account-1'
        );
      `);

      const provider = await client.query<{
        weekly_usage_reserve_percent: number;
      }>(`
        SELECT weekly_usage_reserve_percent
        FROM model_providers
        WHERE id = 'provider-1'
      `);
      expect(provider.rows[0]?.weekly_usage_reserve_percent).toBe(3);

      const catalog = await client.query<{
        auth_state: string;
        context_window: number;
        state: string;
        weekly_usage_used_basis_points: number;
      }>(`
        SELECT account_worker.auth_state,
               account_worker.weekly_usage_used_basis_points,
               model.context_window,
               availability.state
        FROM provider_models model
        JOIN provider_model_availability availability
          ON availability.provider_model_id = model.id
        JOIN model_provider_account_workers account_worker
          ON account_worker.account_id = availability.provider_account_id
         AND account_worker.worker_id = availability.worker_id
        WHERE model.id = 'provider-model-1'
      `);
      expect(catalog.rows).toEqual([
        {
          auth_state: "signed-in",
          weekly_usage_used_basis_points: 4250,
          context_window: 131_072,
          state: "available",
        },
      ]);

      await expect(
        client.exec(`
          INSERT INTO provider_models (
            id, provider_id, native_model_id, display_name, metadata_source
          ) VALUES (
            'invalid-model', 'provider-1', 'invalid', 'Invalid', 'guesswork'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
