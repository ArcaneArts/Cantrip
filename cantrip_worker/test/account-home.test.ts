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
});
