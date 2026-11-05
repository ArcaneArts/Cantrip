import type { InferenceOperationSource } from "./inference-admission.js";

/** Owns the result of an actual one-time canonical claim. The caller must obtain
 * that claim before construction; an arbitrary operation ID is not authority. */
export class ClaimedInferenceSource {
  readonly source: InferenceOperationSource;
  private readonly controller = new AbortController();
  private readonly finish: () => void;
  private generation: string | null = null;
  private closed = false;

  constructor(operationId: string, signal?: AbortSignal) {
    let finish!: () => void;
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.finish = finish;
    const owner = this;
    const lifetimeSignal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    this.source = Object.freeze({
      operationId,
      get nativeTransportGeneration() {
        return owner.generation;
      },
      signal: lifetimeSignal,
      released,
      assertCurrent() {
        lifetimeSignal.throwIfAborted();
        if (owner.closed)
          throw new Error("The canonical inference claim has ended.");
      },
      bindNativeTransport(generation: string) {
        owner.source.assertCurrent();
        if (
          !generation ||
          (owner.generation && owner.generation !== generation)
        )
          throw new Error(
            "The inference claim belongs to another native transport.",
          );
        owner.generation = generation;
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(
      new Error("The canonical inference claim has ended."),
    );
    this.finish();
  }
}
