import type { ProviderModelCatalogResult } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setClientSession } from "@/lib/client-session";
import {
  cachedProviderModelCatalog,
  cacheProviderModelCatalog,
} from "./provider-catalog-cache";
import { useProviderCatalog } from "./use-provider-catalog";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
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

function signIn(userId: string) {
  setClientSession({
    authMode: "none",
    csrfToken: null,
    expiresAt: null,
    serverId: "server-1",
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
  beforeEach(() => {
    const localStorage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    signIn("user-1");
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
  });

  it("ignores catalogs that do not belong to the provider key", () => {
    cacheProviderModelCatalog("provider-2", "worker-1", catalog);

    expect(
      cachedProviderModelCatalog("provider-2", "worker-1"),
    ).toBeUndefined();
  });
});
