import type {
  InferenceLease,
  InferenceRuntime,
  InferenceTicket,
  WorkerInferenceAdmission,
} from "../inference-admission.js";

interface Operation {
  operationId: string;
  chatId: string | null;
  threadId: string | null;
  turnId: string | null;
  dispatched: boolean;
  observedStart: boolean;
  settled: boolean;
  ticket: InferenceTicket;
  lease: InferenceLease | null;
}

export interface CodexInferenceExecution {
  bindThread(threadId: string): void;
  bindTurn(turnId: string): void;
  /** Immediately before forwarding the exact native request. */
  dispatched(): void;
  /** The exact native start was rejected, not a transport timeout. */
  rejected(): void;
  /** Preparation failed before this owner forwarded any model request. */
  notDispatched(): void;
}

interface Request {
  operationId: string;
  provider: {
    id: string;
    maxConcurrentInference?: number;
    inferenceConfigRevision?: number;
  };
  chatId?: string | null;
  projectId?: string | null;
  threadId?: string | null;
  expectedTurnId?: string;
  signal?: AbortSignal;
}

/**
 * Correlates worker tickets with actual native turns independently of UI turn
 * tracking. Local publication failure or WebSocket loss is not native settlement.
 * One instance belongs to one launched native process, captured by its exit hook.
 */
export class CodexInferenceAdmission {
  private readonly runtime: InferenceRuntime;
  private readonly operations = new Set<Operation>();
  private readonly completed = new Set<string>();
  private readonly requests = new Map<
    string,
    { identity: string; result: Promise<CodexInferenceExecution> }
  >();
  private exited = false;

  constructor(private readonly admission: WorkerInferenceAdmission) {
    this.runtime = admission.createRuntime();
  }

  acquire(input: Request): Promise<CodexInferenceExecution> {
    const identity = JSON.stringify([
      input.provider.id,
      input.chatId ?? null,
      input.projectId ?? null,
      input.threadId ?? null,
      input.expectedTurnId ?? null,
    ]);
    const previous = this.requests.get(input.operationId);
    if (previous) {
      if (previous.identity !== identity)
        return Promise.reject(
          new Error("Inference operation identity changed during redelivery."),
        );
      return previous.result;
    }
    const result = this.acquireOperation(input);
    this.requests.set(input.operationId, { identity, result });
    return result;
  }

  private async acquireOperation(
    input: Request,
  ): Promise<CodexInferenceExecution> {
    if (this.exited)
      throw new Error("The native inference process has exited.");
    this.admission.configure({
      providerId: input.provider.id,
      ...input.provider,
    });
    const ticket = this.runtime.request({
      operationId: input.operationId,
      providerId: input.provider.id,
      chatId: input.chatId,
      projectId: input.projectId,
      signal: input.signal,
    });
    const operation: Operation = {
      operationId: input.operationId,
      chatId: input.chatId ?? null,
      threadId: input.threadId ?? null,
      turnId: input.expectedTurnId ?? null,
      dispatched: false,
      observedStart: false,
      settled: false,
      ticket,
      lease: null,
    };
    this.operations.add(operation);
    try {
      operation.lease = await ticket.ready;
      if (this.exited || operation.settled || operation.lease.signal.aborted)
        throw new Error("The native inference admission was cancelled.");
    } catch (error) {
      this.operations.delete(operation);
      throw error;
    }
    return {
      bindThread: (threadId) => {
        if (operation.threadId && operation.threadId !== threadId)
          throw new Error(
            "Inference admission cannot change its native thread.",
          );
        operation.threadId = threadId;
        this.reconcile(operation);
      },
      bindTurn: (turnId) => this.bindTurn(operation, turnId),
      dispatched: () => {
        if (operation.dispatched || operation.settled)
          throw new Error(
            "The inference operation was already dispatched or settled.",
          );
        operation.lease!.start();
        operation.dispatched = true;
      },
      rejected: () => {
        // Contradictory receipts cannot override an observed running native turn.
        if (!operation.observedStart) this.settle(operation, "failed");
      },
      notDispatched: () => {
        if (!operation.dispatched) this.settle(operation, "never-started");
      },
    };
  }

  /** Only queued/unforwarded work is cancelled here; running work needs native Stop. */
  cancelWaiting(chatId: string): boolean {
    let cancelled = false;
    for (const operation of this.operations) {
      if (
        operation.chatId !== chatId ||
        operation.dispatched ||
        operation.settled
      )
        continue;
      operation.ticket.cancel();
      operation.settled = true;
      this.operations.delete(operation);
      cancelled = true;
    }
    return cancelled;
  }

  observationLost(): void {
    for (const operation of this.operations) {
      if (operation.dispatched) continue;
      operation.ticket.cancel(
        new Error("Native transport disconnected before inference dispatch."),
      );
      operation.settled = true;
      this.operations.delete(operation);
    }
  }

  /** Must be invoked by the actual process-exit hook, even if the socket changed. */
  processExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.runtime.exited();
    for (const operation of this.operations) operation.settled = true;
    this.operations.clear();
    this.completed.clear();
    this.requests.clear();
  }

  observe(method: string | undefined, params: unknown): void {
    if (method !== "turn/started" && method !== "turn/completed") return;
    if (!params || typeof params !== "object") return;
    const value = params as {
      threadId?: unknown;
      turn?: { id?: unknown; status?: unknown };
    };
    if (
      typeof value.threadId !== "string" ||
      typeof value.turn?.id !== "string"
    )
      return;
    const threadId = value.threadId,
      turnId = value.turn.id;
    if (method === "turn/started") {
      const candidates = [...this.operations].filter(
        (operation) =>
          operation.dispatched &&
          operation.threadId === threadId &&
          (!operation.turnId || operation.turnId === turnId),
      );
      // Never guess between ambiguous physical attempts on the same thread.
      if (candidates.length === 1) {
        candidates[0]!.observedStart = true;
        this.bindTurn(candidates[0]!, turnId);
      }
      return;
    }
    if (
      !["completed", "failed", "interrupted"].includes(
        String(value.turn.status),
      )
    )
      return;
    const key = JSON.stringify([threadId, turnId]);
    this.completed.add(key);
    if (this.completed.size > 512)
      this.completed.delete(this.completed.values().next().value!);
    for (const operation of this.operations) this.reconcile(operation);
  }

  private bindTurn(operation: Operation, turnId: string): void {
    if (operation.turnId && operation.turnId !== turnId)
      throw new Error(
        "Inference admission received a different native turn identity.",
      );
    operation.turnId = turnId;
    this.reconcile(operation);
  }

  private reconcile(operation: Operation): void {
    if (
      operation.threadId &&
      operation.turnId &&
      this.completed.has(JSON.stringify([operation.threadId, operation.turnId]))
    )
      this.settle(operation, "completed");
  }

  private settle(
    operation: Operation,
    outcome: "completed" | "failed" | "never-started",
  ): void {
    if (operation.settled) return;
    operation.settled = true;
    operation.lease?.settle(outcome);
    this.operations.delete(operation);
  }
}
