import { expect, it, vi } from "vitest";
import {
  createModelRoutingRuntime,
  type ModelRoutingRuntimeDependencies,
} from "../src/app/runtime/model-routing-runtime.js";
import { ModelSelectionRequiredError } from "../src/models/model-selection.js";
import type { ChatExecutionContext } from "../src/db/repository.js";

it.each([
  { selected: null, fallback: null, requested: undefined, expected: null },
  {
    selected: null,
    fallback: "default",
    requested: undefined,
    expected: "default",
  },
  {
    selected: "chosen",
    fallback: null,
    requested: undefined,
    expected: "chosen",
  },
  {
    selected: "chosen",
    fallback: null,
    requested: "requested",
    expected: "requested",
  },
])(
  "resolves model selection without treating missing setup as a runtime failure: %j",
  async ({ selected, fallback, requested, expected }) => {
    const settings = vi.fn(async () => ({ defaultModelId: fallback }));
    const routing = createModelRoutingRuntime({
      applicationOwnerId: () => "owner",
      repository: { getUserSettings: settings },
    } as unknown as ModelRoutingRuntimeDependencies);
    try {
      const result = routing.resolveModelId(
        { modelId: selected } as ChatExecutionContext,
        requested,
      );
      if (expected === null) {
        await expect(result).rejects.toBeInstanceOf(
          ModelSelectionRequiredError,
        );
      } else {
        await expect(result).resolves.toBe(expected);
      }
    } finally {
      routing.close();
    }
  },
);

it("does not classify a failed settings read as missing model setup", async () => {
  const failure = new Error("Settings unavailable");
  const routing = createModelRoutingRuntime({
    applicationOwnerId: () => "owner",
    repository: {
      getUserSettings: async () => {
        throw failure;
      },
    },
  } as unknown as ModelRoutingRuntimeDependencies);
  try {
    await expect(
      routing.resolveModelId({ modelId: null } as ChatExecutionContext),
    ).rejects.toBe(failure);
  } finally {
    routing.close();
  }
});

it("reports missing model setup from the actual session routing path without contacting providers", async () => {
  const routes = vi.fn();
  const routing = createModelRoutingRuntime({
    applicationOwnerId: () => "owner",
    repository: {
      getUserSettings: async () => ({ defaultModelId: null }),
      getModelRuntimes: routes,
    },
  } as unknown as ModelRoutingRuntimeDependencies);
  try {
    await expect(
      routing.runtimeForContext({
        modelRouteId: null,
        modelId: null,
      } as ChatExecutionContext),
    ).rejects.toBeInstanceOf(ModelSelectionRequiredError);
    expect(routes).not.toHaveBeenCalled();
  } finally {
    routing.close();
  }
});
