import type { ProviderModelAvailability } from "@cantrip/protocol";

import type { ModelRuntime } from "../db/repository.js";
import { isAccountProviderKind } from "./account-provider.js";

export interface ModelRouteAvailabilityResult {
  available: boolean;
  reason: string | null;
}

function isOpenRouterRuntime(runtime: ModelRuntime) {
  try {
    return (
      runtime.provider.kind === "openai-compatible" &&
      new URL(runtime.provider.baseUrl).hostname.toLowerCase() ===
        "openrouter.ai"
    );
  } catch {
    return false;
  }
}

export function accountProviderSupportsModel(
  providerModelId: string | null,
  availability: ProviderModelAvailability["state"] | null,
) {
  // Explicit custom IDs have no catalog row to consult. Once a route is bound
  // to a discovered model, that provider-account scope is authoritative.
  return providerModelId === null || availability === "available";
}

export function evaluateModelRouteAvailability(
  runtime: ModelRuntime,
  availability: ProviderModelAvailability[],
  workerId: string,
): ModelRouteAvailabilityResult {
  if (
    runtime.model.providerModelId === null ||
    isAccountProviderKind(runtime.provider.kind)
  ) {
    return { available: true, reason: null };
  }

  if (runtime.provider.kind === "ollama") {
    const workerState = availability.find(
      (entry) => entry.workerId === workerId,
    )?.state;
    return workerState === "available"
      ? { available: true, reason: null }
      : {
          available: false,
          reason: `${runtime.model.name} is not available on this worker`,
        };
  }

  if (isOpenRouterRuntime(runtime)) {
    const scopeKey = runtime.provider.apiKey
      ? "openrouter:user"
      : "openrouter:global";
    const state = availability.find(
      (entry) => entry.scopeKey === scopeKey,
    )?.state;
    return state === "available"
      ? { available: true, reason: null }
      : {
          available: false,
          reason: `${runtime.model.name} is not available to this OpenRouter account`,
        };
  }

  // Compatible providers without a discovery service intentionally retain the
  // custom-ID escape hatch.
  return { available: true, reason: null };
}
