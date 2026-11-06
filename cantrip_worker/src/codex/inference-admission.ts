import type {
  InferenceOperationStatus,
  InferenceFailureEvidence,
  TaskGoalCycleIdentity,
  TaskGoalCycleRecovery,
  TaskInferenceInputReceipt,
} from "@cantrip/protocol";
import {
  recoveryIdentity,
  type InferenceJournalRecord,
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
import {
  InferenceWithdrawalError,
  UnstartedInferenceUnavailableError,
} from "../inference-withdrawal.js";

interface Operation {
  operationId: string;
  chatId: string | null;
  threadId: string | null;
  turnId: string | null;
  dispatched: boolean;
  inputDispatching: boolean;
  leaseStarted: boolean;
  preparing: boolean;
  preparationEnded?: () => void;
  observedStart: boolean;
  nativeBoundary: boolean;
  initialNativePaused?: boolean;
  nativeScopeId: string | null;
  taskGoalCycle?: TaskGoalCycleIdentity;
  taskInput?: TaskInferenceInputReceipt | null;
  queued: boolean;
  rejectedInput: boolean;
  nativeFailureBeforeOutput: boolean;
  settled: boolean;
  revoked?: boolean;
  revocationNotified?: boolean;
  ticket: InferenceTicket;
  lease: InferenceLease | null;
  settlement: Promise<void>;
  resolveSettlement(): void;
  withdrawal?: Promise<InferenceJournalRecord>;
  withdrawalReason?: InferenceWithdrawalError;
}

export interface CodexInferenceExecution {
  /** Confirmed release, including native response teardown or process fencing. */
  settled(): Promise<void>;
  failureEvidence(): InferenceFailureEvidence | null;
  bindThread(threadId: string): void;
  bindTurn(turnId: string): void;
  /** Immediately before forwarding the exact native request. */
  dispatched(): void;
  /** Close withdrawal before committing native dispatch metadata over HTTP. */
  sealInputDispatch(): Promise<void>;
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
  onQueued?: () => Promise<void>;
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
  initiallySuspended?: boolean;
  recoveryKey?: string | null;
  recovery?: InferenceRecoveryIdentity | null;
}

interface NativeEntry {
  independent: boolean;
  confirmed: boolean;
  gateAttemptId: string;
  expectedGoalEpoch: string | null;
  /** Supplied by the actual pending Core claim, never just its notification. */
  goal?: { epoch: string; inferenceOnly: boolean };
  lifetime?: InferenceOperationLifetime;
  result: Promise<void>;
  /** The exact reservation selected before an asynchronous bind can fail. */
  operation?: Operation;
}

interface BeforeAcquirePreparation {
  input: Request & { lifetime: InferenceOperationLifetime };
  controller: AbortController;
  finished: Promise<void>;
  reason?: Error;
  withdrawal?: Promise<InferenceJournalRecord>;
}

interface NativeRequest {
  /** The live Core gate request, distinct from its physical inference scope. */
  gateAttemptId: string;
  /** Resolves only when the actual connection-owned Core gate is still pending. */
  confirmOwnership(): Promise<
    | boolean
    | {
        claimed: boolean;
        goalEpoch?: string | null;
        inferenceOnly?: boolean;
      }
  >;
  goalEpoch?: string;
  runnerGeneration?: string;
  /** A configured root Task association, never inherited by a child/helper. */
  taskGoalCycle?: Pick<
    TaskGoalCycleIdentity,
    "cycleId" | "modelRouteId" | "providerAccountId" | "orderEpoch"
  >;
  onTaskGoalCycleQueued?: (
    cycle: TaskGoalCycleIdentity,
    operationId: string,
    runtimeGeneration: string,
  ) => Promise<void>;
  onTaskGoalCycleDispatch?: (
    cycle: TaskGoalCycleIdentity,
    operationId: string,
    recovery: TaskGoalCycleRecovery | null,
    source: InferenceJournalRecord | null,
  ) => Promise<void>;
  threadId: string;
  turnId: string;
  scopeId: string;
  provider: Request["provider"];
  signal: AbortSignal;
  /** Read synchronously when this actual pending native request enqueues. */
  isPaused?: () => boolean;
  rootThreadId?: string | null;
  /** Thread-owned association survives the preceding cycle's ticket release. */
  chatId?: string | null;
  projectId?: string | null;
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
  private readonly pausedChats = new Set<string>();

  setChatPaused(chatId: string, paused: boolean): void {
    if (paused) this.pausedChats.add(chatId);
    else this.pausedChats.delete(chatId);
    for (const operation of this.operations) {
      if (operation.chatId !== chatId || operation.settled) continue;
      if (paused)
        operation.ticket.pauseWaiting(
          !operation.dispatched &&
            !operation.inputDispatching &&
            !operation.preparing &&
            !operation.leaseStarted &&
            !operation.nativeBoundary &&
            !operation.turnId,
        );
      else operation.ticket.resumeWaiting();
    }
  }
  canHoldUnstartedChat(chatId: string, requireSource = false): boolean {
    const operations = [...this.operations].filter(
      (operation) => operation.chatId === chatId && !operation.settled,
    );
    return (
      (!requireSource || operations.length > 0) &&
      operations.every(
        (operation) =>
          !operation.dispatched &&
          !operation.inputDispatching &&
          !operation.preparing &&
          !operation.leaseStarted &&
          !operation.nativeBoundary &&
          !operation.turnId,
      )
    );
  }
  async confirmChatHold(chatId: string): Promise<void> {
    await Promise.all(
      [...this.operations]
        .filter(
          (operation) => operation.chatId === chatId && !operation.settled,
        )
        .map((operation) => operation.ticket.confirmPause()),
    );
  }
  private readonly runtime: InferenceRuntime;
  private readonly operations = new Set<Operation>();
  private readonly completed = new Set<string>();
  private readonly nativeEntries = new Map<string, NativeEntry>();
  private readonly lifetimeRequests = new WeakMap<
    InferenceOperationLifetime,
    { identity: string; result: Promise<CodexInferenceExecution> }
  >();
  private readonly sourceLifetimes = new WeakMap<
    InferenceOperationSource,
    InferenceOperationLifetime
  >();
  private readonly lifetimeOperations = new WeakMap<
    InferenceOperationLifetime,
    Operation
  >();
  // Active preparations only; prepareBeforeAcquire removes each entry in its
  // finally block. Stop must also reach labels awaiting a different provider.
  private readonly beforeAcquire = new Map<
    InferenceOperationLifetime,
    BeforeAcquirePreparation
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

  /** An alternate-provider label owns its own ticket. Retain the response's
   * actual source boundary without reserving response capacity meanwhile. */
  async prepareBeforeAcquire<T>(
    input: Request,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lifetime = input.lifetime;
    if (
      this.exited ||
      !lifetime ||
      lifetime.runtimeGeneration !== this.generation ||
      lifetime.operationId !== input.operationId ||
      input.nativeScopeId ||
      input.expectedTurnId ||
      this.lifetimeRequests.has(lifetime) ||
      this.beforeAcquire.has(lifetime)
    )
      throw new Error(
        "The canonical source cannot enter pre-acquisition preparation.",
      );
    lifetime.assertCurrent();
    input.signal?.throwIfAborted();
    let finish!: () => void;
    const preparation: BeforeAcquirePreparation = {
      input: { ...input, lifetime },
      controller: new AbortController(),
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.beforeAcquire.set(lifetime, preparation);
    const signal = input.signal
      ? AbortSignal.any([input.signal, preparation.controller.signal])
      : preparation.controller.signal;
    try {
      const result = await action(signal);
      if (preparation.reason) throw preparation.reason;
      return result;
    } catch (error) {
      throw preparation.reason ?? error;
    } finally {
      this.beforeAcquire.delete(lifetime);
      finish();
    }
  }

  acquire(input: Request): Promise<CodexInferenceExecution> {
    const lifetime = input.lifetime;
    if (!lifetime)
      return Promise.reject(
        new Error("Inference requires its live canonical operation lifetime."),
      );
    if (this.beforeAcquire.has(lifetime))
      return Promise.reject(
        new Error(
          "The canonical source is still preparing before acquisition.",
        ),
      );
    if (
      lifetime.runtimeGeneration !== this.generation ||
      lifetime.operationId !== input.operationId
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
    const previous = this.lifetimeRequests.get(lifetime);
    if (previous) {
      if (previous.identity !== identity)
        return Promise.reject(
          new Error("Inference operation identity changed during redelivery."),
        );
      return previous.result;
    }
    trackInferenceCommandOperation(input.operationId);
    const result = this.acquireOperation({ ...input, lifetime });
    this.lifetimeRequests.set(lifetime, { identity, result });
    return result;
  }

  private async acquireOperation(
    input: Request & { lifetime: InferenceOperationLifetime },
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
      initiallySuspended:
        input.initiallySuspended ||
        Boolean(input.chatId && this.pausedChats.has(input.chatId)),
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
      inputDispatching: false,
      leaseStarted: false,
      preparing: false,
      observedStart: false,
      nativeBoundary: Boolean(input.nativeScopeId),
      nativeScopeId: input.nativeScopeId ?? null,
      taskGoalCycle: input.recovery?.taskGoalCycle,
      taskInput: input.recovery?.taskInput,
      queued: false,
      rejectedInput: false,
      nativeFailureBeforeOutput: false,
      settled: false,
      ticket,
      lease: null,
      settlement,
      resolveSettlement,
    };
    this.operations.add(operation);
    this.lifetimeOperations.set(input.lifetime, operation);
    const queued = ticket.queued.then(async () => {
      input.signal?.throwIfAborted();
      await input.onQueued?.();
      input.signal?.throwIfAborted();
      operation.queued = true;
    });
    void queued.catch((error) => ticket.cancel(error));
    try {
      operation.lease = await ticket.ready;
      await queued;
      operation.lease.signal.throwIfAborted();
      if (this.exited || operation.settled)
        throw new Error("The native inference admission was cancelled.");
    } catch (error) {
      // Nothing was forwarded before this acquisition returned to its owner.
      operation.settled = true;
      this.operations.delete(operation);
      operation.resolveSettlement();
      throw operation.withdrawalReason ?? error;
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
        operation.lease!.signal.throwIfAborted();
        if (operation.dispatched || operation.settled || operation.preparing)
          throw new Error(
            "The inference operation was already dispatched or settled.",
          );
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
      sealInputDispatch: async () => {
        for (;;) {
          const permission = ticket.ready;
          const lease = await permission;
          lease.signal.throwIfAborted();
          if (permission !== ticket.ready) continue;
          const state = ticket.status().state;
          if (
            state !== "granted" &&
            !(state === "running" && operation.leaseStarted)
          )
            throw new Error(
              "The native input no longer owns its inference grant.",
            );
          operation.lease = lease;
          break;
        }
        if (
          operation.inputDispatching ||
          operation.settled ||
          operation.dispatched ||
          operation.preparing
        )
          throw new Error("The inference input cannot begin dispatch.");
        operation.inputDispatching = true;
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
        for (;;) {
          const permission = ticket.ready;
          const lease = await permission;
          lease.signal.throwIfAborted();
          if (permission !== ticket.ready) continue;
          const state = ticket.status().state;
          if (
            state !== "granted" &&
            !(state === "running" && operation.leaseStarted)
          )
            throw new Error(
              "The native preparation no longer owns its inference grant.",
            );
          operation.lease = lease;
          break;
        }
        if (
          providerId !== input.provider.id ||
          operation.preparing ||
          operation.dispatched ||
          operation.settled
        )
          throw new Error(
            "Inference preparation does not own this provider turn.",
          );
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

  /** A route transition must retain the actual canonical source, not select an
   * operation from a chat's UI status. Private inference gates and resumed
   * turns have already forwarded input and cannot use this no-replay boundary.
   * The managed pre-start Goal gate has not forwarded its input yet. */
  withdrawUnstarted(
    source: InferenceOperationSource,
    reason?: Error,
  ): Promise<InferenceJournalRecord> {
    const lifetime = this.sourceLifetimes.get(source);
    const operation = lifetime && this.lifetimeOperations.get(lifetime);
    const preparation = lifetime && this.beforeAcquire.get(lifetime);
    if (!operation && preparation) {
      if (preparation.withdrawal) return preparation.withdrawal;
      source.assertCurrent();
      const input = preparation.input;
      const withdrawn =
        reason ?? new Error("The unrequested response was withdrawn.");
      // The service seals the lifetime synchronously. Only then cancel the
      // independent label; it still owns its slot until native settlement.
      const proof = this.runtime.withdrawBeforeRequest(
        {
          operationId: input.operationId,
          lifetime: input.lifetime,
          purpose: input.purpose,
          providerId: input.provider.id,
          providerCreationRevision:
            input.provider.inferenceCatalogCreatedRevision,
          chatId: input.chatId,
          projectId: input.projectId,
          recoveryKey: input.recoveryKey,
          recovery: input.recovery,
          signal: input.signal,
        },
        withdrawn,
        preparation.finished,
      );
      preparation.reason = withdrawn;
      preparation.controller.abort(withdrawn);
      preparation.withdrawal = proof;
      void preparation.withdrawal.catch(() => {});
      return preparation.withdrawal;
    }
    if (!operation)
      throw new UnstartedInferenceUnavailableError(
        "This source does not own an inference reservation.",
      );
    if (operation.withdrawal) return operation.withdrawal;
    source.assertCurrent();
    if (
      this.exited ||
      operation.settled ||
      operation.dispatched ||
      operation.inputDispatching ||
      operation.leaseStarted ||
      operation.preparing ||
      operation.nativeBoundary
    )
      throw new UnstartedInferenceUnavailableError(
        "The canonical input is no longer unforwarded.",
      );
    operation.withdrawal = operation.ticket.withdrawUnstarted(reason);
    this.settle(operation, "never-started");
    return operation.withdrawal;
  }

  /** Only queued/unforwarded work is cancelled here; running work needs native Stop. */
  cancelWaiting(chatId: string): boolean {
    let cancelled = false;
    for (const [lifetime, preparation] of this.beforeAcquire) {
      if (preparation.input.chatId !== chatId) continue;
      const reason = (preparation.reason ??= new Error(
        "The turn was interrupted before response admission.",
      ));
      lifetime.close();
      preparation.controller.abort(reason);
      // The independent labeling operation still owns its actual native slot
      // until settlement. No response-provider ticket has been acquired here.
      cancelled = true;
    }
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
    if (entering && entering.expectedGoalEpoch !== (input.goalEpoch ?? null))
      throw new Error(
        "Native inference changed Goal identity during redelivery.",
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
        expectedGoalEpoch: input.goalEpoch ?? null,
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
      const claim = await input.confirmOwnership();
      confirmed = typeof claim === "boolean" ? claim : claim.claimed;
      if (
        confirmed &&
        (typeof claim === "boolean" ? null : (claim.goalEpoch ?? null)) !==
          (input.goalEpoch ?? null)
      )
        throw new Error("The pending native scope has another Goal identity.");
      if (confirmed && typeof claim !== "boolean" && claim.goalEpoch)
        entry.goal = {
          epoch: claim.goalEpoch,
          inferenceOnly: claim.inferenceOnly === true,
        };
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
        if (operation.initialNativePaused) {
          await operation.lease!.resume();
          input.signal.throwIfAborted();
          operation.initialNativePaused = false;
        }
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
    const taskGoalCycle: TaskGoalCycleIdentity | undefined =
      !input.independent &&
      input.rootThreadId === input.threadId &&
      entry.goal?.inferenceOnly &&
      input.taskGoalCycle &&
      input.runnerGeneration
        ? {
            ...input.taskGoalCycle,
            goalEpoch: entry.goal.epoch,
            scopeId: input.scopeId,
            gateAttemptId: input.gateAttemptId,
            runnerGeneration: input.runnerGeneration,
          }
        : undefined;
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
      projectId: scope?.projectId ?? input.projectId,
      threadId: input.threadId,
      expectedTurnId: input.turnId,
      nativeScopeId: input.scopeId,
      recoveryKey: `native-turn:${input.threadId}:${input.turnId}:${input.scopeId}`,
      recovery: {
        threadId: input.threadId,
        turnId: input.turnId,
        ...(taskGoalCycle ? { taskGoalCycle } : {}),
      },
      onQueued: taskGoalCycle
        ? () =>
            input.onTaskGoalCycleQueued?.(
              taskGoalCycle,
              operationId,
              this.runtime.generation,
            ) ?? Promise.resolve()
        : undefined,
      signal: input.signal,
      initiallySuspended: input.isPaused?.() === true,
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
      const recovery = operation.lease.taskGoalRecovery();
      if (taskGoalCycle) {
        if (!input.onTaskGoalCycleDispatch)
          throw new Error(
            "Task Goal inference has no canonical dispatch check.",
          );
        await input.onTaskGoalCycleDispatch(
          taskGoalCycle,
          operationId,
          recovery,
          recovery ? null : await operation.ticket.privateTaskGoalSource(),
        );
        input.signal.throwIfAborted();
      }
      execution.dispatched();
    } catch (error) {
      // This newly acquired operation has not forwarded model execution yet.
      execution.notDispatched();
      const owner =
        entry.lifetime && this.lifetimeOperations.get(entry.lifetime);
      throw owner?.withdrawalReason ?? error;
    }
  }

  queuedTaskGoalCycle(
    threadId: string,
    cycleId: string,
    goalEpoch: string,
  ): { operationId: string; runtimeGeneration: string } | null {
    const operation = [...this.operations].find(
      (operation) =>
        !operation.settled &&
        operation.queued &&
        operation.threadId === threadId &&
        operation.taskGoalCycle?.cycleId === cycleId &&
        operation.taskGoalCycle.goalEpoch === goalEpoch,
    );
    return operation
      ? {
          operationId: operation.operationId,
          runtimeGeneration: this.runtime.generation,
        }
      : null;
  }

  /** Locate an existing Task runtime; this alone is not unused-source proof. */
  hasTaskGoalScope(chatId: string, threadId: string, cycleId: string): boolean {
    return [...this.operations].some(
      (operation) =>
        !operation.settled &&
        operation.chatId === chatId &&
        operation.threadId === threadId &&
        operation.taskGoalCycle?.cycleId === cycleId,
    );
  }

  /** The keeper read and second owner check bracket asynchronous grant and
   * dispatch; capture itself neither withdraws nor grants that source. */
  async captureTaskGoalSource(input: {
    chatId: string;
    threadId: string;
    cycleId: string;
  }): Promise<InferenceJournalRecord> {
    const candidates = [...this.operations].filter(
      (operation) =>
        operation.chatId === input.chatId &&
        operation.threadId === input.threadId &&
        operation.taskGoalCycle?.cycleId === input.cycleId &&
        operation.queued &&
        !operation.settled,
    );
    if (candidates.length !== 1)
      throw new UnstartedInferenceUnavailableError(
        "The Task has no unique queued private Goal source.",
      );
    const operation = candidates[0]!;
    const record = await operation.ticket.privateTaskGoalSource();
    if (this.unusedTaskGoalOperation(record) !== operation)
      throw new UnstartedInferenceUnavailableError(
        "The private Task Goal source changed during capture.",
      );
    return record;
  }

  private unusedTaskGoalInputOperation(input: TaskInferenceInputReceipt) {
    const candidates = [...this.operations].filter(
      (operation) =>
        operation.taskInput?.kind === "goal" &&
        operation.operationId === input.operationId &&
        JSON.stringify(operation.taskInput) === JSON.stringify(input) &&
        operation.queued &&
        !operation.settled &&
        !operation.dispatched &&
        !operation.inputDispatching &&
        !operation.leaseStarted &&
        !operation.preparing &&
        !operation.nativeBoundary &&
        operation.nativeScopeId === null,
    );
    if (candidates.length !== 1)
      throw new UnstartedInferenceUnavailableError(
        "The Task has no unique unused first Goal input.",
      );
    return candidates[0]!;
  }

  hasTaskGoalInputScope(
    chatId: string,
    threadId: string,
    input: TaskInferenceInputReceipt,
  ): boolean {
    return [...this.operations].some(
      (operation) =>
        !operation.settled &&
        operation.chatId === chatId &&
        operation.threadId === threadId &&
        operation.taskInput?.kind === "goal" &&
        operation.operationId === input.operationId &&
        JSON.stringify(operation.taskInput) === JSON.stringify(input),
    );
  }

  async captureTaskGoalInputSource(input: TaskInferenceInputReceipt) {
    const operation = this.unusedTaskGoalInputOperation(input);
    const source = await operation.ticket.unstartedSource();
    if (this.unusedTaskGoalInputOperation(input) !== operation)
      throw new UnstartedInferenceUnavailableError(
        "The Task Goal input changed during its keeper read.",
      );
    return source;
  }

  withdrawTaskGoalInputSource(
    source: InferenceJournalRecord,
    reason: InferenceWithdrawalError,
    queueRevision: number,
  ) {
    const input = source.identity.recovery?.taskInput;
    if (!input || input.kind !== "goal" || source.nativeExecution)
      throw new UnstartedInferenceUnavailableError(
        "The transfer has no unused Task Goal input receipt.",
      );
    const operation = this.unusedTaskGoalInputOperation(input);
    if (
      source.identity.runtimeGeneration !== this.generation ||
      source.identity.chatId !== operation.chatId ||
      source.identity.recovery?.threadId !== operation.threadId
    )
      throw new UnstartedInferenceUnavailableError(
        "The Task Goal input changed its physical owner.",
      );
    operation.withdrawalReason = reason;
    try {
      operation.withdrawal = operation.ticket.withdrawUnstarted(
        reason,
        queueRevision,
      );
      this.settle(operation, "never-started");
      return operation.withdrawal;
    } catch (error) {
      operation.withdrawalReason = undefined;
      throw error;
    }
  }

  /** Only this fresh Core Task begin may use its never-allowed scope as a
   * withdrawal boundary. A restored turn, child or dependency resume cannot. */
  withdrawTaskGoalSource(
    record: InferenceJournalRecord,
    reason: InferenceWithdrawalError,
  ): Promise<InferenceJournalRecord> {
    const operation = this.unusedTaskGoalOperation(record);
    if (operation.withdrawal) return operation.withdrawal;
    operation.withdrawalReason = reason;
    try {
      operation.withdrawal =
        operation.ticket.withdrawTaskGoalBeforeAllow(reason);
    } catch (error) {
      operation.withdrawalReason = undefined;
      throw error;
    }
    this.settle(operation, "never-started");
    return operation.withdrawal;
  }

  private unusedTaskGoalOperation(record: InferenceJournalRecord): Operation {
    const identity = record.identity;
    const recovery = identity.recovery;
    const cycle = recovery?.taskGoalCycle;
    const entry = cycle
      ? this.nativeEntries.get(
          JSON.stringify([recovery!.threadId, recovery!.turnId, cycle.scopeId]),
        )
      : undefined;
    const operation = entry?.lifetime
      ? this.lifetimeOperations.get(entry.lifetime)
      : undefined;
    if (
      this.exited ||
      !cycle ||
      !entry?.confirmed ||
      entry.independent ||
      !entry.goal?.inferenceOnly ||
      entry.goal.epoch !== cycle.goalEpoch ||
      entry.gateAttemptId !== cycle.gateAttemptId ||
      identity.runtimeGeneration !== this.generation ||
      !operation ||
      operation.operationId !== identity.operationId ||
      operation.chatId !== identity.chatId ||
      operation.threadId !== recovery?.threadId ||
      operation.turnId !== recovery?.turnId ||
      operation.nativeScopeId !== cycle.scopeId ||
      operation.ticket.status().providerId !== identity.providerId ||
      recoveryIdentity({
        threadId: operation.threadId,
        turnId: operation.turnId,
        taskGoalCycle: operation.taskGoalCycle,
      }) !== recoveryIdentity(recovery)
    )
      throw new UnstartedInferenceUnavailableError(
        "The captured Task Goal source has no current private gate owner.",
      );
    if (
      !operation.withdrawal &&
      (operation.settled ||
        operation.revoked ||
        operation.dispatched ||
        operation.inputDispatching ||
        operation.leaseStarted ||
        operation.observedStart ||
        operation.preparing ||
        !operation.queued)
    )
      throw new UnstartedInferenceUnavailableError(
        "The captured private Task Goal begin is no longer unused.",
      );
    return operation;
  }

  /** Called only for the actual still-pending Core begin/resume request. A
   * waiting worker ticket owns no permission; a grant winning first is handled
   * by the normal native Pause boundary instead. */
  pauseNativeWait(threadId: string, turnId: string, scopeId: string) {
    const entry = this.nativeEntries.get(
      JSON.stringify([threadId, turnId, scopeId]),
    );
    const independent = entry?.independent === true;
    const operation =
      this.findNative(threadId, turnId, scopeId) ??
      (entry?.operation &&
      !entry.operation.settled &&
      entry.operation.nativeScopeId === null
        ? entry.operation
        : undefined);
    if (operation)
      return {
        parked:
          operation.ticket.pauseWaiting() ||
          Boolean(
            operation.lease && operation.ticket.status().state === "suspended",
          ),
        independent,
      };
    // Confirmation/preparation can precede enqueue. A root reservation that was
    // already forwarded cannot use this path; its actual native pause must ACK.
    return {
      independent,
      parked: ![...this.operations].some(
        (candidate) =>
          candidate.threadId === threadId &&
          (!candidate.turnId || candidate.turnId === turnId) &&
          candidate.dispatched &&
          !candidate.settled,
      ),
    };
  }

  /** The caller just confirmed this exact main Core begin is still pending.
   * A sequential title has settled, but its root reservation may already be
   * running before the first native model gate. Suspend only that unbound root;
   * independent/model scopes and overlapping preparation cannot use this path. */
  pauseInitialNativeBoundary(threadId: string, turnId: string): boolean {
    const candidates = [...this.operations].filter(
      (operation) =>
        operation.threadId === threadId &&
        (!operation.turnId || operation.turnId === turnId) &&
        operation.dispatched &&
        operation.nativeScopeId === null &&
        !operation.preparing &&
        !operation.inputDispatching &&
        !operation.settled &&
        operation.lease,
    );
    if (candidates.length !== 1) return false;
    const operation = candidates[0]!;
    const state = operation.ticket.status().state;
    if (operation.initialNativePaused && state === "suspended") return true;
    if (state !== "running" && state !== "cancelling") return false;
    operation.lease!.suspend();
    operation.initialNativePaused = true;
    return true;
  }

  resumePausedNative(chatId: string): void {
    for (const operation of this.operations)
      if (!operation.settled && operation.chatId === chatId)
        operation.ticket.resumeWaiting();
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
