import { describe, expect, it } from "vitest";

import type { ModelRuntime } from "../src/db/repository.js";
import {
  ModelConfigurationResolutionError,
  resolveModelRoutePairs,
} from "../src/models/subagent-routing.js";

function runtime(input: {
  accountId?: string | null;
  modelId: string;
  providerId: string;
  routeId: string;
}): ModelRuntime {
  return {
    routeId: input.routeId,
    model: {
      id: input.modelId,
      profileName: input.modelId,
      routeId: input.routeId,
      name: `${input.modelId}-native`,
      reasoningEffort: null,
      providerModelId: null,
      catalog: null,
    },
    provider: {
      id: input.providerId,
      name: input.providerId,
      kind: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      protectedApiKey: null,
      accountId: input.accountId ?? null,
      credentialHomeKey: null,
      weeklyUsageReservePercent: 5,
    },
  };
}

const inheritedConfiguration = {
  modelId: "root",
  reasoningEffort: null,
  customSubagentModel: false,
  subagentModelId: "inactive-child",
  subagentReasoningEffort: "high",
} as const;

describe("subagent route pairing", () => {
  it("keeps native inheritance when custom child configuration is inactive", () => {
    const root = runtime({
      modelId: "root",
      providerId: "provider-a",
      routeId: "root-a",
    });

    expect(
      resolveModelRoutePairs({
        configuration: inheritedConfiguration,
        rootRuntimes: [root],
        subagentRuntimes: [],
      }),
    ).toEqual([
      { root: expect.objectContaining({ runtime: root }), subagent: null },
    ]);
  });

  it("pairs a custom child on the exact provider and account identity", () => {
    const root = runtime({
      accountId: "account-one",
      modelId: "root",
      providerId: "provider-a",
      routeId: "root-a",
    });
    const child = runtime({
      accountId: "account-one",
      modelId: "child",
      providerId: "provider-a",
      routeId: "child-a",
    });

    const [pair] = resolveModelRoutePairs({
      configuration: {
        ...inheritedConfiguration,
        customSubagentModel: true,
        subagentModelId: "child",
        subagentReasoningEffort: null,
      },
      rootRuntimes: [root],
      subagentRuntimes: [child],
    });

    expect(pair?.root.runtime.routeId).toBe("root-a");
    expect(pair?.subagent?.runtime.routeId).toBe("child-a");
  });

  it("rejects cross-provider and cross-account custom children", () => {
    const root = runtime({
      accountId: "account-one",
      modelId: "root",
      providerId: "provider-a",
      routeId: "root-a",
    });
    const children = [
      runtime({
        accountId: "account-two",
        modelId: "child",
        providerId: "provider-a",
        routeId: "child-other-account",
      }),
      runtime({
        modelId: "child",
        providerId: "provider-b",
        routeId: "child-other-provider",
      }),
    ];

    expect(() =>
      resolveModelRoutePairs({
        configuration: {
          ...inheritedConfiguration,
          customSubagentModel: true,
          subagentModelId: "child",
          subagentReasoningEffort: null,
        },
        rootRuntimes: [root],
        subagentRuntimes: children,
      }),
    ).toThrowError(
      expect.objectContaining<ModelConfigurationResolutionError>({
        failure: expect.objectContaining({
          code: "provider-route-incompatible",
        }),
      }),
    );
  });

  it("returns actionable failures for stale workers and unsupported reasoning", () => {
    const root = runtime({
      modelId: "root",
      providerId: "provider-a",
      routeId: "root-a",
    });

    for (const [workerConnected, reasoningEffort, code] of [
      [false, null, "worker-offline"],
      [true, "high", "root-reasoning-unsupported"],
    ] as const) {
      try {
        resolveModelRoutePairs({
          configuration: {
            ...inheritedConfiguration,
            reasoningEffort,
          },
          rootRuntimes: [root],
          workerConnected,
        });
        throw new Error("Expected route pairing to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelConfigurationResolutionError);
        expect(
          (error as ModelConfigurationResolutionError).failure,
        ).toMatchObject({ code });
      }
    }
  });
});
