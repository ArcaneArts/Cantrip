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

  it("recognizes the deterministic xAI namespace alias", () => {
    expect([...exactOpenRouterAliases(catalog("grok-4.6"), "grok")]).toContain(
      "x-ai/grok-4.6",
    );
  });

  it("inherits exact vision modalities when native metadata is unknown", () => {
    const target = catalog("grok-4.6");
    const source = catalog("x-ai/grok-4.6", {
      inputModalities: ["text", "image"],
      supportsVision: true,
      metadataSource: "openrouter",
    });
    expect(
      enrichCatalogFromExactOpenRouterMatch(target, "grok", [source]),
    ).toMatchObject({
      inputModalities: ["text", "image"],
      supportsVision: true,
    });
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
              rawMetadata: { safe: "kept", api_key: "must-not-persist" },
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
      const initialSnapshots = await client.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM provider_model_catalog_snapshots
      `);
      expect(initialSnapshots.rows[0]?.count).toBe(2);
      const storedMetadata = await client.query<{
        metadata: { rawMetadata?: Record<string, unknown> };
      }>(`
        SELECT metadata FROM provider_model_catalog_snapshots
        WHERE native_model_id = 'openai/gpt-5.6-sol'
      `);
      expect(storedMetadata.rows[0]?.metadata.rawMetadata).toEqual({
        safe: "kept",
      });

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
        },
      );
      expect(
        (
          await client.query<{ count: number }>(`
            SELECT count(*)::int AS count FROM provider_model_catalog_snapshots
          `)
        ).rows[0]?.count,
      ).toBe(2);
      await repository.reconcileProviderModelCatalog(
        LOCAL_USER_ID,
        chatGpt.id,
        {
          models: [
            catalogWrite("gpt-5.6-sol", {
              description: "Changed catalog description",
              matchConfidenceBasisPoints: 10_000,
            }),
          ],
          availabilityScope: "worker:one:chatgpt-account:one",
          availableNativeModelIds: new Set(["gpt-5.6-sol"]),
        },
      );
      expect(
        (
          await client.query<{ count: number }>(`
            SELECT count(*)::int AS count FROM provider_model_catalog_snapshots
          `)
        ).rows[0]?.count,
      ).toBe(3);

      const behaviorStartedAt = new Date("2026-08-16T10:00:00.000Z");
      await repository.recordModelBehaviorObservation(LOCAL_USER_ID, {
        sourceKey: "chat-attempt:test",
        projectId: null,
        chatId: null,
        modelRouteId: runtime!.routeId,
        modelName: runtime!.model.profileName,
        providerName: runtime!.provider.name,
        providerModelName: runtime!.model.name,
        providerAccountId: "account-1",
        workerId: "worker-1",
        executionAttemptId: "attempt-1",
        attemptStatus: "running",
        startedAt: behaviorStartedAt,
      });
      await repository.recordModelBehaviorObservation(LOCAL_USER_ID, {
        sourceKey: "chat-attempt:test",
        projectId: null,
        chatId: null,
        modelRouteId: runtime!.routeId,
        modelName: runtime!.model.profileName,
        providerName: runtime!.provider.name,
        providerModelName: runtime!.model.name,
        providerAccountId: "account-1",
        workerId: "worker-1",
        turnId: "turn-1",
        executionAttemptId: "attempt-1",
        attemptStatus: "completed",
        startedAt: behaviorStartedAt,
        completedAt: new Date("2026-08-16T10:00:02.000Z"),
        finalizedAt: new Date("2026-08-16T10:00:02.000Z"),
        durationMs: 2_000,
        finalAnswerAppeared: true,
        toolCallCount: 2,
        inputTokens: 100,
        outputTokens: 20,
      });
      const behavior = await client.query<{
        attempt_status: string;
        duration_ms: number;
        provider_account_id: string;
        tool_call_count: number;
      }>(`
        SELECT attempt_status, duration_ms, provider_account_id, tool_call_count
        FROM model_behavior_observations
        WHERE source_key = 'chat-attempt:test'
      `);
      expect(behavior.rows).toEqual([
        expect.objectContaining({
          attempt_status: "completed",
          duration_ms: 2000,
          provider_account_id: "account-1",
          tool_call_count: 2,
        }),
      ]);
    } finally {
      await client.close();
    }
  });
});
