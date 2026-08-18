import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  isZaiCodingPlanProvider,
  ZAI_CODEX_CATALOG_SCOPE,
  ZAI_CODEX_CATALOG_VERSION,
  ZAI_CODEX_MODELS,
  ZaiCatalogService,
} from "../src/models/zai-catalog.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function setup() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 23) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    "gemma4:12b",
    "http://127.0.0.1:11434/v1",
  );
  return { client, database, repository };
}

describe("Z.ai Coding Plan catalog", () => {
  it("detects the canonical Responses provider family", () => {
    expect(
      isZaiCodingPlanProvider({
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/v1/responses",
      }),
    ).toBe(true);
    expect(
      isZaiCodingPlanProvider({
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      }),
    ).toBe(false);
  });

  it("ships the documented versioned Codex metadata", () => {
    expect(ZAI_CODEX_CATALOG_VERSION).toBe(1);
    expect(ZAI_CODEX_MODELS).toEqual([
      expect.objectContaining({
        nativeModelId: "glm-5.3",
        contextWindow: 1_048_576,
        inputModalities: ["text"],
        supportsTools: true,
        supportsParallelTools: true,
        supportsVision: false,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [
          expect.objectContaining({ effort: "low" }),
          expect.objectContaining({ effort: "high" }),
          expect.objectContaining({ effort: "max" }),
        ],
        metadataSource: "zai",
        isDefault: true,
        rawMetadata: expect.objectContaining({
          applyPatchToolType: "freeform",
          contextWindowPercent: 95,
          catalogVersion: 1,
        }),
      }),
      expect.objectContaining({
        nativeModelId: "glm-5-turbo",
        contextWindow: 204_800,
        inputModalities: ["text"],
        supportsTools: true,
        supportsParallelTools: true,
        supportsVision: false,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [],
        metadataSource: "zai",
        rawMetadata: expect.objectContaining({
          applyPatchToolType: "freeform",
          contextWindowPercent: 95,
          catalogVersion: 1,
        }),
      }),
    ]);
  });

  it("creates discovery-managed routes and preserves user customization", async () => {
    const { client, database, repository } = await setup();
    try {
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Existing Z.ai",
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/v1/responses",
        apiKey: "secret-coding-plan-key",
      });
      const service = new ZaiCatalogService(repository);
      const first = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
      );
      expect(
        first?.models.map(({ nativeModelId }) => nativeModelId).sort(),
      ).toEqual(["glm-5-turbo", "glm-5.3"]);
      expect(first?.availability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scopeKey: ZAI_CODEX_CATALOG_SCOPE,
            state: "available",
            workerId: null,
          }),
        ]),
      );

      const settings = await repository.getSettings(LOCAL_USER_ID);
      const discovered = settings.models.find(({ name }) => name === "glm-5.3");
      expect(discovered).toMatchObject({
        discoveryManaged: true,
        routes: [
          expect.objectContaining({
            discoveryManaged: true,
            modelName: "glm-5.3",
            providerId: provider.id,
          }),
        ],
      });

      await database
        .update(schema.modelProfiles)
        .set({ name: "My GLM flagship", discoveryManaged: false })
        .where(eq(schema.modelProfiles.id, discovered!.id));
      await service.getProviderCatalog(LOCAL_USER_ID, provider.id);
      const refreshed = await repository.getSettings(LOCAL_USER_ID);
      expect(
        refreshed.models.find(({ id }) => id === discovered!.id),
      ).toMatchObject({
        name: "My GLM flagship",
        discoveryManaged: false,
        routes: [expect.objectContaining({ modelName: "glm-5.3" })],
      });
    } finally {
      await client.close();
    }
  });
});
