import type {
  InferenceProgressPhase,
  InferenceProgressPrecision,
  InferenceProgressSource,
} from "@cantrip/protocol";

import type { RuntimeProvider } from "./protected-secrets.js";

export interface ProviderInferenceProgress {
  phase: InferenceProgressPhase;
  fractionComplete: number | null;
  completedTokens: number | null;
  totalTokens: number | null;
  precision: InferenceProgressPrecision;
  source: InferenceProgressSource;
}

export interface InferenceProgressObservationInput {
  modelName: string;
  provider: RuntimeProvider;
  onProgress(progress: ProviderInferenceProgress): void;
}

export interface InferenceProgressObservation {
  close(): Promise<void> | void;
}

export interface InferenceProgressAdapter {
  observe(
    input: InferenceProgressObservationInput,
  ): Promise<InferenceProgressObservation | null>;
}

export class InferenceProgressObserver {
  readonly #adapters: readonly InferenceProgressAdapter[];

  constructor(adapters: readonly InferenceProgressAdapter[]) {
    this.#adapters = adapters;
  }

  async observe(
    input: InferenceProgressObservationInput,
  ): Promise<InferenceProgressObservation | null> {
    for (const adapter of this.#adapters) {
      const observation = await adapter.observe(input);
      if (observation) return observation;
    }
    return null;
  }
}
