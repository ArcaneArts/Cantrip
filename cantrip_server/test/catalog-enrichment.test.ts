import { fileURLToPath } from "node:url";

import type { ProviderModelCatalogEntry } from "@cantrip/protocol";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  LOCAL_USER_ID,
  ServerRepository,
  type ProviderModelCatalogWrite,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  enrichCatalogFromExactOpenRouterMatch,
  exactOpenRouterAliases,
} from "../src/models/catalog-enrichment.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const catalog = (
  nativeModelId: string,
  overrides: Partial<ProviderModelCatalogEntry> = {},
): ProviderModelCatalogEntry => ({
  id: `catalog:${nativeModelId}`,
  providerId: "provider",
  nativeModelId,
  canonicalModelId: nativeModelId,
  displayName: nativeModelId,
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsTools: null,
  supportsParallelTools: null,
  supportsStructuredOutput: null,
  supportsVision: null,
  supportsReasoning: null,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  reasoningMandatory: null,
  family: null,
  parameterSize: null,
  quantization: null,
  digest: null,
  metadataSource: "codex" as const,
  matchConfidence: null,
  hidden: false,
  isDefault: false,
  lastSeenAt: "2026-08-14T00:00:00.000Z",
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  ...overrides,
});

const catalogWrite = (
  nativeModelId: string,
  overrides: Partial<ProviderModelCatalogWrite> = {},
): ProviderModelCatalogWrite => ({
  nativeModelId,
  canonicalModelId: nativeModelId,
  displayName: nativeModelId,
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsTools: null,
  supportsParallelTools: null,
  supportsStructuredOutput: null,
  supportsVision: null,
  supportsReasoning: null,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  reasoningMandatory: null,
  family: null,
  parameterSize: null,
  quantization: null,
  digest: null,
  metadataSource: "codex",
  matchConfidenceBasisPoints: null,
  rawMetadata: {},
  ...overrides,
});

describe("provider catalog enrichment", () => {
  it("recognizes the deterministic OpenAI namespace alias", () => {
    expect([
      ...exactOpenRouterAliases(catalog("gpt-5.6-sol"), "chatgpt"),
    ]).toContain("openai/gpt-5.6-sol");
  });

  it("fills unknown metadata from one exact OpenRouter match", () => {
    const target = catalog("gpt-5.6-sol", { contextWindow: 200_000 });
    const source = catalog("openai/gpt-5.6-sol", {
      canonicalModelId: "openai/gpt-5.6-sol",
      description: "OpenRouter metadata",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      metadataSource: "openrouter",
    });
    expect(
      enrichCatalogFromExactOpenRouterMatch(target, "chatgpt", [source]),
    ).toMatchObject({
      description: "OpenRouter metadata",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      metadataSource: "codex",
      matchConfidence: 1,
    });
  });

  it("does not guess when an alias has multiple catalog matches", () => {
    const target = catalog("gpt-5.6-sol");
    const source = catalog("openai/gpt-5.6-sol", {
      metadataSource: "openrouter",
    });
    expect(
      enrichCatalogFromExactOpenRouterMatch(target, "chatgpt", [
        source,
        { ...source, id: "second" },
      ]),
    ).toBe(target);
  });

  it("enriches a routed ChatGPT model from a stored exact OpenRouter alias", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 12) }],
        }),
      );
      await repository.ensureLocalIdentity();
      const openRouter = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "OpenRouter",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
      });
      const chatGpt = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      });
      await repository.reconcileProviderModelCatalog(
        LOCAL_USER_ID,
        openRouter.id,
        {
          models: [
            catalogWrite("openai/gpt-5.6-sol", {
              description: "Exact OpenRouter description",
              maxOutputTokens: 128_000,
              metadataSource: "openrouter",
              matchConfidenceBasisPoints: 10_000,
            }),
          ],
          availabilityScope: "openrouter:global",
          availableNativeModelIds: new Set(["openai/gpt-5.6-sol"]),
        },
      );
      await repository.reconcileProviderModelCatalog(
        LOCAL_USER_ID,
        chatGpt.id,
        {
          models: [
            catalogWrite("gpt-5.6-sol", {
              matchConfidenceBasisPoints: 10_000,
            }),
          ],
          availabilityScope: "worker:one:chatgpt-account:one",
          availableNativeModelIds: new Set(["gpt-5.6-sol"]),
          autoCreateLogicalModels: true,
        },
      );
      const profile = await client.query<{ id: string }>(`
        SELECT id FROM model_profiles
        WHERE owner_id = '${LOCAL_USER_ID}' AND name = 'gpt-5.6-sol'
      `);
      const runtime = await repository.getModelRuntime(
        LOCAL_USER_ID,
        profile.rows[0]!.id,
      );
      expect(runtime?.model.catalog).toMatchObject({
        description: "Exact OpenRouter description",
        maxOutputTokens: 128_000,
        metadataSource: "codex",
      });
    } finally {
      await client.close();
    }
  });
});
