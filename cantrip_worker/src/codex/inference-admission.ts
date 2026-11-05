import type {
  InferenceOperationStatus,
  InferenceFailureEvidence,
} from "@cantrip/protocol";
import {
  recoveryIdentity,
  type InferenceRecoveryIdentity,
} from "../inference-journal.js";
import type {
  InferenceLease,
  InferenceRuntime,
  InferenceOperationLifetime,
  InferenceOperationSource,
  InferenceTicket,
  WorkerInferenceAdmission,
} from "../inference-admission.js";
import { trackInferenceCommandOperation } from "../inference-command.js";

interface Operation {
  operationId: string;
  chatId: string | null;
  threadId: string | null;
  turnId: string | null;
  dispatched: boolean;
  leaseStarted: boolean;
  preparing: boolean;
  preparationEnded?: () => void;
  observedStart: boolean;
  nativeBoundary: boolean;
  nativeScopeId: string | null;
  rejectedInput: boolean;
  nativeFailureBeforeOutput: boolean;
  settled: boolean;
  revoked?: boolean;
  revocationNotified?: boolean;
  ticket: InferenceTicket;
  lease: InferenceLease | null;
  settlement: Promise<void>;
  resolveSettlement(): void;
}

export interface CodexInferenceExecution {
  /** Confirmed release, including native response teardown or process fencing. */
  settled(): Promise<void>;
  failureEvidence(): InferenceFailureEvidence | null;
  bindThread(threadId: string): void;
  bindTurn(turnId: string): void;
  /** Immediately before forwarding the exact native request. */
  dispatched(): void;
  /** The exact native start was rejected, not a transport timeout. */
  rejected(): void;
  /** Preparation failed before this owner forwarded any model request. */
  notDispatched(): void;
  /** A single serial preparation request shares this ticket with its response turn. */
  prepare<T>(
    providerId: string,
    action: (scope: InferencePreparationScope) => Promise<T>,
  ): Promise<T>;
}

export interface InferencePreparationScope {
  beforeSend(): void;
  replied(): void;
  notSent(): void;
}

interface Request {
  lifetime?: InferenceOperationLifetime;
  purpose?: InferenceOperationStatus["purpose"];
  operationId: string;
  provider: {
    id: string;
    maxConcurrentInference?: number;
    inferenceConfigRevision?: number;
    inferenceCatalogCreatedRevision?: number;
  };
  chatId?: string | null;
  projectId?: string | null;
  threadId?: string | null;
  expectedTurnId?: string;
  nativeScopeId?: string;
  signal?: AbortSignal;
  recoveryKey?: string | null;
  recovery?: InferenceRecoveryIdentity | null;
}

interface NativeEntry {
  independent: boolean;
  confirmed: boolean;
  gateAttemptId: string;
  lifetime?: InferenceOperationLifetime;
  result: Promise<void>;
  /** The exact reservation selected before an asynchronous bind can fail. */
  operation?: Operation;
}

interface NativeRequest {
  /** The live Core gate request, distinct from its physical inference scope. */
  gateAttemptId: string;
  /** Resolves only when the actual connection-owned Core gate is still pending. */
  confirmOwnership(): Promise<boolean>;
  threadId: string;
  turnId: string;
  scopeId: string;
  provider: Request["provider"];
  signal: AbortSignal;
  rootThreadId?: string | null;
  /** Thread-owned association survives the preceding cycle's ticket release. */
  chatId?: string | null;
  /** Concurrent helper work must never borrow a dispatched root's reservation. */
  independent?: boolean;
}

export interface RevokedInferenceExecution {
  threadId: string;
  turnId: string;
  settled: Promise<void>;
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
  private readonly nativeEntries = new Map<string, NativeEntry>();
  private readonly requests = new Map<
    string,
    { identity: string; result: Promise<CodexInferenceExecution> }
  >();
  private readonly lifetimeRequests = new WeakMap<
    InferenceOperationLifetime,
    { identity: string; result: Promise<CodexInferenceExecution> }
  >();
  private readonly sourceLifetimes = new WeakMap<
    InferenceOperationSource,
    InferenceOperationLifetime
  >();
  private exited = false;
  private retirement: Promise<void> | null = null;

  constructor(
    private readonly admission: WorkerInferenceAdmission,
    private readonly onRevokedExecution: (
      execution: RevokedInferenceExecution,
    ) => void = () => {},
  ) {
    this.runtime = admission.createRuntime();
  }

  get generation(): string {
    return this.runtime.generation;
  }

  lifetimeForSource(
    source: InferenceOperationSource,
  ): InferenceOperationLifetime {
    source.assertCurrent();
    const previous = this.sourceLifetimes.get(source);
    if (previous) {
      if (previous.operationId !== source.operationId)
        throw new Error(
          "Canonical inference source changed operation identity.",
        );
      return previous;
    }
    const lifetime = this.runtime.createOperationLifetime(source.operationId);
    this.sourceLifetimes.set(source, lifetime);
    const signal = source.signal;
    const close = () => lifetime.close();
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) close();
    // Closing admission cancels only unused reservations. Running native work
    // remains owned until actual settlement, even if publication has ended.
    const released = () => {
      signal?.removeEventListener("abort", close);
      close();
    };
    void source.released.then(released, released);
    return lifetime;
  }

  acquire(input: Request): Promise<CodexInferenceExecution> {
    if (input.operationId.startsWith("native-inference:") && !input.lifetime)
      return Promise.reject(
        new Error("Private native inference requires its canonical lifetime."),
      );
    if (
      input.lifetime &&
      (input.lifetime.runtimeGeneration !== this.generation ||
        input.lifetime.operationId !== input.operationId)
    )
      return Promise.reject(
        new Error("Inference operation lifetime changed owner."),
      );
    const identity = JSON.stringify([
      input.operationId,
      input.provider.id,
      input.provider.inferenceCatalogCreatedRevision ?? null,
      input.purpose ?? "helper",
      input.chatId ?? null,
      input.projectId ?? null,
      input.threadId ?? null,
      input.expectedTurnId ?? null,
      input.nativeScopeId ?? null,
      input.recoveryKey ?? null,
      recoveryIdentity(input.recovery),
    ]);
    const previous = input.lifetime
      ? this.lifetimeRequests.get(input.lifetime)
      : this.requests.get(input.operationId);
    if (previous) {
      if (previous.identity !== identity)
        return Promise.reject(
          new Error("Inference operation identity changed during redelivery."),
        );
      return previous.result;
    }
    trackInferenceCommandOperation(input.operationId);
    const result = this.acquireOperation(input);
    if (input.lifetime)
      this.lifetimeRequests.set(input.lifetime, { identity, result });
    else this.requests.set(input.operationId, { identity, result });
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
      lifetime: input.lifetime,
      purpose: input.purpose,
      providerId: input.provider.id,
      providerCreationRevision: input.provider.inferenceCatalogCreatedRevision,
      chatId: input.chatId,
      projectId: input.projectId,
      signal: input.signal,
      recoveryKey: input.recoveryKey,
      recovery: input.recovery,
    });
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const operation: Operation = {
      operationId: input.operationId,
      chatId: input.chatId ?? null,
      threadId: input.threadId ?? null,
      turnId: input.expectedTurnId ?? null,
      dispatched: false,
      leaseStarted: false,
      preparing: false,
      observedStart: false,
      nativeBoundary: Boolean(input.nativeScopeId),
      nativeScopeId: input.nativeScopeId ?? null,
      rejectedInput: false,
      nativeFailureBeforeOutput: false,
      settled: false,
      ticket,
      lease: null,
      settlement,
      resolveSettlement,
    };
    this.operations.add(operation);
    try {
      operation.lease = await ticket.ready;
      if (this.exited || operation.settled || operation.lease.signal.aborted)
        throw new Error("The native inference admission was cancelled.");
    } catch (error) {
      // Nothing was forwarded before this acquisition returned to its owner.
      operation.settled = true;
      this.operations.delete(operation);
      operation.resolveSettlement();
      throw error;
    }
    return {
      settled: () => operation.settlement,
      failureEvidence: () => {
        if (
          !operation.settled ||
          operation.preparing ||
          operation.lease?.signal.aborted ||
          !operation.chatId ||
          !input.recovery?.messageId
        )
          return null;
        const identity = {
          operationId: operation.operationId,
          providerId: input.provider.id,
          runtimeGeneration: this.runtime.generation,
          chatId: operation.chatId,
          messageId: input.recovery.messageId,
        };
        if (
          !operation.dispatched ||
          (operation.rejectedInput && !operation.nativeBoundary)
        )
          return {
            ...identity,
            disposition: "input-not-dispatched",
            threadId: operation.threadId,
            turnId: operation.turnId,
            nativeScopeId: null,
          };
        if (
          operation.nativeBoundary &&
          operation.nativeFailureBeforeOutput &&
          operation.threadId &&
          operation.turnId &&
          operation.nativeScopeId
        )
          return {
            ...identity,
            disposition: "model-failed-before-output",
            threadId: operation.threadId,
            turnId: operation.turnId,
            nativeScopeId: operation.nativeScopeId,
          };
        return null;
      },
      bindThread: (threadId) => {
        if (operation.threadId && operation.threadId !== threadId)
          throw new Error(
            "Inference admission cannot change its native thread.",
          );
        operation.threadId = threadId;
        this.notifyRevocation(operation);
        this.reconcile(operation);
      },
      bindTurn: (turnId) => this.bindTurn(operation, turnId),
      dispatched: () => {
        if (operation.dispatched || operation.settled || operation.preparing)
          throw new Error(
            "The inference operation was already dispatched or settled.",
          );
        operation.lease!.signal.throwIfAborted();
        if (!operation.leaseStarted) operation.lease!.start();
        operation.leaseStarted = true;
        operation.dispatched = true;
        this.notifyRevocation(operation);
        // A restored execution can reuse a logical turn ID. UI completion
        // cached before this dispatch belongs to the preceding execution.
        if (operation.threadId && operation.turnId)
          this.completed.delete(
            JSON.stringify([operation.threadId, operation.turnId]),
          );
      },
      rejected: () => {
        // Contradictory receipts cannot override an observed running native turn.
        if (!operation.observedStart && !operation.nativeBoundary) {
          operation.rejectedInput = true;
          this.settle(operation, "failed");
        }
      },
      notDispatched: () => {
        if (!operation.dispatched && !operation.preparing)
          this.settle(
            operation,
            operation.leaseStarted ? "completed" : "never-started",
          );
      },
      prepare: async (providerId, action) => {
        if (
          providerId !== input.provider.id ||
          operation.preparing ||
          operation.dispatched ||
          operation.settled
        )
          throw new Error(
            "Inference preparation does not own this provider turn.",
          );
        operation.lease!.signal.throwIfAborted();
        operation.preparing = true;
        let sent = false;
        let finished!: () => void;
        const settlement = new Promise<void>((resolve) => {
          finished = resolve;
        });
        operation.preparationEnded = finished;
        try {
          return await action({
            beforeSend: () => {
              if (sent || operation.settled)
                throw new Error(
                  "Inference preparation was already sent or settled.",
                );
              operation.lease!.signal.throwIfAborted();
              if (!operation.leaseStarted) operation.lease!.start();
              operation.leaseStarted = true;
              sent = true;
            },
            replied: finished,
            notSent: finished,
          });
        } finally {
          // The RPC's observation deadline can expire while native inference is
          // still running. The response must not overlap it under this ticket.
          if (sent) await settlement;
          operation.preparationEnded = undefined;
          operation.preparing = false;
          if (this.exited || operation.settled)
            throw new Error(
              "The preparation's native inference process exited.",
            );
          operation.lease!.signal.throwIfAborted();
        }
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
      if (!operation.preparing)
        this.settle(
          operation,
          operation.leaseStarted ? "completed" : "never-started",
        );
      cancelled = true;
    }
    return cancelled;
  }

  /** Resource removal seals every actual owner, including suspended/resuming
   * work. Cancellation requests never establish physical settlement. */
  revoke(
    chatIds: ReadonlySet<string>,
    operationIds: ReadonlySet<string>,
  ): void {
    for (const operation of this.operations) {
      if (
        operation.settled ||
        !(
          (operation.chatId && chatIds.has(operation.chatId)) ||
          operationIds.has(operation.operationId)
        )
      )
        continue;
      operation.revoked = true;
      operation.ticket.cancel(new Error("The inference resource was removed."));
      if (!operation.dispatched && !operation.preparing)
        this.settle(
          operation,
          operation.leaseStarted ? "completed" : "never-started",
        );
      else this.notifyRevocation(operation);
    }
  }

  private notifyRevocation(operation: Operation): void {
    if (
      !operation.revoked ||
      operation.revocationNotified ||
      operation.settled ||
      !operation.threadId ||
      !operation.turnId ||
      !operation.dispatched
    )
      return;
    operation.revocationNotified = true;
    this.onRevokedExecution({
      threadId: operation.threadId,
      turnId: operation.turnId,
      settled: operation.settlement,
    });
  }

  observationLost(): void {
    for (const operation of this.operations) {
      if (operation.dispatched) continue;
      operation.ticket.cancel(
        new Error("Native transport disconnected before inference dispatch."),
      );
      if (!operation.preparing)
        this.settle(
          operation,
          operation.leaseStarted ? "completed" : "never-started",
        );
    }
  }

  /** Establish ownership before launching the real native process. */
  prepareNativeLaunch(): Promise<NodeJS.ProcessEnv> {
    return this.runtime.prepareNativeLaunch();
  }

  /** Launcher exit requests fencing; only the native lease proves settlement. */
  processExited(): Promise<void> {
    if (this.retirement) return this.retirement;
    this.exited = true;
    this.retirement = this.runtime.exited().then(() => {
      for (const operation of this.operations) {
        operation.settled = true;
        operation.resolveSettlement();
        operation.preparationEnded?.();
      }
      this.operations.clear();
      this.completed.clear();
      for (const entry of this.nativeEntries.values()) entry.lifetime?.close();
      this.nativeEntries.clear();
      this.requests.clear();
    });
    return this.retirement;
  }

  /** Native Core may use an existing root ticket or admit an independent child. */
  async enterNative(input: NativeRequest): Promise<void> {
    const key = JSON.stringify([input.threadId, input.turnId, input.scopeId]);
    if (this.completed.has(key))
      throw new Error("Native inference already settled.");
    let entering = this.nativeEntries.get(key);
    const independent = input.independent === true;
    if (entering && entering.gateAttemptId !== input.gateAttemptId)
      throw new Error(
        "Native inference scope belongs to another gate request.",
      );
    if (entering && entering.independent !== independent)
      throw new Error(
        "Native inference changed admission kind during redelivery.",
      );
    if (!entering) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      const entry: NativeEntry = {
        independent,
        confirmed: false,
        gateAttemptId: input.gateAttemptId,
        result,
      };
      entering = entry;
      this.nativeEntries.set(key, entry);
      // Install correlation before admission starts, without postponing this
      // eligible operation behind newer synchronous arrivals.
      void this.admitNative(input, entry).then(resolve, reject);
    }
    await entering.result;
    const operation = this.findNative(
      input.threadId,
      input.turnId,
      input.scopeId,
    );
    if (!operation?.lease || operation.ticket.status().state !== "running")
      throw new Error("Native inference has no running grant.");
    // Core's private finish follows its actual response-task teardown. A UI
    // turn/completed event may arrive before those tasks have fully stopped.
    operation.nativeBoundary = true;
    operation.observedStart = true;
  }

  private async confirmNativeOwnership(
    input: NativeRequest,
    entry: NativeEntry,
  ): Promise<void> {
    const key = JSON.stringify([input.threadId, input.turnId, input.scopeId]);
    let confirmed: boolean;
    try {
      confirmed = await input.confirmOwnership();
    } catch (error) {
      // No private reservation exists yet. Dropping this failed confirmation
      // cannot free model execution; another attempt must query Core again.
      // A captured root stays correlated until exact settlement evidence.
      if (
        !entry.operation &&
        !entry.lifetime &&
        this.nativeEntries.get(key) === entry
      )
        this.nativeEntries.delete(key);
      throw error;
    }
    if (!confirmed) {
      if (this.nativeEntries.get(key) === entry && !entry.lifetime)
        this.nativeEntries.delete(key);
      throw new Error(
        "The actual native inference request is no longer pending.",
      );
    }
    entry.confirmed = true;
    input.signal.throwIfAborted();
    if (this.exited)
      throw new Error("The native inference process has exited.");
  }

  private async admitNative(
    input: NativeRequest,
    entry: NativeEntry,
  ): Promise<void> {
    const binding = {
      threadId: input.threadId,
      turnId: input.turnId,
      scopeId: input.scopeId,
    };
    const existing = this.findNative(
      input.threadId,
      input.turnId,
      input.scopeId,
    );
    if (existing) {
      if (input.independent)
        throw new Error(
          "Independent inference cannot reuse an existing native turn.",
        );
      entry.operation = existing;
      await this.confirmNativeOwnership(input, entry);
      input.signal.throwIfAborted();
      if (existing.settled || this.exited)
        throw new Error(
          "Native inference settled during ownership confirmation.",
        );
      await existing.lease!.bindNative(binding);
      input.signal.throwIfAborted();
      return;
    }
    // Core's private begin can overtake the ordinary turn/started observer.
    // Its physical scope binds the unique dispatched, unbound reservation
    // without acquiring twice at limit one. A restored execution of the same
    // logical turn cannot borrow an older scope's still-settling ticket.
    const roots = [...this.operations].filter(
      (operation) =>
        !input.independent &&
        operation.threadId === input.threadId &&
        operation.dispatched &&
        (!operation.turnId || operation.turnId === input.turnId) &&
        operation.nativeScopeId === null &&
        !operation.settled,
    );
    if (roots.length === 1) {
      const operation = roots[0]!;
      entry.operation = operation;
      let boundHere = false;
      try {
        await this.confirmNativeOwnership(input, entry);
        if (
          operation.settled ||
          (operation.nativeScopeId !== null &&
            operation.nativeScopeId !== input.scopeId)
        )
          throw new Error(
            "Native inference owner changed during confirmation.",
          );
        operation.observedStart = true;
        operation.nativeBoundary = true;
        operation.nativeScopeId = input.scopeId;
        boundHere = true;
        this.bindTurn(operation, input.turnId);
        await operation.lease!.bindNative(binding);
        input.signal.throwIfAborted();
      } catch (error) {
        // An older confirmation must not erase a newer physical binding.
        if (
          boundHere &&
          !operation.settled &&
          operation.nativeScopeId === input.scopeId
        ) {
          operation.nativeBoundary = false;
          operation.nativeScopeId = null;
          this.reconcile(operation);
        }
        throw error;
      }
      return;
    }
    if (roots.length > 1)
      throw new Error("Native inference has ambiguous dispatched owners.");
    await this.confirmNativeOwnership(input, entry);
    input.signal.throwIfAborted();
    if (this.exited)
      throw new Error("The native inference process has exited.");
    const operationId = `native-inference:${input.threadId}:${input.turnId}:${input.scopeId}:${input.gateAttemptId}`;
    const lifetime = this.runtime.createOperationLifetime(operationId);
    entry.lifetime = lifetime;
    const root = input.rootThreadId
      ? [...this.operations].find(
          (operation) => operation.threadId === input.rootThreadId,
        )
      : undefined;
    const scope = root?.ticket.status();
    const execution = await this.acquire({
      operationId,
      lifetime,
      purpose: input.independent
        ? "helper"
        : input.rootThreadId && input.rootThreadId !== input.threadId
          ? "child"
          : "turn",
      provider: input.provider,
      chatId: scope?.chatId ?? input.chatId,
      projectId: scope?.projectId,
      threadId: input.threadId,
      expectedTurnId: input.turnId,
      nativeScopeId: input.scopeId,
      recoveryKey: `native-turn:${input.threadId}:${input.turnId}:${input.scopeId}`,
      recovery: { threadId: input.threadId, turnId: input.turnId },
      signal: input.signal,
    });
    try {
      const operation = this.findNative(
        input.threadId,
        input.turnId,
        input.scopeId,
      );
      if (!operation?.lease)
        throw new Error("Native inference lost its binding owner.");
      entry.operation = operation;
      await operation.lease.bindNative(binding);
      input.signal.throwIfAborted();
    } catch (error) {
      // This newly acquired operation has not forwarded model execution yet.
      execution.notDispatched();
      throw error;
    }
    execution.dispatched();
  }

  /** Called only after Core establishes that no inference can run before resume. */
  suspendNative(threadId: string, turnId: string, scopeId: string): void {
    const operation = this.findNative(threadId, turnId, scopeId);
    if (!operation?.lease)
      throw new Error("Native suspension has no inference owner.");
    operation.lease.suspend();
  }

  async resumeNative(
    threadId: string,
    turnId: string,
    scopeId: string,
  ): Promise<void> {
    const operation = this.findNative(threadId, turnId, scopeId);
    if (!operation?.lease)
      throw new Error("Native resumption has no inference owner.");
    await operation.lease.resume();
  }

  /** Only Core's exact pending-begin cancellation or accepted negative resolve
   * establishes that this physical scope cannot enter model execution. This
   * must never be used for an uncertain resolver reply or a denied resume. */
  rejectNativeBegin(
    threadId: string,
    turnId: string,
    scopeId: string,
    gateAttemptId: string,
  ): void {
    const key = JSON.stringify([threadId, turnId, scopeId]);
    const entry = this.nativeEntries.get(key);
    if (!entry || entry.gateAttemptId !== gateAttemptId) return;
    const operation =
      entry.operation ?? this.findNative(threadId, turnId, scopeId);
    this.rememberCompleted(threadId, turnId, scopeId);
    if (
      entry.confirmed &&
      operation &&
      !operation.settled &&
      !operation.preparing &&
      operation.threadId === threadId &&
      operation.turnId === turnId &&
      (operation.nativeScopeId === scopeId || operation.nativeScopeId === null)
    )
      this.settle(operation, "failed");
  }

  finishNative(
    threadId: string,
    turnId: string,
    scopeId: string,
    modelFailedBeforeOutput = false,
  ): void {
    this.rememberCompleted(threadId, turnId, scopeId);
    const operation = this.findNative(threadId, turnId, scopeId);
    if (operation) {
      operation.nativeFailureBeforeOutput = modelFailedBeforeOutput;
      this.settle(operation, "completed");
    }
  }

  cancelNativeWait(threadId: string, turnId: string, scopeId: string): void {
    const operation = this.findNative(threadId, turnId, scopeId);
    if (
      !operation ||
      !["waiting", "granted", "suspended"].includes(
        operation.ticket.status().state,
      )
    )
      return;
    operation.ticket.cancel();
    operation.settled = true;
    this.operations.delete(operation);
    operation.resolveSettlement();
  }

  private findNative(
    threadId: string,
    turnId: string,
    scopeId: string,
  ): Operation | undefined {
    return [...this.operations].find(
      (operation) =>
        operation.threadId === threadId &&
        operation.turnId === turnId &&
        operation.nativeScopeId === scopeId &&
        !operation.settled,
    );
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
    this.rememberCompleted(threadId, turnId);
    for (const operation of this.operations) this.reconcile(operation);
  }

  private rememberCompleted(
    threadId: string,
    turnId: string,
    scopeId?: string,
  ): void {
    const key = JSON.stringify(
      scopeId ? [threadId, turnId, scopeId] : [threadId, turnId],
    );
    this.nativeEntries.get(key)?.lifetime?.close();
    this.nativeEntries.delete(key);
    this.completed.add(key);
    if (this.completed.size > 512)
      this.completed.delete(this.completed.values().next().value!);
  }

  private bindTurn(operation: Operation, turnId: string): void {
    if (operation.turnId && operation.turnId !== turnId)
      throw new Error(
        "Inference admission received a different native turn identity.",
      );
    operation.turnId = turnId;
    this.notifyRevocation(operation);
    this.reconcile(operation);
  }

  private reconcile(operation: Operation): void {
    if (
      operation.dispatched &&
      !operation.nativeBoundary &&
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
    if (operation.lease) operation.lease.settle(outcome);
    else
      operation.ticket.cancel(
        new Error("Native execution settled before admission."),
      );
    this.operations.delete(operation);
    operation.resolveSettlement();
  }
}
