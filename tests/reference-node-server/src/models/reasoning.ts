import type {
  ChatReasoningOption,
  ChatReasoningState,
  ReasoningEffort,
} from "@cantrip/protocol";

import type { ModelRuntime } from "../db/repository.js";

export interface PreparedReasoningRuntime {
  adjusted: boolean;
  appliedReasoningEffort: ReasoningEffort | null;
  runtime: ModelRuntime;
}

function advertisedOptions(runtime: ModelRuntime): ChatReasoningOption[] {
  return runtime.model.catalog?.supportedReasoningEfforts ?? [];
}

function supportsEffort(
  runtime: ModelRuntime,
  effort: ReasoningEffort,
): boolean {
  const catalog = runtime.model.catalog;
  if (!catalog) return false;
  return catalog.supportedReasoningEfforts.some(
    (option) => option.effort === effort,
  );
}

export function reasoningStateForRuntimes(
  modelId: string,
  reasoningEffort: ReasoningEffort | null,
  runtimes: ModelRuntime[],
): ChatReasoningState {
  const firstOptions = runtimes[0] ? advertisedOptions(runtimes[0]) : [];
  const options = firstOptions.filter((option) =>
    runtimes.every((runtime) =>
      advertisedOptions(runtime).some(
        (candidate) => candidate.effort === option.effort,
      ),
    ),
  );
  const supported = new Set(options.map(({ effort }) => effort));
  return {
    modelId,
    reasoningEffort:
      reasoningEffort && supported.has(reasoningEffort)
        ? reasoningEffort
        : null,
    options,
    reasoningMandatory:
      runtimes.length > 0 &&
      runtimes.every(
        (runtime) => runtime.model.catalog?.reasoningMandatory === true,
      ),
    incompleteMetadata: runtimes.some(
      (runtime) =>
        !runtime.model.catalog ||
        runtime.model.catalog.supportsReasoning === null,
    ),
  };
}

/**
 * Returns every reasoning effort that can be selected by model
 * configuration routing. Unlike the per-turn state above, an effort is
 * valid when at least one available route supports it because configuration
 * routing can choose that exact route.
 */
export function configurationReasoningStateForRuntimes(
  modelId: string,
  reasoningEffort: ReasoningEffort | null,
  runtimes: ModelRuntime[],
): ChatReasoningState {
  const optionsByEffort = new Map<ReasoningEffort, ChatReasoningOption>();
  for (const runtime of runtimes) {
    for (const option of advertisedOptions(runtime)) {
      if (!optionsByEffort.has(option.effort)) {
        optionsByEffort.set(option.effort, option);
      }
    }
  }
  const options = [...optionsByEffort.values()];
  const supported = new Set(optionsByEffort.keys());
  return {
    modelId,
    reasoningEffort:
      reasoningEffort && supported.has(reasoningEffort)
        ? reasoningEffort
        : null,
    options,
    reasoningMandatory:
      runtimes.length > 0 &&
      runtimes.every(
        (runtime) => runtime.model.catalog?.reasoningMandatory === true,
      ),
    incompleteMetadata: runtimes.some(
      (runtime) =>
        !runtime.model.catalog ||
        runtime.model.catalog.supportsReasoning === null,
    ),
  };
}

export function prepareRuntimesForReasoning(
  runtimes: ModelRuntime[],
  requested: ReasoningEffort | null,
): PreparedReasoningRuntime[] {
  const prepared = runtimes.map((runtime) => {
    const exact = requested !== null && supportsEffort(runtime, requested);
    const appliedReasoningEffort = exact ? requested : null;
    return {
      adjusted: requested !== null && !exact,
      appliedReasoningEffort,
      runtime: {
        ...runtime,
        model: {
          ...runtime.model,
          // null deliberately delegates to the provider model's advertised
          // default. Model/profile defaults no longer leak into new turns.
          reasoningEffort: appliedReasoningEffort,
        },
      },
    };
  });
  if (requested === null) return prepared;
  return prepared.sort(
    (left, right) => Number(left.adjusted) - Number(right.adjusted),
  );
}
