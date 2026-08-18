import { describe, expect, it } from "vitest";

import {
  providerConnectionFailureMessage,
  providerConnectionFailureStage,
} from "../src/models/provider-connection-test.js";

describe("provider connection test diagnostics", () => {
  it.each([
    ["Worker desktop-1 is offline.", "worker-placement"],
    ["Codex app-server exited before listening (code 1).", "codex-startup"],
    ["unexpected status 401 Unauthorized", "key-authentication"],
    [
      "unexpected status 404 Not Found at responses endpoint",
      "endpoint-compatibility",
    ],
    ["model not found: glm-missing", "model-availability"],
    ["unexpected status 429 Too Many Requests", "provider-response"],
  ] as const)("classifies %s", (message, stage) => {
    expect(providerConnectionFailureStage(message)).toBe(stage);
  });

  it("adds a stage-specific explanation without hiding the provider detail", () => {
    expect(
      providerConnectionFailureMessage(
        "key-authentication",
        "unexpected status 401 Unauthorized",
      ),
    ).toContain("Z.ai rejected the Coding Plan API key");
    expect(
      providerConnectionFailureMessage(
        "key-authentication",
        "unexpected status 401 Unauthorized",
      ),
    ).toContain("401 Unauthorized");
  });
});
