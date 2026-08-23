import type { WorkerCommand } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { codexProviderConfiguration } from "../src/codex/provider-config.js";

type TurnProvider = Extract<WorkerCommand, { type: "chat.turn" }>["provider"];

function provider(
  kind: TurnProvider["kind"],
  overrides: Partial<TurnProvider> = {},
): TurnProvider {
  return {
    id: `provider-${kind}`,
    name: kind,
    kind,
    baseUrl: "https://provider.example/v1",
    apiKey: null,
    accountId: null,
    credentialHomeKey: null,
    ...overrides,
  } as TurnProvider;
}

describe("Codex provider configuration", () => {
  it("disables Fast mode for every Cantrip-managed runtime", () => {
    for (const kind of [
      "chatgpt",
      "ollama",
      "openai-compatible",
      "grok",
    ] as const) {
      const arguments_ = codexProviderConfiguration(provider(kind)).arguments;
      expect(arguments_).toContain("features.fast_mode=false");
      expect(arguments_).toContain("features.multi_agent=true");
      expect(arguments_).toContain("agents.enabled=true");
      expect(arguments_.join(" ")).not.toContain("service_tier=");
    }
  });

  it("configures canonical Z.ai providers through an environment-backed Responses transport", () => {
    const configuration = codexProviderConfiguration(
      provider("openai-compatible", {
        name: "Legacy GLM provider",
        baseUrl: "https://api.z.ai/api/v1/responses",
        apiKey: "zai-secret",
      }),
    );
    expect(configuration.arguments).toEqual(
      expect.arrayContaining([
        'model_provider="cantrip_runtime"',
        'model_providers.cantrip_runtime.name="Z.ai Coding Plan"',
        'model_providers.cantrip_runtime.base_url="https://api.z.ai/api/v1"',
        'model_providers.cantrip_runtime.env_key="CANTRIP_PROVIDER_API_KEY"',
        'model_providers.cantrip_runtime.wire_api="responses"',
      ]),
    );
    expect(configuration.arguments.join(" ")).not.toContain(
      "experimental_bearer_token",
    );
    expect(configuration.arguments.join(" ")).not.toContain("zai-secret");
    expect(configuration.environment).toEqual({
      CANTRIP_PROVIDER_API_KEY: "zai-secret",
    });
  });

  it("disables Codex web search for SuperGrok compatibility", () => {
    expect(codexProviderConfiguration(provider("grok")).arguments).toContain(
      'web_search="disabled"',
    );
  });

  it("preserves native search behavior for ChatGPT accounts", () => {
    expect(
      codexProviderConfiguration(provider("chatgpt")).arguments,
    ).not.toContain('web_search="disabled"');
  });

  it("does not disable search for generic Responses-compatible providers", () => {
    expect(
      codexProviderConfiguration(provider("openai-compatible")).arguments,
    ).not.toContain('web_search="disabled"');
  });
});
