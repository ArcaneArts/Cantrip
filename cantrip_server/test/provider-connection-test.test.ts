import { describe, expect, it } from "vitest";

import {
  providerConnectionFailureMessage,
  providerConnectionFailureStage,
} from "../src/models/provider-connection-test.js";

describe("provider connection test diagnostics", () => {
  it("identifies endpoint providers without subscription-specific instructions", () => {
    expect(
      providerConnectionFailureMessage(
        "key-authentication",
        "HTTP 401",
        "LM Studio",
      ),
    ).toBe("LM Studio rejected authentication. HTTP 401.");
  });
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

  it("adds a stage-specific explanation and safe HTTP status", () => {
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
    ).toContain("HTTP 401");
  });

  it("keeps credentials and response bodies out of diagnostics", () => {
    const message = providerConnectionFailureMessage(
      "provider-response",
      "HTTP 500 at https://private:secret@host/v1?key=secret body=private-response",
      "vLLM",
    );
    expect(message).toBe(
      "vLLM returned an unsuccessful provider response. HTTP 500.",
    );
    expect(message).not.toContain("private");
    expect(message).not.toContain("secret");
  });
});
