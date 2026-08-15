import path from "node:path";

import { describe, expect, it } from "vitest";

import { codexAccountHome } from "../src/codex/account-home.js";
import { codexRuntimeId } from "../src/codex/app-server.js";

describe("ChatGPT account homes", () => {
  it("isolates credentials by provider without exposing its id as a path", () => {
    const first = codexAccountHome("/worker", "personal-account");
    const second = codexAccountHome("/worker", "work-account");

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.join("/worker", "codex-accounts"));
    expect(path.basename(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("personal-account");
  });

  it("isolates app-server runtimes for accounts under one provider", () => {
    const model = {
      id: "logical-model",
      routeId: "provider-route",
      name: "gpt-test",
      reasoningEffort: null,
    };
    const provider = {
      id: "chatgpt-provider",
      name: "ChatGPT",
      kind: "chatgpt" as const,
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: null,
      accountId: "personal-account",
      credentialHomeKey: "personal-home",
    };

    expect(codexRuntimeId(model, provider)).not.toBe(
      codexRuntimeId(model, {
        ...provider,
        accountId: "work-account",
        credentialHomeKey: "work-home",
      }),
    );
  });

  it("reuses one app-server writer when reasoning effort changes", () => {
    const provider = {
      id: "chatgpt-provider",
      name: "ChatGPT",
      kind: "chatgpt" as const,
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: null,
      accountId: "personal-account",
      credentialHomeKey: "personal-home",
    };
    const model = {
      id: "logical-model",
      routeId: "provider-route",
      name: "gpt-test",
      reasoningEffort: "medium" as const,
    };

    expect(codexRuntimeId(model, provider)).toBe(
      codexRuntimeId({ ...model, reasoningEffort: "high" }, provider),
    );
  });

  it("restarts a custom-provider runtime when managed metadata changes", () => {
    const provider = {
      id: "ollama-provider",
      name: "Ollama",
      kind: "ollama" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: null,
      accountId: null,
      credentialHomeKey: null,
    };
    const model = {
      id: "logical-model",
      routeId: "provider-route",
      name: "gemma4:12b",
      reasoningEffort: null,
      catalog: null,
    };
    expect(codexRuntimeId(model, provider)).not.toBe(
      codexRuntimeId(
        {
          ...model,
          catalog: {
            nativeModelId: "gemma4:12b",
            displayName: "Gemma 4",
            description: null,
            contextWindow: 131_072,
            maxOutputTokens: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            supportsTools: true,
            supportsParallelTools: null,
            supportsStructuredOutput: null,
            supportsVision: false,
            supportsReasoning: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            reasoningMandatory: null,
            metadataSource: "ollama" as const,
          },
        },
        provider,
      ),
    );
  });
});
