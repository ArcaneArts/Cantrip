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
