import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as retryDelay } from "node:timers/promises";
import {
  WorkerInferenceJournal,
  recoveryIdentity,
  recoveryQueueIdentity,
  type InferenceRecoveryIdentity,
  type InferenceJournalRecord,
} from "./inference-journal.js";
import type { NativeInferenceOwnership } from "./native-inference-ownership.js";
import { UnstartedInferenceUnavailableError } from "./inference-withdrawal.js";
import {
  observeInferenceCommand,
  observeInferenceCommandAdmission,
} from "./inference-command.js";
import {
  providerInferenceConfigurationSchema,
  providerInferenceCatalogSchema,
  type ProviderInferenceCatalog,
  inferenceNeverStarted,
  inferenceNativeExecutionSchema,
  type InferenceNativeExecution,
  type NativeInferenceRecoveryResult,
  type NativeGoalRecovery,
  type TaskGoalCycleRecovery,
  type InferenceOperationStatus,
  type InferencePoolStatus,
  type InferenceTicketState,
  type InferenceTiming,
  type ProviderInferenceConfiguration,
  type WorkerInferenceStatus,
} from "@cantrip/protocol";

const operationLifetimeBrand = Symbol("worker-inference-operation-lifetime");

/** Issued only after the caller owns a canonical live operation. Retaining this
 * handle preserves exact redelivery; closing it never settles model execution. */
export interface InferenceOperationLifetime {
  readonly [operationLifetimeBrand]: true;
  readonly operationId: string;
  readonly runtimeGeneration: string;
  assertCurrent(): void;
  close(): void;
}

/** Stable identity from an existing one-time canonical execution admission.
 * The source, rather than a cache window, decides whether first use is valid. */
export interface InferenceOperationSource {
  readonly operationId: string;
  readonly nativeTransportGeneration: string | null;
  /** A worker-level canonical claim can bind its first actual native process
   * lazily. Later attempts must keep that same transport incarnation. */
  bindNativeTransport?(generation: string): void;
  readonly signal?: AbortSignal;
  readonly released: Promise<void>;
  assertCurrent(): void;
}

interface OperationLifetimeState {
  operationId: string;
  closed: boolean;
  ticket?: Ticket;
  rejection?: Error;
  withdrawal?: Promise<InferenceJournalRecord>;
  withdrawalIdentity?: string;
}

export interface InferenceRequest {
  purpose?: InferenceOperationStatus["purpose"];
  operationId: string;
  lifetime: InferenceOperationLifetime;
  providerId: string;
  providerCreationRevision?: number;
  chatId?: string | null;
  projectId?: string | null;
  recoveryKey?: string | null;
  recovery?: InferenceRecoveryIdentity | null;
  /** The execution owner's signal, never the lifetime of an observing UI. */
  signal?: AbortSignal;
}

export type InferenceSettlement =
  "completed" | "failed" | "interrupted" | "runtime-exited" | "never-started";

export interface InferenceLease {
  /** Canonical unused Task cycle actually adopted by this ticket, if any. */
  taskGoalRecovery(): TaskGoalCycleRecovery | null;
  readonly id: string;
  /** Cancellation asks the owner to stop; it does not free running capacity. */
  readonly signal: AbortSignal;
  start(): void;
  /** Persist exact native correlation before its private model gate can return. */
  bindNative(execution: InferenceNativeExecution): Promise<void>;
  /** Native execution established that it cannot infer until it resumes. */
  suspend(): void;
  /** Rejoin at the tail before any resumed inference. */
  resume(): Promise<void>;
  /** Call only after confirmed execution settlement, never on observation timeout. */
  settle(outcome: InferenceSettlement): void;
}

export interface InferenceTicket {
  /** Actual durable enqueue acknowledgement, independent of capacity grant. */
  readonly queued: Promise<void>;
  readonly ready: Promise<InferenceLease>;
  status(): InferenceOperationStatus;
  cancel(reason?: Error): void;
  /** Seal this exact unused reservation before returning durable no-start
   * evidence. This is not permission to replay its canonical input. */
  withdrawUnstarted(reason?: Error): Promise<InferenceJournalRecord>;
}

export interface InferenceRuntime {
  readonly generation: string;
  prepareNativeLaunch(): Promise<NodeJS.ProcessEnv>;
  request(input: InferenceRequest): InferenceTicket;
  /** Seal an actual source before it has requested capacity. No slot is taken. */
  withdrawBeforeRequest(
    input: InferenceRequest,
    reason: Error,
    settled: Promise<void>,
  ): Promise<InferenceJournalRecord>;
  /** Call only with positive canonical live-operation authority. */
  createOperationLifetime(operationId: string): InferenceOperationLifetime;
  /** Retire only after the associated runtime is confirmed unable to execute. */
  exited(): Promise<void>;
}

interface Runtime {
  generation: string;
  records: Map<string, Ticket>;
  lifetimes: WeakMap<InferenceOperationLifetime, OperationLifetimeState>;
  retired: boolean;
  prepared: boolean;
  retiring: Promise<void> | null;
  handle: InferenceRuntime;
}

interface Pool {
  configuration: ProviderInferenceConfiguration;
  disabled: boolean;
  catalogCreationKnown: boolean;
  configurationKnown: boolean;
  active: Set<Ticket>;
  suspended: Set<Ticket>;
  queue: Ticket[];
}

interface Ticket {
  taskGoalRecovery: TaskGoalCycleRecovery | null;
  sequence: number;
  restoredOrder: number | null;
  recoveryPending: boolean;
  runtime: Runtime;
  pool: Pool;
  input: InferenceRequest;
  state: InferenceTicketState;
  stateSince: number;
  timing: InferenceTiming;
  controller: AbortController;
  enqueuedAt: number;
  grantedAt: number | null;
  startedAt: number | null;
  resolve(lease: InferenceLease): void;
  reject(error: Error): void;
  resolveQueued(): void;
  rejectQueued(error: Error): void;
  stopListening(): void;
  handle: InferenceTicket;
  lease: InferenceLease;
  resuming?: Promise<void>;
  observe?: (state: InferenceTicketState) => void;
  admitted?: () => void;
  journalKey: string | null;
  durableQueueReady: boolean;
  nativeExecution: InferenceNativeExecution | null;
  nativeBinding: Promise<void> | null;
  releaseReceipt: Promise<InferenceJournalRecord> | null;
  withdrawal: Promise<InferenceJournalRecord> | null;
}

export interface InferenceDiagnostic {
  action:
    | "queued"
    | "granted"
    | "running"
    | "cancel-requested"
    | "suspended"
    | "resumed"
    | "released"
    | "recovery-requeued"
    | "recovery-unavailable"
    | "recovery-retired"
    | "recovery-unresolved";
  workerId: string;
  workerGeneration: string;
  runtimeGeneration: string;
  operationId: string;
  providerId: string;
  state: InferenceTicketState;
  timing?: InferenceTiming;
  outcome?: InferenceSettlement;
  previousWorkerGeneration?: string;
}

function timingField(
  state: InferenceTicketState,
): keyof InferenceTiming | null {
  switch (state) {
    case "waiting":
      return "queueWaitMs";
    case "granted":
      return "reservedMs";
    case "running":
    case "cancelling":
      return "executionMs";
    case "suspended":
      return "suspendedMs";
    case "released":
      return null;
  }
}

interface RestoredWaiter {
  record: InferenceJournalRecord;
  records: InferenceJournalRecord[];
  taskInputNotDispatched: Set<string>;
  goalInputNotDispatched: Set<string>;
  taskGoalCycleNotDispatched: Set<string>;
  enqueuedAt: number;
  claimed: Ticket | null;
  goalRecovery?: NativeGoalRecovery;
  taskGoalRecovery?: TaskGoalCycleRecovery;
}

interface GoalRecoveryPreparation {
  chatId: string;
  providerId: string;
  recovery: NativeGoalRecovery | TaskGoalCycleRecovery;
  preparing: boolean;
  unavailable: boolean;
}

function goalPreparationKey(
  chatId: string,
  providerId: string,
  recovery: NativeGoalRecovery | TaskGoalCycleRecovery,
): string {
  if ("cycle" in recovery)
    return JSON.stringify([
      "task-goal",
      chatId,
      providerId,
      recovery.sourceKey,
      recovery.cycle.cycleId,
      recovery.threadId,
      recovery.cycle.goalEpoch,
      recovery.cycle.orderEpoch,
    ]);
  const source = recovery.source;
  return JSON.stringify([
    chatId,
    providerId,
    source.operationId,
    source.operationGeneration,
    source.threadId,
    source.goalEpoch,
    recovery.orderEpoch ?? 0,
  ]);
}

function goalPreparationEpisode(
  chatId: string,
  providerId: string,
  threadId: string,
  goalEpoch: string,
  orderEpoch: number,
  taskCycleId?: string,
): string {
  return JSON.stringify([
    chatId,
    providerId,
    threadId,
    goalEpoch,
    orderEpoch,
    ...(taskCycleId ? ["task-goal", taskCycleId] : []),
  ]);
}

/**
 * One instance per worker/server/owner, outside all project and runtime maps.
 * All state transitions are synchronous. Promise consumers and status observers
 * run only after FIFO reservations have been installed in the active set.
 */
export class WorkerInferenceAdmission {
  private readonly pools = new Map<string, Pool>();
  private readonly runtimes = new Set<Runtime>();
  /** Only live cross-provider preparations whose response source was sealed.
   * Recovery reads must join their actual settlement even if that source exits. */
  private readonly unrequestedSettlements = new Map<string, Promise<void>>();
  private readonly listeners = new Set<
    (status: WorkerInferenceStatus) => void
  >();
  private revision = 0;
  private catalogRevision: number | null = null;
  private catalogProviders = new Map<string, number>();
  private notificationPending = false;
  private closing = false;
  private closure: Promise<void> | null = null;
  private readonly journal: WorkerInferenceJournal | null;
  private sequence = 0;
  private recoveryStartup: Promise<void> | null = null;
  private recoveryInitialized = false;
  private readonly recoveryPending = new Map<string, string>();
  private readonly restored = new Map<string, RestoredWaiter>();
  private readonly goalPreparations = new Map<
    string,
    GoalRecoveryPreparation
  >();
  private readonly recoveryLifetime = new AbortController();
  private recoveryWork: Promise<void> | null = null;
  private recoveryAll = false;
  private readonly recoveryChats = new Set<string>();
  private recoveryRetry: ReturnType<typeof setTimeout> | null = null;
  private recoveryRetryMs = 1_000;

  constructor(
    private readonly scope: Pick<
      WorkerInferenceStatus,
      "serverId" | "ownerId" | "workerId" | "workerGeneration"
    >,
    private readonly onObserverError: (error: unknown) => void,
    private readonly nativeOwnership?: NativeInferenceOwnership,
    private readonly onJournalError: (error: unknown) => void = onObserverError,
    private readonly reconcileRecovery?: (
      record: InferenceJournalRecord,
      signal: AbortSignal,
    ) => Promise<NativeInferenceRecoveryResult>,
    private readonly onDiagnostic: (
      event: InferenceDiagnostic,
    ) => void = () => {},
  ) {
    this.journal = nativeOwnership
      ? new WorkerInferenceJournal(scope.workerGeneration, (command) =>
          nativeOwnership.journal(command),
        )
      : null;
    nativeOwnership?.onLost(() => {
      for (const runtime of this.runtimes) void this.retire(runtime);
    });
  }

  close(): Promise<void> {
    if (this.closure) return this.closure;
    this.closing = true;
    this.recoveryLifetime.abort(new Error("Inference ownership is retiring."));
    if (this.recoveryRetry) clearTimeout(this.recoveryRetry);
    this.recoveryRetry = null;
    this.closure = (async () => {
      const retired = [...this.runtimes].map((runtime) => this.retire(runtime));
      await Promise.all(retired);
      await this.recoveryStartup?.catch(() => {});
      await this.recoveryWork?.catch(() => {});
      await this.journal?.flush();
      await this.nativeOwnership?.close();
      this.unrequestedSettlements.clear();
      this.goalPreparations.clear();
    })();
    return this.closure;
  }

  /** Previous-generation metadata, for canonical receipt reconciliation. This
   * never contains inputs and is not a competing delivery queue. */
  recoverySnapshot(): readonly InferenceJournalRecord[] {
    return this.journal?.recoverySnapshot() ?? [];
  }

  /** Own only this real preparation attempt. Failure changes eligibility of a
   * fenced, unused restoration, never the ownership of an actual execution. */
  beginGoalRecoveryPreparation(input: {
    chatId: string;
    providerId: string;
    recovery: NativeGoalRecovery | TaskGoalCycleRecovery;
  }): { succeeded(): void; failed(): void; unconfirmed(): void } {
    const key = goalPreparationKey(
      input.chatId,
      input.providerId,
      input.recovery,
    );
    const previous = this.goalPreparations.get(key);
    const state: GoalRecoveryPreparation = {
      ...input,
      preparing: true,
      // A retry becomes eligible only after actual preparation succeeds.
      unavailable: previous?.unavailable ?? false,
    };
    this.goalPreparations.set(key, state);
    let ended = false;
    const update = (succeeded: boolean) => {
      if (ended || this.goalPreparations.get(key) !== state) return;
      ended = true;
      state.preparing = false;
      const eligibilityChanged = succeeded
        ? state.unavailable
        : !state.unavailable;
      if (succeeded) this.goalPreparations.delete(key);
      else {
        if (!state.unavailable)
          for (const waiter of new Set(this.restored.values()))
            if (this.goalPreparationFor(waiter) === state)
              this.diagnoseRecovery(waiter.record, "recovery-unavailable");
        state.unavailable = true;
        this.pruneGoalPreparations();
      }
      if (!eligibilityChanged) return;
      for (const pool of this.pools.values()) this.drain(pool);
      this.changed();
    };
    return {
      succeeded: () => update(true),
      failed: () => update(false),
      // Restore conservative FIFO eligibility after an ambiguous attempt.
      unconfirmed: () => update(true),
    };
  }

  private goalPreparationFor(waiter: RestoredWaiter) {
    const recovery = waiter.taskGoalRecovery ?? waiter.goalRecovery;
    return recovery && waiter.record.identity.chatId
      ? this.goalPreparations.get(
          goalPreparationKey(
            waiter.record.identity.chatId,
            waiter.record.identity.providerId,
            recovery,
          ),
        )
      : undefined;
  }

  private pruneGoalPreparations(): void {
    if (!this.goalPreparations.size) return;
    const retained = new Set<string>();
    for (const waiter of new Set(this.restored.values())) {
      const recovery = waiter.taskGoalRecovery ?? waiter.goalRecovery;
      if (recovery && waiter.record.identity.chatId)
        retained.add(
          goalPreparationKey(
            waiter.record.identity.chatId,
            waiter.record.identity.providerId,
            recovery,
          ),
        );
    }
    const pending = new Set<string>();
    for (const record of this.journal?.recoverySnapshot() ?? []) {
      const recovery = record.identity.recovery;
      if (
        this.recoveryPending.has(record.key) &&
        record.identity.chatId &&
        recovery?.threadId &&
        (recovery.autonomousGoal || recovery.taskGoalCycle)
      )
        pending.add(
          goalPreparationEpisode(
            record.identity.chatId,
            record.identity.providerId,
            recovery.threadId,
            (recovery.taskGoalCycle ?? recovery.autonomousGoal)!.goalEpoch,
            (recovery.taskGoalCycle ?? recovery.autonomousGoal)!.orderEpoch ??
              0,
            recovery.taskGoalCycle?.cycleId,
          ),
        );
    }
    for (const [key, state] of this.goalPreparations) {
      if (state.preparing || retained.has(key)) continue;
      // A real preparation may fail before its canonical metadata response
      // reaches refreshRecovery. Keep that attempt only through the matching
      // in-flight read; a retired/different source cannot inherit its failure.
      const taskRecovery = "cycle" in state.recovery ? state.recovery : null;
      const managedRecovery =
        "source" in state.recovery ? state.recovery : null;
      if (
        !pending.has(
          goalPreparationEpisode(
            state.chatId,
            state.providerId,
            taskRecovery?.threadId ?? managedRecovery!.source.threadId,
            taskRecovery?.cycle.goalEpoch ?? managedRecovery!.source.goalEpoch,
            taskRecovery?.cycle.orderEpoch ?? managedRecovery?.orderEpoch ?? 0,
            taskRecovery?.cycle.cycleId,
          ),
        )
      )
        this.goalPreparations.delete(key);
    }
  }
  /** Join the actual keeper owner; takeover fences surviving prior processes. */
  async confirmNativeOwnership(): Promise<void> {
    if (!this.journal)
      throw new Error("Native inference ownership is unavailable.");
    await this.prepareRecovery();
    await this.journal.snapshot();
  }

  /** Recover a previously sealed handoff source after a lost acknowledgement.
   * Every matching physical alias must be durably released without inference. */
  async withdrawalRecord(expected: {
    operationId: string;
    operationGeneration: string;
    chatId: string;
  }): Promise<InferenceJournalRecord | null> {
    if (!this.journal) return null;
    const records = (await this.journal.snapshot()).filter(
      (record) =>
        record.identity.operationId === expected.operationGeneration &&
        record.identity.chatId === expected.chatId &&
        record.identity.recovery?.commandId === expected.operationId &&
        record.identity.recovery.commandGeneration ===
          expected.operationGeneration,
    );
    if (
      !records.length ||
      records.some(
        (record) =>
          record.state !== "released" ||
          record.outcome !== "never-started" ||
          Boolean(record.nativeExecution),
      )
    )
      return null;
    // On restart, the keeper's actual takeover fences all prior native runtimes
    // before permitting snapshot reads. In this worker, retain the live label's
    // settlement independently of the response runtime or source registry.
    await Promise.all(
      records.map((record) => this.unrequestedSettlements.get(record.key)),
    );
    return records.reduce((latest, record) =>
      record.revision > latest.revision ? record : latest,
    );
  }

  /** Only after canonical acknowledgement and closure of the actual source.
   * This retires metadata; it cannot release or revoke model execution. */
  async retireWithdrawal(record: InferenceJournalRecord): Promise<void> {
    if (
      !this.journal ||
      record.state !== "released" ||
      record.outcome !== "never-started" ||
      record.nativeExecution
    )
      throw new Error(
        "Withdrawal retirement requires exact no-start evidence.",
      );
    await this.unrequestedSettlements.get(record.key);
    await this.journal.forget(record);
  }

  /** Full membership is revisioned separately from each provider's limit. */
  configureCatalog(input: ProviderInferenceCatalog): boolean {
    const catalog = providerInferenceCatalogSchema.parse(input);
    if (
      this.catalogRevision !== null &&
      catalog.catalogRevision < this.catalogRevision
    )
      return false;
    const providers = new Map<string, number>();
    for (const configuration of catalog.configurations) {
      if (
        providers.has(configuration.providerId) ||
        configuration.inferenceCatalogCreatedRevision > catalog.catalogRevision
      )
        throw new Error(
          "The provider inference catalog has inconsistent membership.",
        );
      providers.set(
        configuration.providerId,
        configuration.inferenceCatalogCreatedRevision,
      );
    }
    if (
      this.catalogRevision === catalog.catalogRevision &&
      (providers.size !== this.catalogProviders.size ||
        [...providers].some(
          ([id, created]) => this.catalogProviders.get(id) !== created,
        ))
    )
      throw new Error("Conflicting provider inference catalog revision.");
    this.catalogRevision = catalog.catalogRevision;
    this.catalogProviders = providers;
    for (const pool of [...this.pools.values()]) {
      if (
        !providers.has(pool.configuration.providerId) &&
        pool.configuration.inferenceCatalogCreatedRevision <=
          catalog.catalogRevision
      )
        this.disablePool(pool);
    }
    for (const configuration of catalog.configurations) {
      if (
        (this.pools.get(configuration.providerId)?.configuration
          .inferenceCatalogCreatedRevision ?? 0) > catalog.catalogRevision
      )
        continue;
      this.configure(configuration);
    }
    this.changed();
    return true;
  }

  private unavailableProvider(): Error {
    return Object.assign(
      new Error(
        "The inference provider was removed or replaced. Select an available provider.",
      ),
      { code: "provider-removed" },
    );
  }

  private disablePool(pool: Pool): void {
    pool.disabled = true;
    // A running turn retains capacity until physical settlement. Queued,
    // reserved and confirmed-suspended operations cannot start another turn.
    const operations = new Set([
      ...pool.queue,
      ...pool.active,
      ...pool.suspended,
    ]);
    for (const ticket of operations)
      if (["waiting", "granted", "suspended"].includes(ticket.state))
        this.cancel(ticket, this.unavailableProvider());
    this.prunePool(pool);
    this.changed();
  }

  private prunePool(pool: Pool): void {
    if (
      pool.disabled &&
      pool.active.size === 0 &&
      pool.suspended.size === 0 &&
      pool.queue.length === 0 &&
      this.pools.get(pool.configuration.providerId) === pool
    )
      this.pools.delete(pool.configuration.providerId);
  }

  /** Runtime envelopes can initialize a newly created provider after an older
   * membership snapshot, but cannot resurrect one removed by that snapshot. */
  configure(input: {
    providerId: string;
    maxConcurrentInference?: number;
    inferenceConfigRevision?: number;
    inferenceCatalogCreatedRevision?: number;
  }): boolean {
    const pool = this.pools.get(input.providerId);
    const configuration = providerInferenceConfigurationSchema.parse({
      ...input,
      maxConcurrentInference:
        input.maxConcurrentInference ??
        pool?.configuration.maxConcurrentInference,
      inferenceConfigRevision:
        input.maxConcurrentInference === undefined
          ? (pool?.configuration.inferenceConfigRevision ?? 0)
          : input.inferenceConfigRevision,
      inferenceCatalogCreatedRevision:
        input.inferenceCatalogCreatedRevision ??
        (pool?.catalogCreationKnown
          ? pool.configuration.inferenceCatalogCreatedRevision
          : (this.catalogProviders.get(input.providerId) ??
            pool?.configuration.inferenceCatalogCreatedRevision)) ??
        0,
    });
    const created = configuration.inferenceCatalogCreatedRevision;
    const creationKnown =
      input.inferenceCatalogCreatedRevision !== undefined ||
      this.catalogProviders.has(input.providerId);
    const known = this.catalogProviders.get(configuration.providerId);
    if (
      this.catalogRevision !== null &&
      ((known === undefined && created <= this.catalogRevision) ||
        (known !== undefined &&
          created !== known &&
          created <= this.catalogRevision))
    )
      return false;
    if (pool && created < pool.configuration.inferenceCatalogCreatedRevision)
      return false;
    if (!pool) {
      this.pools.set(configuration.providerId, {
        configuration,
        disabled: false,
        catalogCreationKnown: creationKnown,
        configurationKnown: input.maxConcurrentInference !== undefined,
        active: new Set(),
        suspended: new Set(),
        queue: [],
      });
      this.changed();
      return true;
    }
    const replaced =
      pool.catalogCreationKnown &&
      created > pool.configuration.inferenceCatalogCreatedRevision;
    if (!pool.catalogCreationKnown && creationKnown) {
      // Learning the creation stamp of a legacy pool is not a replacement and
      // must not cancel valid queued work or overwrite a newer known limit.
      pool.configuration = {
        ...pool.configuration,
        inferenceCatalogCreatedRevision: created,
      };
      pool.catalogCreationKnown = true;
      this.changed();
    }
    if (replaced) {
      this.disablePool(pool);
      this.pools.set(configuration.providerId, pool);
    } else {
      if (pool.disabled) return false;
      // Legacy omissions do not reset a known limit or configuration revision.
      if (
        input.maxConcurrentInference === undefined &&
        input.inferenceConfigRevision === undefined
      )
        return true;
      if (
        configuration.inferenceConfigRevision <
        pool.configuration.inferenceConfigRevision
      )
        return false;
      if (
        configuration.inferenceConfigRevision ===
        pool.configuration.inferenceConfigRevision
      ) {
        if (
          pool.configurationKnown ||
          input.maxConcurrentInference === undefined
        ) {
          if (
            configuration.maxConcurrentInference !==
            pool.configuration.maxConcurrentInference
          )
            throw new Error(
              "Conflicting provider inference configuration revision.",
            );
          return true;
        }
        // A legacy envelope's fallback 8 is not an authoritative revision-zero
        // limit. The first actual configuration may establish a different value.
      }
    }
    pool.configuration = configuration;
    pool.configurationKnown = replaced
      ? input.maxConcurrentInference !== undefined
      : pool.configurationKnown || input.maxConcurrentInference !== undefined;
    pool.disabled = false;
    this.drain(pool);
    this.changed();
    return true;
  }

  /** The opaque runtime handle prevents old callbacks from acting on a replacement. */
  createRuntime(): InferenceRuntime {
    if (this.closing)
      throw new Error("The inference admission service is closing.");
    const runtime: Runtime = {
      generation: randomUUID(),
      records: new Map(),
      lifetimes: new WeakMap(),
      retired: false,
      prepared: !this.nativeOwnership,
      retiring: null,
      handle: {
        get generation() {
          return runtime.generation;
        },
        prepareNativeLaunch: async () => {
          await this.prepareRecovery();
          const environment = await this.nativeOwnership?.prepare(
            runtime.generation,
          );
          if (this.closing || runtime.retiring || runtime.retired)
            throw new Error("The inference runtime was retired during launch.");
          runtime.prepared = true;
          for (const pool of this.pools.values()) this.drain(pool);
          return environment ?? {};
        },
        request: (input) => this.request(runtime, input),
        withdrawBeforeRequest: (input, reason, settled) =>
          this.withdrawBeforeRequest(runtime, input, reason, settled),
        createOperationLifetime: (operationId) => {
          if (
            this.closing ||
            runtime.retiring ||
            runtime.retired ||
            !runtime.prepared
          )
            throw new Error("The inference runtime is not live.");
          const state: OperationLifetimeState = { operationId, closed: false };
          const lifetime: InferenceOperationLifetime = Object.freeze({
            [operationLifetimeBrand]: true as const,
            operationId,
            runtimeGeneration: runtime.generation,
            assertCurrent: () => {
              if (state.closed)
                throw (
                  state.rejection ??
                  new Error("The canonical inference operation has closed.")
                );
              if (
                this.closing ||
                runtime.retiring ||
                runtime.retired ||
                !runtime.prepared
              )
                throw new Error("The inference runtime is not live.");
            },
            close: () => {
              if (state.closed) return;
              state.closed = true;
              const ticket = state.ticket;
              // Canonical ownership ended before any model request began.
              // A running/suspended/resuming turn still needs real settlement.
              if (
                ticket?.startedAt === null &&
                (ticket.state === "waiting" || ticket.state === "granted")
              )
                this.cancel(
                  ticket,
                  new Error(
                    "Canonical inference ownership ended before execution.",
                  ),
                );
            },
          });
          runtime.lifetimes.set(lifetime, state);
          return lifetime;
        },
        exited: () => this.retire(runtime),
      },
    };
    this.runtimes.add(runtime);
    return runtime.handle;
  }

  subscribe(listener: (status: WorkerInferenceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): WorkerInferenceStatus {
    const pools: InferencePoolStatus[] = [];
    for (const pool of this.pools.values()) {
      const queued = this.queueEntries(pool);
      const suspended = [...pool.suspended];
      const unavailable = [...new Set(this.restored.values())].filter(
        (waiter) =>
          !pool.disabled &&
          waiter.record.identity.providerId === pool.configuration.providerId &&
          this.goalPreparationFor(waiter)?.unavailable &&
          (!waiter.claimed || waiter.claimed.state === "released"),
      );
      pools.push({
        ...pool.configuration,
        activeCount: pool.active.size,
        queuedCount: queued.length,
        operations: [
          ...[...pool.active].map((ticket) => this.status(ticket)),
          ...queued.map((entry, index) =>
            entry.ticket
              ? this.status(entry.ticket, index + 1)
              : this.restoredStatus(entry.waiter!, index + 1),
          ),
          ...unavailable.map((waiter) => this.restoredStatus(waiter, null)),
          ...suspended.map((ticket) => this.status(ticket)),
        ],
      });
    }
    return {
      ...this.scope,
      revision: this.revision,
      pools,
      ...(this.catalogRevision === null
        ? {}
        : { providerCatalogRevision: this.catalogRevision }),
    };
  }

  private restoredStatus(
    waiter: RestoredWaiter,
    queuePosition: number | null,
  ): InferenceOperationStatus {
    return {
      purpose: "turn",
      operationId: waiter.record.identity.operationId,
      runtimeGeneration: waiter.record.identity.runtimeGeneration,
      providerId: waiter.record.identity.providerId,
      chatId: waiter.record.identity.chatId,
      projectId: waiter.record.identity.projectId,
      state: queuePosition === null ? "recovering" : "waiting",
      queuePosition,
      enqueuedAt: waiter.enqueuedAt,
      grantedAt: null,
      startedAt: null,
    };
  }

  private withdrawBeforeRequest(
    runtime: Runtime,
    input: InferenceRequest,
    reason: Error,
    settled: Promise<void>,
  ): Promise<InferenceJournalRecord> {
    const lifetime = runtime.lifetimes.get(input.lifetime);
    const identity = {
      operationId: input.operationId,
      providerId: input.providerId,
      runtimeGeneration: runtime.generation,
      recoveryKey: input.recoveryKey ?? null,
      recovery: input.recovery ?? null,
      chatId: input.chatId ?? null,
      projectId: input.projectId ?? null,
    };
    const signature = JSON.stringify([
      identity.operationId,
      identity.providerId,
      identity.runtimeGeneration,
      identity.recoveryKey,
      recoveryIdentity(identity.recovery),
      identity.chatId,
      identity.projectId,
    ]);
    if (lifetime?.withdrawal) {
      if (lifetime.withdrawalIdentity !== signature)
        throw new Error(
          "The unrequested withdrawal changed its canonical identity.",
        );
      return lifetime.withdrawal;
    }
    if (
      !this.journal ||
      this.closing ||
      runtime.retiring ||
      runtime.retired ||
      !runtime.prepared ||
      !this.runtimes.has(runtime) ||
      !lifetime ||
      lifetime.operationId !== input.operationId ||
      lifetime.closed ||
      lifetime.ticket ||
      runtime.records.has(input.operationId)
    )
      throw new UnstartedInferenceUnavailableError(
        "The source is no longer an unrequested live operation.",
      );
    input.signal?.throwIfAborted();
    // Seal before any await. A label completing concurrently cannot acquire
    // the response ticket after this point. This never joins a provider queue.
    lifetime.closed = true;
    lifetime.rejection = reason;
    lifetime.withdrawalIdentity = signature;
    const journal = this.journal;
    const key = journal.key(runtime.generation, input.operationId);
    this.unrequestedSettlements.set(key, settled);
    void settled.then(
      () => {
        if (this.unrequestedSettlements.get(key) === settled)
          this.unrequestedSettlements.delete(key);
      },
      (error) => this.reportJournalError(error),
    );
    lifetime.withdrawal = journal
      .sealUnstarted(key, identity)
      .then(async (record) => {
        await settled;
        return record;
      });
    void lifetime.withdrawal.catch(() => {});
    return lifetime.withdrawal;
  }

  private request(runtime: Runtime, input: InferenceRequest): InferenceTicket {
    if (
      this.closing ||
      runtime.retiring ||
      runtime.retired ||
      !this.runtimes.has(runtime)
    )
      throw new Error("The inference runtime has exited.");
    if (!runtime.prepared)
      throw new Error("Native inference ownership is not prepared.");
    if (!input.operationId || !input.providerId)
      throw new Error(
        "Inference admission requires an operation and provider identity.",
      );
    const lifetime = runtime.lifetimes.get(input.lifetime);
    if (!lifetime || lifetime.operationId !== input.operationId)
      throw new Error(
        "Inference operation lifetime belongs to another runtime or operation.",
      );
    const previous = lifetime.ticket ?? runtime.records.get(input.operationId);
    if (previous) {
      if (
        previous.input.lifetime !== input.lifetime ||
        (previous.input.purpose ?? "helper") !== (input.purpose ?? "helper") ||
        previous.input.providerId !== input.providerId ||
        previous.input.providerCreationRevision !==
          input.providerCreationRevision ||
        previous.input.chatId !== input.chatId ||
        previous.input.projectId !== input.projectId ||
        (previous.input.recoveryKey ?? null) !== (input.recoveryKey ?? null) ||
        recoveryIdentity(previous.input.recovery) !==
          recoveryIdentity(input.recovery)
      )
        throw new Error(
          "An inference operation cannot change identity during redelivery.",
        );
      return previous.handle;
    }
    if (lifetime.closed)
      throw (
        lifetime.rejection ??
        new Error("The canonical inference operation has closed.")
      );
    // Old envelopes omit configuration. They establish the default only if this
    // provider has not already received a newer authoritative configuration.
    if (!this.pools.has(input.providerId))
      this.configure({
        providerId: input.providerId,
        inferenceCatalogCreatedRevision: input.providerCreationRevision,
      });
    const pool = this.pools.get(input.providerId);
    if (
      !pool ||
      pool.disabled ||
      (input.providerCreationRevision !== undefined &&
        pool.catalogCreationKnown &&
        input.providerCreationRevision !==
          pool.configuration.inferenceCatalogCreatedRevision)
    )
      throw this.unavailableProvider();
    let resolve!: (lease: InferenceLease) => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<InferenceLease>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let resolveQueued!: () => void;
    let rejectQueued!: (error: Error) => void;
    const queued = new Promise<void>((yes, no) => {
      resolveQueued = yes;
      rejectQueued = no;
    });
    void queued.catch(() => {});
    // Admission can be cancelled before its owner starts awaiting it.
    void ready.catch(() => {});
    const ticket: Ticket = {
      taskGoalRecovery: null,
      sequence: ++this.sequence,
      restoredOrder: null,
      recoveryPending: false,
      runtime,
      pool,
      input: {
        ...input,
        recovery: input.recovery ? { ...input.recovery } : null,
      },
      state: "waiting",
      stateSince: performance.now(),
      timing: { queueWaitMs: 0, reservedMs: 0, executionMs: 0, suspendedMs: 0 },
      controller: new AbortController(),
      enqueuedAt: Date.now(),
      grantedAt: null,
      startedAt: null,
      resolve,
      reject,
      resolveQueued,
      rejectQueued,
      stopListening: () => {},
      observe: observeInferenceCommand(input.providerId),
      admitted: observeInferenceCommandAdmission(),
      journalKey:
        this.journal?.key(runtime.generation, input.operationId) ?? null,
      durableQueueReady: !this.journal,
      nativeExecution: null,
      nativeBinding: null,
      releaseReceipt: null,
      withdrawal: null,
      handle: {
        queued,
        ready,
        status: () => this.status(ticket),
        cancel: (reason) => this.cancel(ticket, reason),
        withdrawUnstarted: (reason) => this.withdrawUnstarted(ticket, reason),
      },
      lease: {
        taskGoalRecovery: () => ticket.taskGoalRecovery,
        id: randomUUID(),
        get signal() {
          return ticket.controller.signal;
        },
        start: () => this.start(ticket),
        bindNative: (execution) => this.bindNative(ticket, execution),
        suspend: () => this.suspend(ticket),
        resume: () => this.resume(ticket),
        settle: (outcome) => this.settle(ticket, outcome),
      },
    };
    runtime.records.set(input.operationId, ticket);
    lifetime.ticket = ticket;
    pool.queue.push(ticket);
    // An accepted input can arrive before its durable queue notice. Reconcile
    // this chat's physically ended Goal aliases, including an older Task cycle
    // that a newly accepted canonical input may have replaced.
    if (
      input.chatId &&
      input.recovery &&
      this.journal
        ?.recoverySnapshot()
        .some(
          (record) =>
            this.recoverable(record) &&
            record.identity.chatId === input.chatId &&
            (record.identity.recovery?.autonomousGoal ||
              record.identity.recovery?.taskGoalCycle),
        )
    )
      this.wakeRecovery(input.chatId ?? undefined);
    this.diagnose(ticket, "queued");
    if (this.journal && ticket.journalKey) {
      void this.journal
        .enqueue(ticket.journalKey, {
          operationId: input.operationId,
          providerId: input.providerId,
          runtimeGeneration: runtime.generation,
          recoveryKey: input.recoveryKey ?? null,
          recovery: ticket.input.recovery ?? null,
          chatId: input.chatId ?? null,
          projectId: input.projectId ?? null,
        })
        .then(() => {
          if (ticket.state !== "waiting") return;
          // Waiting phase alone precedes durable storage. Only this positive
          // journal ACK allows the relay to release its dispatch counter.
          ticket.admitted?.();
          ticket.admitted = undefined;
          ticket.resolveQueued();
          ticket.durableQueueReady = !ticket.recoveryPending;
          this.drain(pool);
          this.changed();
        })
        .catch((error) => {
          this.cancel(ticket, error);
          this.reportJournalError(error);
        });
    }
    if (!this.journal) ticket.resolveQueued();
    if (input.signal) {
      const signal = input.signal;
      const cancel = () =>
        this.cancel(
          ticket,
          signal.reason instanceof Error ? signal.reason : undefined,
        );
      signal.addEventListener("abort", cancel, { once: true });
      ticket.stopListening = () => signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
    }
    this.adoptRestorations();
    this.drain(pool);
    ticket.observe?.(ticket.state);
    this.changed();
    return ticket.handle;
  }

  private start(ticket: Ticket): void {
    // A resolved promise may be consumed after cancellation or runtime exit.
    if (
      ticket.state !== "granted" ||
      ticket.controller.signal.aborted ||
      ticket.runtime.retired ||
      ticket.runtime.retiring ||
      (this.nativeOwnership && !this.nativeOwnership.available)
    )
      throw new Error("The inference grant is no longer available.");
    this.transition(ticket, "running");
    ticket.startedAt = Date.now();
    ticket.observe?.(ticket.state);
    this.diagnose(ticket, "running");
    this.changed();
  }

  private bindNative(
    ticket: Ticket,
    input: InferenceNativeExecution,
  ): Promise<void> {
    const execution = inferenceNativeExecutionSchema.parse(input);
    const current = () => {
      if (
        !["granted", "running"].includes(ticket.state) ||
        ticket.controller.signal.aborted ||
        ticket.runtime.retired ||
        ticket.runtime.retiring ||
        this.closing ||
        (this.nativeOwnership && !this.nativeOwnership.available)
      )
        throw new Error("The native inference binding lost its owning grant.");
    };
    current();
    if (
      ticket.nativeExecution &&
      JSON.stringify(ticket.nativeExecution) !== JSON.stringify(execution)
    )
      throw new Error("An inference grant cannot change its native execution.");
    ticket.nativeExecution = execution;
    ticket.nativeBinding ??= (async () => {
      if (this.journal && ticket.journalKey) {
        const record = await this.journal.bindNative(
          ticket.journalKey,
          execution,
        );
        if (
          JSON.stringify(record.nativeExecution) !== JSON.stringify(execution)
        )
          throw new Error(
            "The keeper did not acknowledge this native binding.",
          );
      }
      // Cancellation/retirement may overtake the durable acknowledgement. It
      // cannot make a late binding reply permission to begin model execution.
      current();
    })();
    return ticket.nativeBinding;
  }

  private cancel(
    ticket: Ticket,
    reason = new Error("Inference operation cancelled."),
  ): void {
    if (ticket.state === "released" || ticket.state === "cancelling") return;
    this.diagnose(ticket, "cancel-requested");
    const running = ticket.state === "running";
    if (running) {
      // Reserve capacity until the execution owner confirms it has stopped.
      this.transition(ticket, "cancelling");
      ticket.observe?.(ticket.state);
      this.changed();
      ticket.controller.abort(reason);
      return;
    }
    this.release(
      ticket,
      ticket.startedAt === null
        ? "never-started"
        : ticket.runtime.retiring
          ? "runtime-exited"
          : "interrupted",
    );
    ticket.reject(reason);
    ticket.controller.abort(reason);
  }

  private withdrawUnstarted(
    ticket: Ticket,
    reason = new Error("Unstarted inference reservation withdrawn."),
  ): Promise<InferenceJournalRecord> {
    if (ticket.withdrawal) return ticket.withdrawal;
    if (
      !this.journal ||
      !ticket.journalKey ||
      !["waiting", "granted"].includes(ticket.state) ||
      ticket.startedAt !== null ||
      ticket.nativeExecution ||
      ticket.recoveryPending
    )
      throw new UnstartedInferenceUnavailableError(
        "Only an unused, durably owned inference reservation can be withdrawn.",
      );
    // No await separates the state check from cancellation. A pending grant ACK
    // cannot revive this reservation, and a previously resolved ready promise
    // cannot start it after its lease signal is aborted.
    this.cancel(ticket, reason);
    ticket.withdrawal = ticket.releaseReceipt!.then((record) => {
      if (
        record.key !== ticket.journalKey ||
        record.workerGeneration !== this.scope.workerGeneration ||
        record.identity.runtimeGeneration !== ticket.runtime.generation ||
        record.identity.operationId !== ticket.input.operationId ||
        record.identity.providerId !== ticket.input.providerId ||
        recoveryIdentity(record.identity.recovery) !==
          recoveryIdentity(ticket.input.recovery) ||
        record.identity.recoveryKey !== (ticket.input.recoveryKey ?? null) ||
        record.identity.chatId !== (ticket.input.chatId ?? null) ||
        record.identity.projectId !== (ticket.input.projectId ?? null) ||
        record.state !== "released" ||
        record.outcome !== "never-started" ||
        record.nativeExecution
      )
        throw new Error(
          "Inference withdrawal did not receive its exact durable no-start receipt.",
        );
      return record;
    });
    // A lost journal acknowledgement leaves the operation sealed, without
    // inventing proof. Retrying this same owner observes the same result.
    void ticket.withdrawal.catch(() => {});
    return ticket.withdrawal;
  }

  private suspend(ticket: Ticket): void {
    if (ticket.state === "suspended") return;
    if (ticket.state !== "running" && ticket.state !== "cancelling")
      throw new Error(
        "Only a running inference can enter a native suspension boundary.",
      );
    this.transition(ticket, "suspended");
    ticket.pool.suspended.add(ticket);
    this.diagnose(ticket, "suspended");
    ticket.observe?.(ticket.state);
    ticket.pool.active.delete(ticket);
    this.drain(ticket.pool);
    if (ticket.pool.disabled) this.cancel(ticket, this.unavailableProvider());
    this.changed();
  }

  private resume(ticket: Ticket): Promise<void> {
    if (ticket.resuming) return ticket.resuming;
    if (ticket.state === "running") return Promise.resolve();
    if (ticket.state !== "suspended" || ticket.controller.signal.aborted)
      return Promise.reject(
        new Error("The suspended inference is no longer available."),
      );
    const ready = new Promise<InferenceLease>((resolve, reject) => {
      ticket.resolve = resolve;
      ticket.reject = reject;
    });
    const resuming = ready.then(() => this.start(ticket));
    ticket.resuming = resuming;
    void resuming
      .finally(() => {
        if (ticket.resuming === resuming) ticket.resuming = undefined;
      })
      .catch(() => {});
    this.transition(ticket, "waiting");
    ticket.pool.suspended.delete(ticket);
    ticket.sequence = ++this.sequence;
    ticket.restoredOrder = null;
    ticket.enqueuedAt = Date.now();
    ticket.durableQueueReady = !this.journal;
    ticket.pool.queue.push(ticket);
    this.diagnose(ticket, "resumed");
    if (this.journal && ticket.journalKey)
      void this.journal
        .requeue(ticket.journalKey)
        .then(() => {
          if (ticket.state !== "waiting") return;
          ticket.durableQueueReady = true;
          this.drain(ticket.pool);
          this.changed();
        })
        .catch((error) => {
          this.cancel(ticket, error);
          this.reportJournalError(error);
        });
    ticket.observe?.(ticket.state);
    this.drain(ticket.pool);
    this.changed();
    return resuming;
  }

  private settle(ticket: Ticket, outcome: InferenceSettlement): void {
    if (ticket.state === "released") return;
    if (outcome === "never-started" && ticket.startedAt !== null)
      throw new Error(
        "A started inference must be settled by its execution owner.",
      );
    const waiting = ticket.state === "waiting";
    this.release(ticket, outcome);
    if (waiting)
      ticket.reject(
        new Error(`Inference settled before admission: ${outcome}.`),
      );
  }

  private release(ticket: Ticket, outcome: InferenceSettlement): void {
    ticket.rejectQueued(
      new Error("Inference ended before its enqueue acknowledgement."),
    );
    this.transition(ticket, "released");
    this.diagnose(ticket, "released", outcome);
    if (this.journal && ticket.journalKey) {
      const recoverGoal =
        (ticket.input.recovery?.autonomousGoal ||
          ticket.input.recovery?.taskGoalCycle) &&
        (!ticket.nativeExecution || outcome === "never-started") &&
        recoveryQueueIdentity(ticket.input.chatId, ticket.input.recovery) &&
        (ticket.input.recovery.taskGoalCycle ||
          ticket.input.operationId ===
            ticket.input.recovery.commandGeneration) &&
        ["never-started", "runtime-exited"].includes(outcome);
      if (recoverGoal)
        this.recoveryPending.set(ticket.journalKey, ticket.input.providerId);
      ticket.releaseReceipt = recoverGoal
        ? this.releaseGoalWithRetry(
            ticket.journalKey,
            outcome,
            ticket.input.chatId ?? undefined,
          )
        : this.journal.release(ticket.journalKey, outcome);
      void ticket.releaseReceipt.catch((error) =>
        this.reportJournalError(error),
      );
    }
    ticket.observe?.(ticket.state);
    ticket.observe = undefined;
    ticket.admitted = undefined;
    ticket.stopListening();
    ticket.pool.suspended.delete(ticket);
    ticket.pool.active.delete(ticket);
    const index = ticket.pool.queue.indexOf(ticket);
    if (index >= 0) ticket.pool.queue.splice(index, 1);
    this.drain(ticket.pool);
    this.prunePool(ticket.pool);
    this.changed();
    // Every request owns a canonical lifetime, which retains its exact ticket
    // through a WeakMap. The strong runtime registry contains active work only;
    // retired sources cannot mint replacement owners from an evicted UUID.
    if (ticket.runtime.records.get(ticket.input.operationId) === ticket)
      ticket.runtime.records.delete(ticket.input.operationId);
  }

  private async releaseGoalWithRetry(
    key: string,
    outcome: InferenceSettlement,
    chatId: string | undefined,
  ) {
    let delay = 1_000;
    for (;;) {
      this.recoveryLifetime.signal.throwIfAborted();
      try {
        const record = await this.journal!.release(key, outcome);
        this.wakeRecovery(chatId);
        return record;
      } catch (error) {
        this.recoveryLifetime.signal.throwIfAborted();
        this.reportJournalError(error);
        await retryDelay(delay, undefined, {
          signal: this.recoveryLifetime.signal,
          ref: false,
        });
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private drain(pool: Pool): void {
    if (
      pool.disabled ||
      this.closing ||
      (this.journal && this.reconcileRecovery && !this.recoveryInitialized) ||
      [...this.recoveryPending.values()].includes(
        pool.configuration.providerId,
      ) ||
      (this.nativeOwnership && !this.nativeOwnership.available)
    )
      return;
    while (
      pool.queue.length &&
      pool.active.size < pool.configuration.maxConcurrentInference
    ) {
      // An asynchronous metadata write cannot let a newer waiter bypass the
      // head. Install the reservation before starting its durable grant write.
      const entry = this.queueEntries(pool)[0];
      if (!entry?.ticket) break;
      const ticket = entry.ticket;
      if (!ticket.durableQueueReady) break;
      pool.queue.splice(pool.queue.indexOf(ticket), 1);
      if (ticket.state !== "waiting") continue;
      this.transition(ticket, "granted");
      ticket.grantedAt = Date.now();
      pool.active.add(ticket);
      this.diagnose(ticket, "granted");
      ticket.observe?.(ticket.state);
      if (this.journal && ticket.journalKey)
        void this.journal
          .grant(ticket.journalKey)
          .then(() => {
            if (
              ticket.state === "granted" &&
              !ticket.controller.signal.aborted &&
              !ticket.runtime.retiring &&
              !ticket.runtime.retired
            )
              ticket.resolve(ticket.lease);
          })
          .catch((error) => {
            this.cancel(ticket, error);
            this.reportJournalError(error);
          });
      else ticket.resolve(ticket.lease);
    }
  }

  private reportJournalError(error: unknown): void {
    try {
      this.onJournalError(error);
    } catch {
      /* Diagnostics do not own tickets. */
    }
  }

  private retire(runtime: Runtime): Promise<void> {
    if (runtime.retiring) return runtime.retiring;
    if (runtime.retired) return Promise.resolve();
    // Block reentry synchronously, before cancelling waiters can drain a pool.
    let resolve!: () => void;
    runtime.retiring = new Promise<void>((done) => {
      resolve = done;
    });
    for (const pool of this.pools.values())
      pool.queue = pool.queue.filter((ticket) => ticket.runtime !== runtime);
    for (const ticket of runtime.records.values()) this.cancel(ticket);
    const settled = () => {
      this.exited(runtime);
      resolve();
    };
    if (this.nativeOwnership)
      void this.nativeOwnership.retire(runtime.generation).then(settled);
    else settled();
    return runtime.retiring;
  }

  private exited(runtime: Runtime): void {
    if (runtime.retired) return;
    runtime.retired = true;
    // No event observer, timeout, or heartbeat may call this. Its caller owns
    // native process settlement and must establish that execution has stopped.
    // Remove every waiter first so releasing a holder cannot grant this runtime
    // another ticket during retirement.
    for (const pool of this.pools.values())
      pool.queue = pool.queue.filter((ticket) => ticket.runtime !== runtime);
    for (const ticket of runtime.records.values())
      if (ticket.state === "waiting" || ticket.state === "granted")
        this.cancel(ticket);
    for (const ticket of runtime.records.values()) {
      this.settle(ticket, "runtime-exited");
      ticket.controller.abort(new Error("The inference runtime exited."));
    }
    runtime.records.clear();
    this.runtimes.delete(runtime);
    this.changed();
  }

  private status(ticket: Ticket, position?: number): InferenceOperationStatus {
    return {
      purpose: ticket.input.purpose ?? "helper",
      operationId: ticket.input.operationId,
      runtimeGeneration: ticket.runtime.generation,
      providerId: ticket.input.providerId,
      chatId: ticket.input.chatId ?? null,
      projectId: ticket.input.projectId ?? null,
      state: ticket.state,
      queuePosition:
        ticket.state === "waiting"
          ? (position ??
            this.queueEntries(ticket.pool).findIndex(
              (entry) => entry.ticket === ticket,
            ) + 1)
          : null,
      enqueuedAt: ticket.enqueuedAt,
      grantedAt: ticket.grantedAt,
      startedAt: ticket.startedAt,
      timing: this.timing(ticket),
    };
  }

  /** Charge exactly the previous state, using a monotonic clock rather than wall time. */
  private transition(ticket: Ticket, state: InferenceTicketState): void {
    const now = performance.now();
    const field = timingField(ticket.state);
    if (field) ticket.timing[field] += Math.max(0, now - ticket.stateSince);
    ticket.stateSince = now;
    ticket.state = state;
  }

  private timing(ticket: Ticket): InferenceTiming {
    const timing = { ...ticket.timing };
    const field = timingField(ticket.state);
    if (field)
      timing[field] += Math.max(0, performance.now() - ticket.stateSince);
    for (const field of Object.keys(timing) as Array<keyof InferenceTiming>)
      timing[field] = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.floor(timing[field]),
      );
    return timing;
  }

  private diagnose(
    ticket: Ticket,
    action: InferenceDiagnostic["action"],
    outcome?: InferenceSettlement,
  ): void {
    this.diagnostic({
      action,
      workerId: this.scope.workerId,
      workerGeneration: this.scope.workerGeneration,
      runtimeGeneration: ticket.runtime.generation,
      operationId: ticket.input.operationId,
      providerId: ticket.input.providerId,
      state: ticket.state,
      timing: this.timing(ticket),
      ...(outcome ? { outcome } : {}),
    });
  }

  private diagnostic(event: InferenceDiagnostic): void {
    try {
      this.onDiagnostic(event);
    } catch {
      /* Diagnostics cannot retain capacity. */
    }
  }

  private diagnoseRecovery(
    record: InferenceJournalRecord,
    action: InferenceDiagnostic["action"],
  ): void {
    this.diagnostic({
      action,
      workerId: this.scope.workerId,
      workerGeneration: this.scope.workerGeneration,
      previousWorkerGeneration: record.workerGeneration,
      runtimeGeneration: record.identity.runtimeGeneration,
      operationId: record.identity.operationId,
      providerId: record.identity.providerId,
      state: record.state,
    });
  }

  private queueEntries(pool: Pool) {
    if (pool.disabled) return [];
    const entries: Array<{
      ticket: Ticket | null;
      waiter: RestoredWaiter | null;
      order: number;
      sequence: number;
    }> = pool.queue.map((ticket) => ({
      ticket,
      waiter: null,
      order: ticket.restoredOrder ?? Infinity,
      sequence: ticket.sequence,
    }));
    for (const waiter of new Set(this.restored.values())) {
      if (
        waiter.record.identity.providerId !== pool.configuration.providerId ||
        this.goalPreparationFor(waiter)?.unavailable ||
        (waiter.claimed && waiter.claimed.state !== "released")
      )
        continue;
      entries.push({
        ticket: null,
        waiter,
        order: waiter.record.order,
        sequence: 0,
      });
    }
    return entries.sort((a, b) => a.order - b.order || a.sequence - b.sequence);
  }

  private recoverable(record: InferenceJournalRecord): boolean {
    const identity = record.identity.recovery;
    if (identity?.taskGoalCycle)
      return (
        (record.workerGeneration !== this.scope.workerGeneration ||
          (record.state === "released" &&
            ["never-started", "runtime-exited"].includes(
              record.outcome ?? "",
            ))) &&
        (!record.nativeExecution ||
          (record.state === "released" &&
            record.outcome === "never-started")) &&
        Boolean(recoveryQueueIdentity(record.identity.chatId, identity)) &&
        record.identity.operationId ===
          `native-inference:${identity.threadId}:${identity.turnId}:${identity.taskGoalCycle.scopeId}:${identity.taskGoalCycle.gateAttemptId}`
      );
    if (identity?.autonomousGoal)
      return (
        (record.workerGeneration !== this.scope.workerGeneration ||
          (record.state === "released" &&
            ["never-started", "runtime-exited"].includes(
              record.outcome ?? "",
            ))) &&
        !record.nativeExecution &&
        Boolean(recoveryQueueIdentity(record.identity.chatId, identity)) &&
        record.identity.operationId === identity.commandGeneration
      );
    if (identity?.taskInput) {
      const task = identity.taskInput;
      return (
        record.identity.chatId === task.chatId &&
        identity.messageId === task.clientMessageId &&
        record.identity.providerId === task.providerId &&
        record.identity.operationId === task.operationId
      );
    }
    return (
      inferenceNeverStarted(record) &&
      Boolean(
        record.identity.chatId &&
        identity?.commandId &&
        identity.commandGeneration &&
        identity.messageId &&
        record.identity.operationId === identity.commandGeneration,
      )
    );
  }

  /** The actual keeper takeover and journal read must not depend on a chat
   * opening. Configuration/reconnect notices can recover a cold worker too.
   * Coalesce startup with native launches, without occupying a command channel
   * or declaring capacity available before the keeper has fenced old owners. */
  private prepareRecovery(): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error("Inference ownership is retiring."));
    if (this.recoveryStartup) return this.recoveryStartup;
    const startup = (async () => {
      await this.journal?.initialize();
      if (this.closing)
        throw new Error("Inference ownership retired during recovery.");
      this.initializeRecovery();
    })();
    this.recoveryStartup = startup;
    void startup.catch((error) => {
      if (this.recoveryStartup === startup) this.recoveryStartup = null;
      if (this.closing) return;
      this.reportJournalError(error);
      this.scheduleRecoveryRetry();
    });
    return startup;
  }

  private initializeRecovery(): void {
    if (this.recoveryInitialized) return;
    if (this.reconcileRecovery)
      for (const record of this.journal?.recoverySnapshot() ?? [])
        if (this.recoverable(record))
          this.recoveryPending.set(record.key, record.identity.providerId);
    this.recoveryInitialized = true;
    this.wakeRecovery();
  }

  /** Existing queue/reconnect notifications wake metadata reconciliation only. */
  wakeRecovery(chatId?: string): void {
    if (!this.journal || !this.reconcileRecovery || this.closing) return;
    if (!this.recoveryInitialized) {
      // Startup installs all recoverable records before processing notices;
      // a chat-specific wake cannot accidentally omit the other projects.
      void this.prepareRecovery();
      return;
    }
    for (const record of this.journal.recoverySnapshot())
      if (
        this.recoverable(record) &&
        record.identity.recovery?.autonomousGoal &&
        (!chatId || record.identity.chatId === chatId)
      )
        this.recoveryPending.set(record.key, record.identity.providerId);
    if (chatId) this.recoveryChats.add(chatId);
    else this.recoveryAll = true;
    if (this.recoveryWork) return;
    this.recoveryWork = this.refreshRecovery().finally(() => {
      this.recoveryWork = null;
      if (this.recoveryAll || this.recoveryChats.size) this.wakeRecovery();
    });
    void this.recoveryWork.catch((error) => this.reportJournalError(error));
  }

  private async refreshRecovery(): Promise<void> {
    let failed = false;
    do {
      const all = this.recoveryAll;
      const chats = new Set(this.recoveryChats);
      this.recoveryAll = false;
      this.recoveryChats.clear();
      const records = (this.journal?.recoverySnapshot() ?? []).filter(
        (record) =>
          this.recoverable(record) &&
          (all || chats.has(record.identity.chatId!)),
      );
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, records.length) }, async () => {
          while (next < records.length && !this.closing) {
            const record = records[next++]!;
            try {
              const result = await this.reconcileRecovery!(
                record,
                this.recoveryLifetime.signal,
              );
              if (
                this.closing ||
                !this.journal!.recoverySnapshot().some(
                  (item) => item.key === record.key,
                )
              )
                continue;
              if (result.key !== record.key)
                throw new Error(
                  "Recovery returned another admission identity.",
                );
              if (result.disposition === "retired") {
                const claimed = this.restored.get(record.key)?.claimed;
                // An accepted replacement owns its own pause/cancel lifecycle.
                // Do not cancel it from an older metadata snapshot or remove a
                // source record while its durable adoption is still in flight.
                if (claimed?.state !== "waiting") {
                  await this.journal!.forget(record);
                  this.removeRestoration(record.key);
                  this.diagnoseRecovery(record, "recovery-retired");
                }
              } else if (result.disposition === "requeued") {
                const taskCycle = record.identity.recovery?.taskGoalCycle;
                if (
                  taskCycle &&
                  (result.taskGoalCycleNotDispatched !== true ||
                    !result.taskGoalRecovery ||
                    result.taskGoalRecovery.settled ||
                    result.taskGoalRecovery.workerId !== this.scope.workerId ||
                    result.taskGoalRecovery.providerId !==
                      record.identity.providerId ||
                    result.taskGoalRecovery.threadId !==
                      record.identity.recovery?.threadId ||
                    result.taskGoalRecovery.cycle.cycleId !==
                      taskCycle.cycleId ||
                    result.taskGoalRecovery.cycle.goalEpoch !==
                      taskCycle.goalEpoch ||
                    result.taskGoalRecovery.cycle.orderEpoch !==
                      taskCycle.orderEpoch ||
                    result.taskGoalRecovery.cycle.modelRouteId !==
                      taskCycle.modelRouteId ||
                    result.taskGoalRecovery.cycle.providerAccountId !==
                      taskCycle.providerAccountId)
                )
                  throw new Error(
                    "Recovery returned another unused Task Goal cycle.",
                  );
                const goal = record.identity.recovery?.autonomousGoal;
                if (
                  result.goalRecovery &&
                  (!goal ||
                    result.goalInputNotDispatched !== true ||
                    result.goalRecovery.source.threadId !==
                      record.identity.recovery?.threadId ||
                    result.goalRecovery.source.goalEpoch !== goal.goalEpoch ||
                    (result.goalRecovery.orderEpoch ?? 0) !==
                      (goal.orderEpoch ?? 0) ||
                    (result.goalRecovery.providerId ??
                      record.identity.providerId) !==
                      record.identity.providerId)
                )
                  throw new Error(
                    "Recovery returned another unused Goal cycle.",
                  );
                if (
                  !this.pools.has(record.identity.providerId) &&
                  (this.catalogRevision === null ||
                    this.catalogProviders.has(record.identity.providerId))
                )
                  this.configure({ providerId: record.identity.providerId });
                if (!this.restored.has(record.key)) {
                  const logicalIdentity = recoveryQueueIdentity(
                    record.identity.chatId,
                    record.identity.recovery,
                  );
                  const previous = [...new Set(this.restored.values())].find(
                    (waiter) =>
                      logicalIdentity !== null &&
                      recoveryQueueIdentity(
                        waiter.record.identity.chatId,
                        waiter.record.identity.recovery,
                      ) === logicalIdentity,
                  );
                  const waiter: RestoredWaiter = previous ?? {
                    record,
                    records: [],
                    taskInputNotDispatched: new Set<string>(),
                    goalInputNotDispatched: new Set<string>(),
                    taskGoalCycleNotDispatched: new Set<string>(),
                    enqueuedAt: Date.now(),
                    claimed: null,
                  };
                  waiter.records.push(record);
                  if (
                    result.taskInputNotDispatched === true &&
                    record.identity.recovery?.taskInput
                  )
                    waiter.taskInputNotDispatched.add(record.key);
                  if (
                    result.goalInputNotDispatched === true &&
                    record.identity.recovery?.autonomousGoal
                  )
                    waiter.goalInputNotDispatched.add(record.key);
                  if (result.taskGoalCycleNotDispatched === true && taskCycle)
                    waiter.taskGoalCycleNotDispatched.add(record.key);
                  if (record.order < waiter.record.order)
                    waiter.record = record;
                  this.restored.set(record.key, waiter);
                  this.diagnoseRecovery(record, "recovery-requeued");
                }
                const waiter = this.restored.get(record.key)!;
                if (result.goalRecovery)
                  waiter.goalRecovery = result.goalRecovery;
                if (result.taskGoalRecovery)
                  waiter.taskGoalRecovery = result.taskGoalRecovery;
              } else {
                // Uncertain input is not eligible for whole-prompt replay. Keep
                // its evidence for canonical runtime reconciliation, not a slot.
                this.removeRestoration(record.key);
                if (this.recoveryPending.has(record.key))
                  this.diagnoseRecovery(record, "recovery-unresolved");
              }
              // A newer producer can arrive while this receipt was being
              // reconciled. Keep its barrier through the next canonical read;
              // an older unresolved response must not let that retry overtake
              // the ordinal it is about to adopt.
              if (
                result.disposition === "retired" ||
                !(
                  this.recoveryAll ||
                  this.recoveryChats.has(record.identity.chatId ?? "")
                )
              )
                this.recoveryPending.delete(record.key);
              this.adoptRestorations();
            } catch (error) {
              if (!this.closing) {
                failed = true;
                this.reportJournalError(error);
              }
            }
          }
        }),
      );
      for (const pool of this.pools.values()) this.drain(pool);
      this.pruneGoalPreparations();
      this.changed();
    } while (!this.closing && (this.recoveryAll || this.recoveryChats.size));
    if (failed) this.scheduleRecoveryRetry();
    else this.recoveryRetryMs = 1_000;
  }

  private scheduleRecoveryRetry(): void {
    if (this.closing || this.recoveryRetry) return;
    this.recoveryRetry = setTimeout(() => {
      this.recoveryRetry = null;
      this.wakeRecovery();
    }, this.recoveryRetryMs);
    this.recoveryRetry.unref();
    this.recoveryRetryMs = Math.min(this.recoveryRetryMs * 2, 30_000);
  }

  private adoptRestorations(): void {
    for (const waiter of new Set(this.restored.values())) {
      if (waiter.claimed) continue;
      const logicalIdentity = recoveryQueueIdentity(
        waiter.record.identity.chatId,
        waiter.record.identity.recovery,
      );
      if (logicalIdentity === null) continue;
      if (
        this.journal!.recoverySnapshot().some(
          (record) =>
            this.recoveryPending.has(record.key) &&
            recoveryQueueIdentity(
              record.identity.chatId,
              record.identity.recovery,
            ) === logicalIdentity,
        )
      )
        continue;
      const ticket = [...this.pools.values()]
        .flatMap((pool) => pool.queue)
        .find(
          (ticket) =>
            ticket.state === "waiting" &&
            ticket.startedAt === null &&
            !ticket.recoveryPending &&
            recoveryQueueIdentity(
              ticket.input.chatId,
              ticket.input.recovery,
            ) === logicalIdentity,
        );
      if (!ticket?.journalKey) continue;
      waiter.claimed = ticket;
      ticket.taskGoalRecovery = waiter.taskGoalRecovery ?? null;
      ticket.recoveryPending = true;
      ticket.durableQueueReady = false;
      const sameProvider = waiter.records.filter(
        (record) => record.identity.providerId === ticket.input.providerId,
      );
      const orders = sameProvider.map((record) => record.order);
      if (ticket.restoredOrder !== null) orders.push(ticket.restoredOrder);
      ticket.restoredOrder = orders.length
        ? orders.reduce((a, b) => Math.min(a, b))
        : null;
      const records = [...waiter.records];
      const identity = {
        operationId: ticket.input.operationId,
        providerId: ticket.input.providerId,
        runtimeGeneration: ticket.runtime.generation,
        recoveryKey: ticket.input.recoveryKey ?? null,
        recovery: ticket.input.recovery ?? null,
        chatId: ticket.input.chatId ?? null,
        projectId: ticket.input.projectId ?? null,
      };
      void this.adoptWithRetry(
        ticket,
        identity,
        records,
        new Set(waiter.taskInputNotDispatched),
        new Set(waiter.goalInputNotDispatched),
        new Set(waiter.taskGoalCycleNotDispatched),
      )
        .then(() => {
          for (const record of records) this.removeRestoration(record.key);
          waiter.claimed = null;
          ticket.recoveryPending = false;
          if (ticket.state === "waiting")
            ticket.durableQueueReady = waiter.records.length === 0;
          this.adoptRestorations();
          for (const pool of this.pools.values()) this.drain(pool);
          this.changed();
        })
        .catch((error) => {
          waiter.claimed = null;
          ticket.recoveryPending = false;
          ticket.restoredOrder = null;
          this.cancel(ticket, error);
          this.reportJournalError(error);
          this.wakeRecovery(ticket.input.chatId ?? undefined);
        });
    }
  }

  private async adoptWithRetry(
    ticket: Ticket,
    identity: Parameters<WorkerInferenceJournal["adopt"]>[1],
    records: readonly InferenceJournalRecord[],
    taskInputNotDispatched: ReadonlySet<string>,
    goalInputNotDispatched: ReadonlySet<string>,
    taskGoalCycleNotDispatched: ReadonlySet<string>,
  ): Promise<void> {
    let delay = 1_000;
    const signal = AbortSignal.any([
      ticket.controller.signal,
      this.recoveryLifetime.signal,
    ]);
    for (;;) {
      signal.throwIfAborted();
      if (ticket.state !== "waiting")
        throw new Error("Recovered admission is no longer waiting.");
      try {
        await this.journal!.adopt(
          ticket.journalKey!,
          identity,
          records,
          ticket.restoredOrder,
          signal,
          taskInputNotDispatched,
          goalInputNotDispatched,
          taskGoalCycleNotDispatched,
        );
        return;
      } catch (error) {
        signal.throwIfAborted();
        this.reportJournalError(error);
        // An unobserved durable acknowledgement must retry the same physical
        // identity, not create a new turn or discard the previous FIFO record.
        await retryDelay(delay, undefined, { signal, ref: false });
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private removeRestoration(key: string): void {
    const waiter = this.restored.get(key);
    this.restored.delete(key);
    if (!waiter) return;
    waiter.taskInputNotDispatched.delete(key);
    waiter.goalInputNotDispatched.delete(key);
    waiter.taskGoalCycleNotDispatched.delete(key);
    waiter.records = waiter.records.filter((record) => record.key !== key);
    if (waiter.records.length)
      waiter.record = waiter.records.reduce((a, b) =>
        a.order < b.order ? a : b,
      );
    this.pruneGoalPreparations();
  }

  private changed(): void {
    this.revision++;
    if (this.notificationPending || !this.listeners.size) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch (error) {
          // Observability must never keep an execution ticket occupied.
          try {
            this.onObserverError(error);
          } catch {
            /* isolated observer */
          }
        }
      }
    });
  }
}
