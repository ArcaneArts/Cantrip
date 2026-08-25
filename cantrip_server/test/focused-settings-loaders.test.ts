import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_ROUTE_ID,
  DEFAULT_OLLAMA_PROVIDER_ID,
  LOCAL_USER_ID,
  ServerRepository,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

import { protectedSecretEnvelopeFixture } from "./protected-provider-credential-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function setup() {
  const queries: string[] = [];
  const client = new PGlite();
  const database = drizzle(client, {
    schema,
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 47) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    "gemma4:12b",
    "http://127.0.0.1:11434/v1",
  );
  queries.length = 0;
  return { client, queries, repository };
}

describe("focused settings loaders", () => {
  it("loads preference decisions with one history-independent query", async () => {
    const { client, queries, repository } = await setup();
    try {
      await client.exec(
        [
          "insert into token_usage_records (",
          "  id, owner_id, source_key, model_id, model_route_id, provider_id,",
          "  input_tokens, output_tokens, started_at, completed_at",
          ")",
          "select",
          "  'focused-settings-usage-' || value,",
          "  '" + LOCAL_USER_ID + "',",
          "  'focused-settings-source-' || value,",
          "  '" + DEFAULT_MODEL_ID + "',",
          "  '" + DEFAULT_MODEL_ROUTE_ID + "',",
          "  '" + DEFAULT_OLLAMA_PROVIDER_ID + "',",
          "  value, value * 2,",
          "  now() - interval '1 minute', now()",
          "from generate_series(1, 10) as value",
        ].join("\n"),
      );

      queries.length = 0;
      const aggregate = await repository.getSettings(LOCAL_USER_ID);
      const aggregateQueryCount = queries.length;

      queries.length = 0;
      const preferences = await repository.getUserSettings(LOCAL_USER_ID);

      expect(preferences).toEqual(aggregate.preferences);
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toContain("token_usage_records");
      expect(aggregateQueryCount).toBe(9);

      const focusedModelId = preferences.defaultModelId;
      const aggregateModelId = aggregate.preferences.defaultModelId;
      expect(focusedModelId).toBe(aggregateModelId);
      expect(focusedModelId).not.toBeNull();
      const [focusedRuntime, aggregateRuntime] = await Promise.all([
        repository.getModelRuntime(LOCAL_USER_ID, focusedModelId!),
        repository.getModelRuntime(LOCAL_USER_ID, aggregateModelId!),
      ]);
      expect(focusedRuntime).toEqual(aggregateRuntime);
    } finally {
      await client.close();
    }
  });

  it("loads provider refresh and route-existence data without the aggregate bundle", async () => {
    const { client, queries, repository } = await setup();
    try {
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        id: "00000000-0000-4000-8000-000000000961",
        name: "Focused ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        initialAccount: {
          id: "00000000-0000-4000-8000-000000000962",
          protectedLabel: protectedSecretEnvelopeFixture("W"),
        },
      });
      await repository.createModelProfile(LOCAL_USER_ID, {
        name: "Focused model",
        routes: [
          {
            providerId: provider.id,
            modelName: "gpt-5.6-sol",
            enabled: true,
          },
        ],
      });

      queries.length = 0;
      const catalogTargets =
        await repository.listModelProviderCatalogTargets(LOCAL_USER_ID);
      expect(queries).toHaveLength(1);
      expect(catalogTargets).toContainEqual(
        expect.objectContaining({
          id: provider.id,
          kind: "chatgpt",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      );
      expect(catalogTargets.find(({ id }) => id === provider.id)).toEqual({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        id: provider.id,
        kind: "chatgpt",
      });

      queries.length = 0;
      const refreshTargets =
        await repository.listModelProviderRefreshTargets(LOCAL_USER_ID);
      expect(queries).toHaveLength(1);
      expect(refreshTargets).toContainEqual(
        expect.objectContaining({
          id: provider.id,
          kind: "chatgpt",
          accounts: [
            expect.objectContaining({
              enabled: true,
              id: provider.accounts[0]!.id,
            }),
          ],
        }),
      );

      queries.length = 0;
      await expect(
        repository.hasModelRoutesForProvider(LOCAL_USER_ID, provider.id),
      ).resolves.toBe(true);
      expect(queries).toHaveLength(1);

      queries.length = 0;
      await expect(
        repository.hasModelRoutesForProvider(
          LOCAL_USER_ID,
          "00000000-0000-4000-8000-000000000963",
        ),
      ).resolves.toBe(false);
      expect(queries).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
