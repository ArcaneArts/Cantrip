import type { ModelRuntime } from "../src/db/repository.js";
import {
  prepareRuntimesForReasoning,
  reasoningStateForRuntimes,
} from "../src/models/reasoning.js";
import { describe, expect, it } from "vitest";

function runtime(
  routeId: string,
  efforts: string[],
  options: { mandatory?: boolean; legacyEffort?: string | null } = {},
): ModelRuntime {
  return {
    routeId,
    model: {
      id: "model",
      profileName: "Logical model",
      routeId,
      name: routeId,
      reasoningEffort: options.legacyEffort ?? null,
      providerModelId: `native-${routeId}`,
      catalog: {
        id: `native-${routeId}`,
        providerId: `provider-${routeId}`,
        nativeModelId: routeId,
        canonicalModelId: null,
        displayName: routeId,
        description: null,
        contextWindow: 128_000,
        maxOutputTokens: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsTools: true,
        supportsParallelTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsReasoning: efforts.length > 0,
        supportedReasoningEfforts: efforts.map((effort) => ({
          effort,
          description: `${effort} effort`,
        })),
        defaultReasoningEffort: efforts[0] ?? null,
        reasoningMandatory: options.mandatory ?? false,
        family: null,
        parameterSize: null,
        quantization: null,
        digest: null,
        metadataSource: "codex",
        matchConfidence: 1,
        hidden: false,
        isDefault: false,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        lastSeenAt: "2026-08-14T00:00:00.000Z",
      },
    },
    provider: {
      id: `provider-${routeId}`,
      name: routeId,
      kind: "chatgpt",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      protectedApiKey: null,
      accountId: `account-${routeId}`,
      credentialHomeKey: `home-${routeId}`,
      weeklyUsageReservePercent: 3,
    },
  };
}

describe("model reasoning", () => {
  it("advertises only the safe intersection across eligible routes", () => {
    expect(
      reasoningStateForRuntimes("model", "high", [
        runtime("primary", ["low", "medium", "high"]),
        runtime("fallback", ["medium", "high", "xhigh"]),
      ]),
    ).toMatchObject({
      reasoningEffort: "high",
      options: [
        { effort: "medium", description: "medium effort" },
        { effort: "high", description: "high effort" },
      ],
    });
  });

  it("resets unsupported preferences to provider default", () => {
    expect(
      reasoningStateForRuntimes("model", "ultra", [
        runtime("primary", ["low", "medium"]),
      ]).reasoningEffort,
    ).toBeNull();
  });

  it("prefers exact routes and records provider-default fallback", () => {
    const prepared = prepareRuntimesForReasoning(
      [
        runtime("fallback", ["low", "medium"]),
        runtime("exact", ["low", "high"]),
      ],
      "high",
    );
    expect(
      prepared.map(({ adjusted, appliedReasoningEffort, runtime }) => ({
        routeId: runtime.routeId,
        effort: runtime.model.reasoningEffort,
        appliedReasoningEffort,
        adjusted,
      })),
    ).toEqual([
      {
        routeId: "exact",
        effort: "high",
        appliedReasoningEffort: "high",
        adjusted: false,
      },
      {
        routeId: "fallback",
        effort: null,
        appliedReasoningEffort: null,
        adjusted: true,
      },
    ]);
  });

  it("does not invent selectable levels for generic reasoning support", () => {
    expect(
      reasoningStateForRuntimes("model", null, [runtime("ollama", [])]),
    ).toMatchObject({ options: [], reasoningEffort: null });
  });
});
