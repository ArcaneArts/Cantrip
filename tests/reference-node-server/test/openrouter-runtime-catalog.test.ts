import { describe, expect, it, vi } from "vitest";

import type { ModelRuntime } from "../src/db/repository.js";
import { OpenRouterRuntimeCatalogHydrator } from "../src/models/openrouter-runtime-catalog.js";

function runtime(input: {
  baseUrl?: string;
  id: string;
  kind?: ModelRuntime["provider"]["kind"];
}): ModelRuntime {
  return {
    routeId: `route-${input.id}`,
    model: {
      id: `model-${input.id}`,
      profileName: input.id,
      routeId: `route-${input.id}`,
      name: input.id,
      reasoningEffort: null,
      providerModelId: null,
      catalog: null,
    },
    provider: {
      id: input.id,
      name: input.id,
      kind: input.kind ?? "openai-compatible",
      baseUrl: input.baseUrl ?? "https://openrouter.ai/api/v1",
      protectedApiKey: null,
      accountId: null,
      credentialHomeKey: null,
      weeklyUsageReservePercent: 3,
    },
  };
}

describe("OpenRouter runtime catalog hydration", () => {
  it("loads each OpenRouter provider once and can be invalidated", async () => {
    const load = vi.fn(async () => true);
    const hydrator = new OpenRouterRuntimeCatalogHydrator(load);
    const runtimes = [runtime({ id: "router" }), runtime({ id: "router" })];

    await expect(
      Promise.all([hydrator.hydrate(runtimes), hydrator.hydrate(runtimes)]),
    ).resolves.toEqual([true, true]);
    expect(load).toHaveBeenCalledTimes(1);

    await expect(hydrator.hydrate(runtimes)).resolves.toBe(false);
    hydrator.invalidate("router");
    await expect(hydrator.hydrate(runtimes)).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores compatible endpoints that are not OpenRouter", async () => {
    const load = vi.fn(async () => true);
    const hydrator = new OpenRouterRuntimeCatalogHydrator(load);

    await expect(
      hydrator.hydrate([
        runtime({ id: "custom", baseUrl: "https://example.com/v1" }),
        runtime({ id: "ollama", kind: "ollama" }),
      ]),
    ).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("retries a provider when catalog loading fails", async () => {
    const load = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const hydrator = new OpenRouterRuntimeCatalogHydrator(load);
    const runtimes = [runtime({ id: "router" })];

    await expect(hydrator.hydrate(runtimes)).resolves.toBe(false);
    await expect(hydrator.hydrate(runtimes)).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
