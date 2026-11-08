import { randomUUID } from "node:crypto";
import type {
  CodexAppServer,
  ManagedExecutionGateHandler,
} from "./app-server.js";
import { ManagedRootProducerHold } from "./managed-root-producer-hold.js";

type RunnerRuntime = Pick<
  CodexAppServer,
  | "transportGeneration"
  | "setManagedExecutionGateHandler"
  | "invalidateManagedExecution"
  | "controlManagedRootProducer"
  | "bindManagedExecution"
>;

/** Eligibility belongs to the runner; each requested turn still needs its own admission. */
export class ManagedExecutionRunner {
  private generation: string = randomUUID();
  private registration: AbortSignal | null = null;
  private controller = new AbortController();
  private transport: string | null;
  private threadId: string | null;
  private invalidated = false;
  private revoked = false;
  private pendingBind: { previous: string; next: string } | null = null;
  private readonly providerTransfer: ManagedRootProducerHold;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: RunnerRuntime,
    threadId: string | null,
    private readonly handler: ManagedExecutionGateHandler,
  ) {
    this.providerTransfer = new ManagedRootProducerHold(runtime);
    this.threadId = threadId;
    this.transport = runtime.transportGeneration;
    this.register();
  }

  get configuration(): { runnerGeneration: string } {
    return { runnerGeneration: this.generation };
  }

  belongsToCurrentTransport(): boolean {
    return (
      !this.registration?.aborted &&
      (this.transport === null ||
        this.transport === this.runtime.transportGeneration)
    );
  }

  prepared(threadId: string): void {
    if (this.revoked) throw new Error("The managed resource was removed.");
    if (this.threadId && this.threadId !== threadId)
      throw new Error("The managed runner belongs to another native thread.");
    if (!this.belongsToCurrentTransport())
      throw new Error(
        "The managed runner belongs to a replaced native transport.",
      );
    this.threadId = threadId;
    this.transport = this.runtime.transportGeneration;
  }

  private register(): void {
    const controller = this.controller;
    this.registration = this.runtime.setManagedExecutionGateHandler(
      this.generation,
      {
        requested: (attempt, signal) => {
          controller.signal.throwIfAborted();
          this.prepared(attempt.threadId);
          return this.handler.requested(
            attempt,
            AbortSignal.any([signal, controller.signal]),
          );
        },
        // The transport retains this callback for exact outstanding declines,
        // then retires it after an acknowledged replacement and native outcome.
        declined: (event) => this.handler.declined(event),
        failed: (error) => this.handler.failed(error),
      },
    );
  }

  /** Revokes this actual runner registration; a queue wake cannot reopen it. */
  revoke(): void {
    this.revoked = true;
    this.providerTransfer.discard();
    this.controller.abort(new Error("The managed resource was removed."));
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutations.then(operation);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  /** Hold new root cycles after withdrawing their exact unused source. Existing
   * children keep their gates and may finish before actual history export. */
  holdForProviderTransfer(
    operationId: string,
    runnerGeneration: string,
    threadId: string,
    transport: string,
  ): Promise<void> {
    return this.mutate(async () => {
      this.prepared(threadId);
      if (
        this.transport !== transport ||
        this.generation !== runnerGeneration ||
        this.pendingBind ||
        (this.providerTransfer.heldBy &&
          this.providerTransfer.heldBy !== operationId)
      )
        throw new Error(
          "The provider transfer belongs to another native runner.",
        );
      // A Stop/Pause already revoked the runner. Confirm that stronger fence;
      // transfer cancellation must never revive it or release its children.
      if (this.controller.signal.aborted) {
        await this.runtime.invalidateManagedExecution(
          { threadId, runnerGeneration },
          transport,
        );
        return;
      }
      await this.providerTransfer.hold(
        operationId,
        runnerGeneration,
        threadId,
        transport,
      );
    });
  }

  /** Release only this transfer's root hold. Keep the same native gate and
   * inference-only mode; an explicit Stop/Pause remains closed. */
  resumeAfterProviderTransfer(
    operationId: string,
    threadId: string,
    transport: string,
  ): Promise<void> {
    return this.mutate(async () => {
      if (this.providerTransfer.heldBy !== operationId || this.revoked) return;
      this.prepared(threadId);
      if (
        this.transport !== transport ||
        this.pendingBind ||
        this.controller.signal.aborted
      )
        return;
      await this.providerTransfer.release(
        operationId,
        this.generation,
        threadId,
        transport,
      );
    });
  }

  private async rebind(threadId: string, transport: string): Promise<void> {
    const { previous, next } = this.pendingBind ?? {
      previous: this.generation,
      next: randomUUID(),
    };
    this.pendingBind = { previous, next };
    this.generation = next;
    this.controller = new AbortController();
    this.register();
    try {
      await this.runtime.bindManagedExecution(
        {
          threadId,
          runnerGeneration: next,
          expectedRunnerGeneration: previous,
        },
        transport,
      );
      this.invalidated = false;
      this.pendingBind = null;
    } catch (error) {
      // Reconcile this exact idempotent bind after an uncertain response.
      this.controller.abort(error);
      throw error;
    }
  }

  /** Never queues behind model execution or the native queue/start request. */
  beforeNativeDispatch(
    method: string,
    threadId: string,
    transport: string,
    resumeAutonomy = false,
    cancelGoalAttempt = false,
  ): Promise<void> {
    if (this.revoked)
      return Promise.reject(new Error("The managed resource was removed."));
    if (
      method !== "turn/interrupt" &&
      method !== "thread/queue/add" &&
      method !== "thread/queue/start" &&
      method !== "thread/goal/set" &&
      method !== "thread/goal/clear" &&
      method !== "thread/compact/start" &&
      method !== "turn/pause"
    )
      return Promise.resolve();
    return this.mutate(async () => {
      this.prepared(threadId);
      if (this.transport !== transport)
        throw new Error(
          "The native command belongs to a replaced runner transport.",
        );
      if (method === "turn/interrupt" || cancelGoalAttempt) {
        this.providerTransfer.discard();
        this.controller.abort(
          new Error("The managed runner was explicitly stopped."),
        );
        this.invalidated = true;
        if (this.pendingBind) {
          await this.runtime.bindManagedExecution(
            {
              threadId,
              runnerGeneration: this.pendingBind.next,
              expectedRunnerGeneration: this.pendingBind.previous,
            },
            transport,
          );
          this.pendingBind = null;
        }
        await this.runtime.invalidateManagedExecution(
          { threadId, runnerGeneration: this.generation },
          transport,
        );
      } else if (
        this.invalidated &&
        (resumeAutonomy || method === "thread/compact/start")
      ) {
        // Compaction has its own admitted start. Stop/Goal clear invalidates
        // the inference-only native gate, so renew its generation before the
        // compact task reaches that boundary; retain the old source's abort.
        this.providerTransfer.discard();
        await this.rebind(threadId, transport);
      }
    });
  }
}
