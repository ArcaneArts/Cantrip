import type { ProviderModelCatalogResult } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scopedClientStorageKey, setClientSession } from "@/lib/client-session";
import {
  cachedProviderModelCatalog,
  cacheProviderModelCatalog,
} from "./provider-catalog-cache";
import {
  providerCatalogQueryOptions,
  useProviderCatalog,
} from "./use-provider-catalog";

class MemoryStorage implements Storage {
  readonly #values: Map<string, string>;
  getItemCalls = 0;
  setItemCalls = 0;

  constructor(values?: Map<string, string>) {
    this.#values = new Map(values);
  }

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    this.getItemCalls += 1;
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.setItemCalls += 1;
    this.#values.set(key, value);
  }

  snapshot(): Map<string, string> {
    return new Map(this.#values);
  }
}

const catalog = {
  providerId: "provider-1",
  models: [
    {
      id: "model-1",
      providerId: "provider-1",
      nativeModelId: "gemma4:26b",
      canonicalModelId: null,
      displayName: "gemma4:26b",
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsReasoning: false,
      supportsTools: true,
      supportsParallelTools: null,
      supportsVision: false,
      supportsStructuredOutput: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      reasoningMandatory: null,
      family: "gemma4",
      parameterSize: "26B",
      quantization: null,
      digest: null,
      metadataSource: "ollama",
      matchConfidence: null,
      hidden: false,
      isDefault: false,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      lastSeenAt: "2026-08-18T00:00:00.000Z",
    },
  ],
  availability: [
    {
      id: "availability-1",
      providerModelId: "model-1",
      scopeKey: "worker:worker-1",
      workerId: "worker-1",
      providerAccountId: null,
      state: "available",
      lastSeenAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    },
  ],
  syncStates: [],
  servedStale: false,
} satisfies ProviderModelCatalogResult;

function signIn(userId: string, serverId = "server-1") {
  setClientSession({
    authMode: "none",
    csrfToken: null,
    expiresAt: null,
    serverId,
    user: {
      id: userId,
      kind: "account",
      displayName: userId,
      email: null,
      role: "owner",
    },
  });
}

describe("provider model catalog cache", () => {
  let localStorage: MemoryStorage;

  beforeEach(() => {
    localStorage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    signIn("user-1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the available model list for the matching worker", () => {
    cacheProviderModelCatalog("provider-1", "worker-1", catalog);

    expect(cachedProviderModelCatalog("provider-1", "worker-1")).toEqual(
      catalog,
    );
    expect(
      cachedProviderModelCatalog("provider-1", "worker-2"),
    ).toBeUndefined();
  });

  it("renders cached models as placeholder data before live discovery completes", () => {
    cacheProviderModelCatalog("provider-1", "worker-1", catalog);
    const Probe = () => {
      const query = useProviderCatalog("provider-1", "worker-1", true);
      return createElement(
        "span",
        { "data-source": query.isPlaceholderData ? "cached" : "live" },
        query.data?.models.map(({ nativeModelId }) => nativeModelId).join(","),
      );
    };

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Probe),
      ),
    );

    expect(markup).toContain('data-source="cached"');
    expect(markup).toContain("gemma4:26b");
  });

  it("keeps cached account catalogs isolated by signed-in user", () => {
    cacheProviderModelCatalog("provider-1", "worker-1", catalog);
    signIn("user-2");

    expect(
      cachedProviderModelCatalog("provider-1", "worker-1"),
    ).toBeUndefined();

    signIn("user-1");
    expect(cachedProviderModelCatalog("provider-1", "worker-1")).toEqual(
      catalog,
    );
  });

  it("keeps cached account catalogs isolated by server", () => {
    cacheProviderModelCatalog("provider-1", "worker-1", catalog);
    signIn("user-1", "server-2");

    expect(
      cachedProviderModelCatalog("provider-1", "worker-1"),
    ).toBeUndefined();
  });

  it("ignores catalogs that do not belong to the provider key", () => {
    cacheProviderModelCatalog("provider-2", "worker-1", catalog);

    expect(
      cachedProviderModelCatalog("provider-2", "worker-1"),
    ).toBeUndefined();
  });

  it("does not hydrate disabled queries and hydrates an enabled scope once", () => {
    const largeCatalog = {
      ...catalog,
      models: Array.from({ length: 140 }, (_, index) => ({
        ...catalog.models[0]!,
        id: `model-${index}`,
        nativeModelId: `model-${index}`,
        displayName: `Model ${index}`,
        description: "x".repeat(20_000),
      })),
    } satisfies ProviderModelCatalogResult;
    cacheProviderModelCatalog("provider-1", "worker-1", largeCatalog);
    const storedValue = [...localStorage.snapshot().values()][0]!;
    expect(storedValue.length).toBeGreaterThan(2_700_000);
    expect(storedValue.length).toBeLessThanOrEqual(3_000_000);

    localStorage = new MemoryStorage(localStorage.snapshot());
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    for (let index = 0; index < 100; index += 1) {
      providerCatalogQueryOptions("provider-1", "worker-1", false);
      providerCatalogQueryOptions("provider-2", "worker-1", false);
    }
    expect(localStorage.getItemCalls).toBe(0);

    expect(
      providerCatalogQueryOptions("provider-1", "worker-1", true)
        .placeholderData?.models,
    ).toHaveLength(140);
    providerCatalogQueryOptions("provider-1", "worker-1", true);
    expect(localStorage.getItemCalls).toBe(1);
  });

  it("expires hydrated entries without rereading storage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    cacheProviderModelCatalog("provider-1", "worker-1", catalog);
    expect(cachedProviderModelCatalog("provider-1", "worker-1")).toEqual(
      catalog,
    );
    const readsAfterHydration = localStorage.getItemCalls;

    vi.advanceTimersByTime(30 * 24 * 60 * 60_000 + 1);

    expect(
      cachedProviderModelCatalog("provider-1", "worker-1"),
    ).toBeUndefined();
    expect(localStorage.getItemCalls).toBe(readsAfterHydration);
  });

  it("hydrates corrupt storage once and remains fail-closed", () => {
    localStorage.setItem(
      scopedClientStorageKey("cantrip.provider-model-catalogs.v1"),
      "{invalid-json",
    );
    localStorage.getItemCalls = 0;

    expect(
      cachedProviderModelCatalog("provider-1", "worker-1"),
    ).toBeUndefined();
    expect(
      cachedProviderModelCatalog("provider-1", "worker-1"),
    ).toBeUndefined();
    expect(localStorage.getItemCalls).toBe(1);
  });

  it("skips an identical persistence write", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));

    cacheProviderModelCatalog("provider-1", "worker-1", catalog);
    cacheProviderModelCatalog("provider-1", "worker-1", catalog);

    expect(localStorage.setItemCalls).toBe(1);
  });
});
