import { randomUUID } from "node:crypto";
import type {
  CodexAppServer,
  ManagedExecutionGateHandler,
} from "./app-server.js";

type RunnerRuntime = Pick<
  CodexAppServer,
  | "transportGeneration"
  | "setManagedExecutionGateHandler"
  | "invalidateManagedExecution"
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
  private pendingBind: { previous: string; next: string } | null = null;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: RunnerRuntime,
    threadId: string | null,
    private readonly handler: ManagedExecutionGateHandler,
  ) {
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
          this.prepared(attempt.threadId);
          return this.handler.requested(
            attempt,
            AbortSignal.any([signal, controller.signal]),
          );
        },
        // Keep the old handler for exact native declines after invalidation/rebinding.
        declined: (event) => this.handler.declined(event),
        failed: (error) => this.handler.failed(error),
      },
    );
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutations.then(operation);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  /** Never queues behind model execution or the native queue/start request. */
  beforeNativeDispatch(
    method: string,
    threadId: string,
    transport: string,
    resumeAutonomy = false,
    cancelGoalAttempt = false,
  ): Promise<void> {
    if (
      method !== "turn/interrupt" &&
      method !== "thread/queue/add" &&
      method !== "thread/queue/start" &&
      method !== "thread/goal/set" &&
      method !== "thread/goal/clear" &&
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
      } else if (this.invalidated && resumeAutonomy) {
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
          // A later explicit command may reconcile this exact idempotent bind;
          // never invent a replacement generation after an uncertain response.
          this.controller.abort(error);
          throw error;
        }
      }
    });
  }
}
