import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  normalizeOpenRouterModel,
  OpenRouterCatalogCache,
  OpenRouterCatalogService,
} from "../src/models/openrouter-catalog.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const publicModels = {
  data: [
    {
      id: "openai/gpt-test",
      canonical_slug: "openai/gpt-test-2026-08-01",
      name: "GPT Test",
      description: "A model used by the catalog test.",
      context_length: 128_000,
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        instruct_type: "responses",
      },
      supported_parameters: [
        "tools",
        "parallel_tool_calls",
        "response_format",
        "reasoning",
      ],
      reasoning: {
        mandatory: true,
        default_enabled: true,
        supported_efforts: ["xhigh", "high", "medium", "low"],
        default_effort: "high",
      },
      top_provider: {
        context_length: 200_000,
        max_completion_tokens: 32_000,
      },
    },
    {
      id: "google/gemma-test",
      name: "Gemma Test",
      context_length: 64_000,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      supported_parameters: [],
      top_provider: {},
    },
  ],
};

describe("OpenRouter catalog", () => {
  it("normalizes the reasoning levels advertised by OpenRouter", () => {
    const model = normalizeOpenRouterModel(publicModels.data[0]!);
    expect(model).toMatchObject({
      nativeModelId: "openai/gpt-test",
      canonicalModelId: "openai/gpt-test-2026-08-01",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      supportsTools: true,
      supportsParallelTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsReasoning: true,
      supportedReasoningEfforts: [
        { effort: "xhigh", description: "xhigh reasoning" },
        { effort: "high", description: "high reasoning" },
        { effort: "medium", description: "medium reasoning" },
        { effort: "low", description: "low reasoning" },
      ],
      defaultReasoningEffort: "high",
      reasoningMandatory: true,
      metadataSource: "openrouter",
    });
  });

  it("serves stale data while revalidating with an ETag", async () => {
    let now = 1_000;
    const requests: RequestInit[] = [];
    const fetchImplementation = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return Response.json(publicModels, {
          headers: { etag: '"catalog-v1"' },
        });
      }
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const cache = new OpenRouterCatalogCache({
      fetch: fetchImplementation,
      now: () => now,
      ttlMs: 100,
    });

    const first = await cache.read({
      apiKey: null,
      baseUrl: "https://openrouter.ai/api/v1",
      cacheKey: "public",
      userScoped: false,
    });
    expect(first.servedStale).toBe(false);
    expect(first.snapshot.models).toHaveLength(2);

    now += 101;
    const stale = await cache.read({
      apiKey: null,
      baseUrl: "https://openrouter.ai/api/v1",
      cacheKey: "public",
      userScoped: false,
    });
    expect(stale.servedStale).toBe(true);
    await stale.backgroundRefresh;
    expect(new Headers(requests[1]?.headers).get("if-none-match")).toBe(
      '"catalog-v1"',
    );

    const fresh = await cache.read({
      apiKey: null,
      baseUrl: "https://openrouter.ai/api/v1",
      cacheKey: "public",
      userScoped: false,
    });
    expect(fresh.servedStale).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("persists global metadata and account-scoped availability only", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
        }),
      );
      await repository.ensureLocalIdentity();
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "OpenRouter",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
      });
      const requests: Array<{ authorization: string | null; url: string }> = [];
      const fetchImplementation = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = String(input);
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          url,
        });
        return Response.json(
          url.endsWith("/models/user")
            ? { data: [publicModels.data[0]] }
            : publicModels,
        );
      }) as typeof fetch;
      const service = new OpenRouterCatalogService(repository, {
        fetch: fetchImplementation,
      });

      const catalog = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        true,
      );
      expect(catalog?.models).toHaveLength(2);
      expect(catalog?.syncStates.map((state) => state.status)).toEqual([
        "current",
        "current",
      ]);
      const userAvailability = catalog?.availability.filter(
        (availability) => availability.scopeKey === "openrouter:user",
      );
      expect(
        userAvailability?.filter(({ state }) => state === "available"),
      ).toHaveLength(1);
      expect(
        userAvailability?.filter(({ state }) => state === "unavailable"),
      ).toHaveLength(1);
      expect(requests).toEqual([
        {
          authorization: "Bearer sk-or-test",
          url: "https://openrouter.ai/api/v1/models",
        },
        {
          authorization: "Bearer sk-or-test",
          url: "https://openrouter.ai/api/v1/models/user",
        },
      ]);
      const profiles = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM model_profiles",
      );
      expect(profiles.rows[0]?.count).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("serves the durable last-good catalog when a forced refresh fails", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    let fail = false;
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 11) }],
        }),
      );
      await repository.ensureLocalIdentity();
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "OpenRouter",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
      });
      const service = new OpenRouterCatalogService(repository, {
        fetch: (async () => {
          if (fail) throw new Error("catalog network unavailable");
          return Response.json(publicModels);
        }) as typeof fetch,
      });

      expect(
        await service.getProviderCatalog(LOCAL_USER_ID, provider.id, true),
      ).toMatchObject({ models: expect.any(Array), servedStale: false });
      fail = true;
      const stale = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        true,
      );
      expect(stale).toMatchObject({
        models: expect.any(Array),
        servedStale: true,
      });
      expect(stale?.models).toHaveLength(2);
      expect(stale?.syncStates).toEqual([
        expect.objectContaining({
          status: "stale",
          error: "catalog network unavailable",
        }),
      ]);
    } finally {
      await client.close();
    }
  });
});
