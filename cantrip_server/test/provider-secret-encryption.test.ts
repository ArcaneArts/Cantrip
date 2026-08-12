import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const secret = "sk-never-store-this-in-plaintext";
const key = (fill: number) => Buffer.alloc(32, fill);

describe("provider secret persistence", () => {
  it("encrypts new and legacy API keys and rotates envelopes", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const oldVault = new SecretVault({
        activeKeyId: "old",
        keys: [{ id: "old", key: key(4) }],
      });
      const repository = new ServerRepository(database, oldVault);
      await repository.ensureLocalIdentity();
      await repository.ensureDefaultModelConfiguration(
        LOCAL_USER_ID,
        "test-default",
        "http://127.0.0.1:11434/v1",
      );
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Encrypted",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: secret,
      });
      const model = await repository.createModelProfile(LOCAL_USER_ID, {
        name: "Encrypted model",
        routes: [
          {
            providerId: provider.id,
            modelName: "openai/gpt-5",
            enabled: true,
          },
        ],
      });
      expect(model).not.toBeNull();

      let stored = await client.query<{
        api_key: string | null;
        api_key_envelope: string | null;
      }>(
        `SELECT api_key, api_key_envelope FROM model_providers WHERE id = '${provider.id}'`,
      );
      expect(stored.rows[0]?.api_key).toBeNull();
      expect(stored.rows[0]?.api_key_envelope).not.toContain(secret);
      expect(
        (await repository.getModelRuntime(LOCAL_USER_ID, model!.id))?.provider
          .apiKey,
      ).toBe(secret);

      await client.exec(`
        INSERT INTO model_providers (
          id, owner_id, name, kind, base_url, api_key
        ) VALUES (
          'legacy-provider', '${LOCAL_USER_ID}', 'Legacy', 'openai-compatible',
          'https://api.example.test/v1', '${secret}'
        );
      `);
      await repository.migrateProviderSecrets();
      const legacy = await client.query<{
        api_key: string | null;
        api_key_envelope: string | null;
      }>(`
        SELECT api_key, api_key_envelope
        FROM model_providers
        WHERE id = 'legacy-provider'
      `);
      expect(legacy.rows[0]?.api_key).toBeNull();
      expect(legacy.rows[0]?.api_key_envelope).not.toContain(secret);

      const rotatingRepository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "new",
          keys: [
            { id: "new", key: key(5) },
            { id: "old", key: key(4) },
          ],
        }),
      );
      await rotatingRepository.migrateProviderSecrets();
      stored = await client.query<{
        api_key: string | null;
        api_key_envelope: string | null;
      }>(
        `SELECT api_key, api_key_envelope FROM model_providers WHERE id = '${provider.id}'`,
      );
      expect(JSON.parse(stored.rows[0]!.api_key_envelope!)).toMatchObject({
        keyId: "new",
        version: 1,
      });
      expect(
        (await rotatingRepository.getModelRuntime(LOCAL_USER_ID, model!.id))
          ?.provider.apiKey,
      ).toBe(secret);
    } finally {
      await client.close();
    }
  });
});
