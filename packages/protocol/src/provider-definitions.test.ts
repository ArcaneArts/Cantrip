import { describe, expect, it } from "vitest";

import {
  modelProviderKindSchema,
  normalizeResponsesBaseUrl,
} from "./providers.js";
import {
  isAccountProviderKind,
  modelProviderKinds,
  providerDefinitions,
  providerUsesChatCompletions,
} from "./provider-definitions.js";

describe("provider instance policy", () => {
  it("keeps endpoint providers repeatable and account containers singleton", () => {
    for (const kind of modelProviderKinds) {
      expect(modelProviderKindSchema.parse(kind)).toBe(kind);
      expect(providerDefinitions[kind].multipleInstances).toBe(
        !isAccountProviderKind(kind),
      );
      expect(providerUsesChatCompletions(kind)).toBe(kind === "mlx-lm");
    }
  });
});

describe("provider API roots", () => {
  it.each([
    [
      "http://[::1]:8080/proxy/v1/responses///?debug=1#fragment",
      "http://[::1]:8080/proxy/v1",
    ],
    [
      "https://gpu.lan:9443/inference/v1/chat/completions/",
      "https://gpu.lan:9443/inference/v1",
    ],
    [
      "http://192.168.1.4:8000/custom/v1///",
      "http://192.168.1.4:8000/custom/v1",
    ],
    [
      "https://gateway.example/models/model-name",
      "https://gateway.example/models/model-name",
    ],
    ["https://openrouter.ai", "https://openrouter.ai/api/v1"],
  ])("normalizes %s without losing its routing prefix", (input, expected) => {
    expect(normalizeResponsesBaseUrl(input)).toBe(expected);
    expect(normalizeResponsesBaseUrl(expected)).toBe(expected);
  });
});
