import { describe, expect, it } from "vitest";

import { canRefreshProviderOnWorker } from "../src/models/account-provider.js";

const workerWithGrants = (...components: string[]) => ({
  encryption: {
    grants: components.map((component) => ({ component })),
  },
});

describe("account provider worker refresh authorization", () => {
  it("allows local Ollama discovery without a provider credential grant", () => {
    expect(canRefreshProviderOnWorker("ollama", null)).toBe(true);
  });

  it("skips account provider refreshes until the worker is authorized", () => {
    expect(canRefreshProviderOnWorker("chatgpt", undefined)).toBe(false);
    expect(
      canRefreshProviderOnWorker("grok", workerWithGrants("mcp-secret")),
    ).toBe(false);
  });

  it("allows account provider refreshes with the provider credential grant", () => {
    const worker = workerWithGrants("mcp-secret", "provider-credential");

    expect(canRefreshProviderOnWorker("chatgpt", worker)).toBe(true);
    expect(canRefreshProviderOnWorker("grok", worker)).toBe(true);
    expect(canRefreshProviderOnWorker("openrouter", worker)).toBe(false);
  });
});
