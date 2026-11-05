import { observeInferenceCommand } from "./inference-command.js";

/** A synchronous refusal before an inference reservation has been changed. */
export class UnstartedInferenceUnavailableError extends Error {}

/** The unused ticket is sealed, but the original command must retain its
 * canonical claim until the durable handoff has acknowledged its deferral. */
export class InferenceWithdrawalError extends Error {
  private readonly acknowledged: Promise<void>;
  private confirm!: () => void;

  constructor() {
    super("The queued inference is moving to another provider.");
    this.name = "InferenceWithdrawalError";
    this.acknowledged = new Promise((resolve) => {
      this.confirm = resolve;
    });
  }

  acknowledge(): void {
    this.confirm();
  }

  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // This confirmed non-inferencing wait suspends only the command deadline.
    // It creates neither a provider queue entry nor a provider timing clock.
    const observe = observeInferenceCommand();
    observe?.("suspended");
    try {
      if (!signal) return await this.acknowledged;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        void this.acknowledged.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
        if (signal.aborted) abort();
      });
    } finally {
      observe?.("released");
    }
  }
}
