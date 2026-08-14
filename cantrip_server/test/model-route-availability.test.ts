import type {
  ProviderModelAvailability,
  ProviderModelCatalogEntry,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type { ModelRuntime } from "../src/db/repository.js";
import {
  chatGptAccountSupportsModel,
  evaluateModelRouteAvailability,
} from "../src/models/model-route-availability.js";

function runtime(
  kind: ModelRuntime["provider"]["kind"],
  options: { apiKey?: string | null; baseUrl?: string } = {},
): ModelRuntime {
  return {
    routeId: "route-1",
    model: {
      id: "model-1",
      profileName: "Model",
      routeId: "route-1",
      name: "native-model",
      reasoningEffort: null,
      providerModelId: "provider-model-1",
      catalog: {} as ProviderModelCatalogEntry,
    },
    provider: {
      id: "provider-1",
      name: "Provider",
      kind,
      baseUrl: options.baseUrl ?? "http://127.0.0.1:11434/v1",
      apiKey: options.apiKey ?? null,
      accountId: null,
      credentialHomeKey: null,
      weeklyUsageReservePercent: 3,
    },
  };
}

function availability(
  scopeKey: string,
  workerId: string | null,
  state: ProviderModelAvailability["state"] = "available",
): ProviderModelAvailability {
  return {
    id: `${scopeKey}:${workerId}`,
    providerModelId: "provider-model-1",
    scopeKey,
    workerId,
    providerAccountId: null,
    state,
    lastSeenAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

describe("model route availability", () => {
  it("keeps Ollama inventories isolated by worker", () => {
    const entries = [
      availability("worker:a", "a"),
      availability("worker:b", "b", "unavailable"),
    ];
    expect(
      evaluateModelRouteAvailability(runtime("ollama"), entries, "a").available,
    ).toBe(true);
    expect(
      evaluateModelRouteAvailability(runtime("ollama"), entries, "b").available,
    ).toBe(false);
    expect(
      evaluateModelRouteAvailability(runtime("ollama"), entries, "c").available,
    ).toBe(false);
  });

  it("uses account-specific OpenRouter availability when an API key exists", () => {
    const entries = [
      availability("openrouter:global", null),
      availability("openrouter:user", null, "unavailable"),
    ];
    const result = evaluateModelRouteAvailability(
      runtime("openai-compatible", {
        apiKey: "secret",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      entries,
      "worker-1",
    );
    expect(result.available).toBe(false);
  });

  it("retains custom IDs for providers without authoritative inventory", () => {
    const custom = runtime("openai-compatible", {
      baseUrl: "https://compatible.example/v1",
    });
    custom.model.providerModelId = null;
    expect(evaluateModelRouteAvailability(custom, [], "worker-1")).toEqual({
      available: true,
      reason: null,
    });
  });

  it("requires discovered ChatGPT models on the selected account and worker", () => {
    expect(chatGptAccountSupportsModel("provider-model-1", "available")).toBe(
      true,
    );
    expect(chatGptAccountSupportsModel("provider-model-1", "unavailable")).toBe(
      false,
    );
    expect(chatGptAccountSupportsModel("provider-model-1", null)).toBe(false);
    expect(chatGptAccountSupportsModel(null, null)).toBe(true);
  });
});
