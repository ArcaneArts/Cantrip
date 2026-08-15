import type {
  ModelProviderSummary,
  ProviderModelCatalogResult,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  availableCatalogModelIds,
  catalogDisplayStatus,
  catalogScopeLabel,
  formatCatalogAge,
  providerSupportsCatalog,
} from "./provider-catalog-display";

const provider = {
  id: "provider-1",
  name: "Ollama",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  hasApiKey: false,
  weeklyUsageReservePercent: 3,
  accounts: [],
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
} satisfies ModelProviderSummary;

const catalog = {
  providerId: provider.id,
  models: [],
  availability: [
    {
      id: "availability-a",
      providerModelId: "model-a",
      scopeKey: "worker:a",
      workerId: "a",
      providerAccountId: null,
      state: "available",
      lastSeenAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
    {
      id: "availability-b",
      providerModelId: "model-b",
      scopeKey: "worker:b",
      workerId: "b",
      providerAccountId: null,
      state: "available",
      lastSeenAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
  ],
  syncStates: [
    {
      id: "sync-a",
      providerId: provider.id,
      scopeKey: "worker:a",
      workerId: "a",
      providerAccountId: null,
      status: "current",
      error: null,
      etag: null,
      refreshStartedAt: null,
      lastSuccessAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
  ],
  servedStale: false,
} satisfies ProviderModelCatalogResult;

describe("provider catalog presentation", () => {
  it("recognizes only providers backed by a discovery service", () => {
    expect(providerSupportsCatalog(provider)).toBe(true);
    expect(
      providerSupportsCatalog({
        ...provider,
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toBe(true);
    expect(
      providerSupportsCatalog({
        ...provider,
        kind: "openai-compatible",
        baseUrl: "https://api.x.ai/v1",
      }),
    ).toBe(false);
    expect(
      providerSupportsCatalog({
        ...provider,
        kind: "grok",
        baseUrl: "https://cli-chat-proxy.grok.com/v1",
      }),
    ).toBe(true);
  });

  it("summarizes signed-in Grok account scope", () => {
    expect(
      catalogScopeLabel(
        {
          ...provider,
          kind: "grok",
          baseUrl: "https://cli-chat-proxy.grok.com/v1",
          accounts: [
            {
              id: "grok-account",
              providerId: provider.id,
              label: "SuperGrok",
              email: "grok@example.com",
              planType: "SuperGrok",
              position: 0,
              enabled: true,
              credentialState: "signed-in",
              weeklyUsageUsedPercent: null,
              weeklyUsageResetsAt: null,
              authLastSyncedAt: "2026-08-14T00:00:00.000Z",
              workerBindings: [
                {
                  workerId: "a",
                  authState: "signed-in",
                  weeklyUsageUsedPercent: null,
                  weeklyUsageResetsAt: null,
                  lastSyncedAt: "2026-08-14T00:00:00.000Z",
                },
              ],
              createdAt: "2026-08-14T00:00:00.000Z",
              updatedAt: "2026-08-14T00:00:00.000Z",
            },
          ],
        },
        catalog,
        "a",
      ),
    ).toBe("1 signed-in account");
  });

  it("keeps worker-local inventory separate", () => {
    expect([...availableCatalogModelIds(catalog, "a")]).toEqual(["model-a"]);
    expect([...availableCatalogModelIds(catalog, "b")]).toEqual(["model-b"]);
    expect(catalogScopeLabel(provider, catalog, "a")).toBe("2 workers");
  });

  it("prefers OpenRouter account availability over the public manifest", () => {
    expect([
      ...availableCatalogModelIds(
        {
          ...catalog,
          availability: [
            {
              ...catalog.availability[0]!,
              id: "global",
              providerModelId: "public-model",
              scopeKey: "openrouter:global",
              workerId: null,
            },
            {
              ...catalog.availability[0]!,
              id: "user",
              providerModelId: "account-model",
              scopeKey: "openrouter:user",
              workerId: null,
            },
          ],
        },
        "a",
      ),
    ]).toEqual(["account-model"]);
  });

  it("summarizes freshness without hiding partial failures", () => {
    expect(catalogDisplayStatus(provider, catalog, "a")).toBe("current");
    expect(
      catalogDisplayStatus(
        provider,
        {
          ...catalog,
          syncStates: [
            ...catalog.syncStates,
            {
              ...catalog.syncStates[0]!,
              id: "failed",
              status: "failed",
            },
          ],
        },
        "a",
      ),
    ).toBe("stale");
    expect(
      formatCatalogAge("2026-08-14T00:00:00.000Z", Date.UTC(2026, 7, 14, 2)),
    ).toBe("2h ago");
  });
});
