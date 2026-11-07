import { randomUUID } from "node:crypto";
import type { DirectInferenceRequest } from "./inference-admission.js";

const preparationBrand = Symbol("worker-inference-preparation");

/** Issued by the admission service for an actual blocked native preparation.
 * A wire ID, chat status, or another service's context cannot grant capacity. */
export interface InferencePreparationContext {
  readonly [preparationBrand]: true;
  readonly id: string;
  readonly signal: AbortSignal;
}

interface PreparationPorts {
  providerId: string;
  providerCreationRevision: number | undefined;
  signal: AbortSignal;
  assertCurrent(): void;
  borrow<T>(
    input: DirectInferenceRequest,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  independent<T>(
    input: DirectInferenceRequest,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  yield(): void;
  resume(): Promise<void>;
}

/** Structured ownership of real HTTP callbacks, including their teardown.
 * Native dispatch stays blocked until close() has joined all admitted children. */
export class InferencePreparation {
  readonly context: InferencePreparationContext;
  private readonly cancellation = new AbortController();
  private readonly jobs = new Set<Promise<void>>();
  private borrowing: Promise<void> | null = null;
  private handedOff = false;
  private handoff: Promise<void> | null = null;
  private yielded = false;
  private closing = false;

  constructor(private readonly ports: PreparationPorts) {
    this.context = Object.freeze({
      [preparationBrand]: true as const,
      id: randomUUID(),
      signal: AbortSignal.any([ports.signal, this.cancellation.signal]),
    });
  }

  run<T>(
    input: DirectInferenceRequest,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new Error("Model-operation preparation has closed."),
      );
    const signal = AbortSignal.any([
      this.ports.signal,
      this.cancellation.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    const result = this.execute({ ...input, signal }, execute);
    // Keep the original result/error for its caller. This separate promise joins
    // settlement even when the caller returns early or catches a child failure.
    const settled = result.then(
      () => {},
      () => {},
    );
    this.jobs.add(settled);
    void settled.then(() => this.jobs.delete(settled));
    return result;
  }

  private async execute<T>(
    input: DirectInferenceRequest,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.ports.assertCurrent();
    input.signal?.throwIfAborted();
    const sameProvider =
      input.providerId === this.ports.providerId &&
      (input.providerCreationRevision === undefined ||
        this.ports.providerCreationRevision === undefined ||
        input.providerCreationRevision === this.ports.providerCreationRevision);
    if (!this.handedOff && !this.borrowing && sameProvider) {
      let finish!: () => void;
      this.borrowing = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        return await this.ports.borrow(input, execute);
      } finally {
        this.borrowing = null;
        finish();
        // Embedding batches yield even if there is no concurrent child. An
        // already-running borrowed request must settle before its slot is freed.
        if (input.yieldAfter || this.handedOff) await this.yieldParent();
      }
    }
    const borrowed = this.borrowing;
    const handoff = this.yieldParent();
    // Concurrent work takes its own ticket immediately while a real borrowed
    // request runs. At limit one, that request's teardown yields the parent and
    // lets the queued child proceed. Never hold an idle parent while waiting.
    if (!borrowed) await handoff;
    this.ports.assertCurrent();
    input.signal?.throwIfAborted();
    return this.ports.independent(input, execute);
  }

  private yieldParent(): Promise<void> {
    if (this.handoff) return this.handoff;
    this.handedOff = true;
    const borrowing = this.borrowing;
    this.handoff = (async () => {
      await borrowing;
      this.ports.assertCurrent();
      this.ports.yield();
      this.yielded = true;
    })();
    // A concurrent child may finish before the borrowed callback. close() and
    // the borrowed owner's finally still join this handoff if it later fails.
    void this.handoff.catch(() => {});
    return this.handoff;
  }

  async close(succeeded: boolean): Promise<void> {
    this.closing = true;
    if (!succeeded)
      this.cancellation.abort(new Error("Model-operation preparation failed."));
    await Promise.all([...this.jobs]);
    await this.handoff;
    // Failure of one child need not invalidate an otherwise live native owner.
    // Restore its own FIFO permission before allowing a caller to recover and
    // dispatch. Parent cancellation/retirement must never reacquire capacity.
    if (this.yielded && !this.ports.signal.aborted) {
      this.ports.assertCurrent();
      await this.ports.resume();
    }
  }
}
