import type {
  ModelConfiguration,
  ModelConfigurationFailure,
  ModelConfigurationFailureCode,
} from "@cantrip/protocol";

import type { ModelRuntime } from "../db/repository.js";
import {
  prepareRuntimesForReasoning,
  type PreparedReasoningRuntime,
} from "./reasoning.js";

export class ModelConfigurationResolutionError extends Error {
  readonly failure: ModelConfigurationFailure;

  constructor(failure: ModelConfigurationFailure) {
    super(failure.error);
    this.name = "ModelConfigurationResolutionError";
    this.failure = failure;
  }
}

export interface ResolvedModelRoutePair {
  root: PreparedReasoningRuntime;
  subagent: PreparedReasoningRuntime | null;
}

type ConfigurationField = ModelConfigurationFailure["field"];

function fail(
  code: ModelConfigurationFailureCode,
  error: string,
  field: ConfigurationField,
  retryable = false,
): never {
  throw new ModelConfigurationResolutionError({
    code,
    error,
    field,
    retryable,
  });
}

function exactReasoningRuntimes(
  runtimes: ModelRuntime[],
  requested: string | null,
  role: "root" | "subagent",
): PreparedReasoningRuntime[] {
  const prepared = prepareRuntimesForReasoning(runtimes, requested);
  const exact = prepared.filter(({ adjusted }) => !adjusted);
  if (requested !== null && exact.length === 0) {
    fail(
      role === "root"
        ? "root-reasoning-unsupported"
        : "subagent-reasoning-unsupported",
      role === "root"
        ? `The selected root model does not support ${requested} reasoning on an available route.`
        : `The selected subagent model does not support ${requested} reasoning on a route compatible with the root model.`,
      role === "root" ? "reasoningEffort" : "subagentReasoningEffort",
    );
  }
  return exact;
}

export function sameProviderIdentity(
  root: ModelRuntime,
  subagent: ModelRuntime,
): boolean {
  return (
    root.provider.id === subagent.provider.id &&
    root.provider.accountId === subagent.provider.accountId
  );
}

export function resolveModelRoutePairs(input: {
  configuration: ModelConfiguration;
  rootRuntimes: ModelRuntime[];
  subagentRuntimes?: ModelRuntime[];
  workerConnected?: boolean;
}): ResolvedModelRoutePair[] {
  if (input.workerConnected === false) {
    fail(
      "worker-offline",
      "The project worker is offline. Reconnect it before changing or using this model configuration.",
      null,
      true,
    );
  }
  if (!input.configuration.modelId || input.rootRuntimes.length === 0) {
    fail(
      "root-model-unavailable",
      "The selected root model has no route available on this worker.",
      "modelId",
      true,
    );
  }

  if (!input.configuration.customSubagentModel) {
    const roots = exactReasoningRuntimes(
      input.rootRuntimes,
      input.configuration.reasoningEffort,
      "root",
    );
    return roots.map((root) => ({ root, subagent: null }));
  }

  if (!input.configuration.subagentModelId || !input.subagentRuntimes?.length) {
    fail(
      "subagent-model-unavailable",
      "The selected subagent model has no route available on this worker.",
      "subagentModelId",
      true,
    );
  }
  const topologyPairs = input.rootRuntimes.flatMap((root) => {
    const subagent = input.subagentRuntimes!.find((candidate) =>
      sameProviderIdentity(root, candidate),
    );
    return subagent ? [{ root, subagent }] : [];
  });
  if (topologyPairs.length === 0) {
    fail(
      "provider-route-incompatible",
      "The selected root and subagent models do not share an available provider route and account. Choose models served by the same provider identity.",
      "subagentModelId",
    );
  }

  const roots = exactReasoningRuntimes(
    input.rootRuntimes,
    input.configuration.reasoningEffort,
    "root",
  );
  const rootByRoute = new Map(
    roots.map((root) => [root.runtime.routeId, root]),
  );
  const rootCompatiblePairs = topologyPairs.flatMap((pair) => {
    const root = rootByRoute.get(pair.root.routeId);
    return root ? [{ root, subagent: pair.subagent }] : [];
  });
  if (rootCompatiblePairs.length === 0) {
    fail(
      "root-reasoning-unsupported",
      `The selected root reasoning effort is not supported on a route compatible with the subagent model.`,
      "reasoningEffort",
    );
  }

  const subagents = exactReasoningRuntimes(
    input.subagentRuntimes,
    input.configuration.subagentReasoningEffort,
    "subagent",
  );
  const subagentByRoute = new Map(
    subagents.map((subagent) => [subagent.runtime.routeId, subagent]),
  );
  const pairs = rootCompatiblePairs.flatMap((pair) => {
    const subagent = subagentByRoute.get(pair.subagent.routeId);
    return subagent ? [{ root: pair.root, subagent }] : [];
  });
  if (pairs.length === 0) {
    fail(
      "subagent-reasoning-unsupported",
      `The selected subagent reasoning effort is not supported on a route compatible with the root model.`,
      "subagentReasoningEffort",
    );
  }
  return pairs;
}

export function modelConfigurationFailure(
  error: unknown,
): ModelConfigurationFailure | null {
  return error instanceof ModelConfigurationResolutionError
    ? error.failure
    : null;
}
