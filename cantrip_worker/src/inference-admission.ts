import { randomUUID } from "node:crypto";
import {
  WorkerInferenceJournal,
  recoveryIdentity,
  type InferenceRecoveryIdentity,
  type InferenceJournalRecord,
} from "./inference-journal.js";
import type { NativeInferenceOwnership } from "./native-inference-ownership.js";
import { observeInferenceCommand } from "./inference-command.js";
import {
  providerInferenceConfigurationSchema,
  type InferenceOperationStatus,
  type InferencePoolStatus,
  type InferenceTicketState,
  type ProviderInferenceConfiguration,
  type WorkerInferenceStatus,
} from "@cantrip/protocol";

export interface InferenceRequest {
  purpose?: InferenceOperationStatus["purpose"];
  operationId: string;
  providerId: string;
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
  readonly id: string;
  /** Cancellation asks the owner to stop; it does not free running capacity. */
  readonly signal: AbortSignal;
  start(): void;
  /** Native execution established that it cannot infer until it resumes. */
  suspend(): void;
  /** Rejoin at the tail before any resumed inference. */
  resume(): Promise<void>;
  /** Call only after confirmed execution settlement, never on observation timeout. */
  settle(outcome: InferenceSettlement): void;
}

export interface InferenceTicket {
  readonly ready: Promise<InferenceLease>;
  status(): InferenceOperationStatus;
  cancel(reason?: Error): void;
}

export interface InferenceRuntime {
  readonly generation: string;
  prepareNativeLaunch(): Promise<NodeJS.ProcessEnv>;
  request(input: InferenceRequest): InferenceTicket;
  /** Retire only after the associated runtime is confirmed unable to execute. */
  exited(): Promise<void>;
}

interface Runtime {
  generation: string;
  records: Map<string, Ticket>;
  retired: boolean;
  prepared: boolean;
  retiring: Promise<void> | null;
  handle: InferenceRuntime;
}

interface Pool {
  configuration: ProviderInferenceConfiguration;
  active: Set<Ticket>;
  queue: Ticket[];
}

interface Ticket {
  runtime: Runtime;
  pool: Pool;
  input: InferenceRequest;
  state: InferenceTicketState;
  controller: AbortController;
  enqueuedAt: number;
  grantedAt: number | null;
  startedAt: number | null;
  resolve(lease: InferenceLease): void;
  reject(error: Error): void;
  stopListening(): void;
  handle: InferenceTicket;
  lease: InferenceLease;
  resuming?: Promise<void>;
  observe?: (state: InferenceTicketState) => void;
  journalKey: string | null;
  durableQueueReady: boolean;
}

/**
 * One instance per worker/server/owner, outside all project and runtime maps.
 * All state transitions are synchronous. Promise consumers and status observers
 * run only after FIFO reservations have been installed in the active set.
 */
export class WorkerInferenceAdmission {
  private readonly pools = new Map<string, Pool>();
  private readonly runtimes = new Set<Runtime>();
  private readonly listeners = new Set<
    (status: WorkerInferenceStatus) => void
  >();
  private revision = 0;
  private notificationPending = false;
  private closing = false;
  private readonly journal: WorkerInferenceJournal | null;

  constructor(
    private readonly scope: Pick<
      WorkerInferenceStatus,
      "serverId" | "ownerId" | "workerId" | "workerGeneration"
    >,
    private readonly onObserverError: (error: unknown) => void,
    private readonly nativeOwnership?: NativeInferenceOwnership,
    private readonly onJournalError: (error: unknown) => void = onObserverError,
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

  async close(): Promise<void> {
    this.closing = true;
    const retired = [...this.runtimes].map((runtime) => this.retire(runtime));
    await Promise.all(retired);
    await this.journal?.flush();
    await this.nativeOwnership?.close();
  }

  /** Previous-generation metadata, for canonical receipt reconciliation. This
   * never contains inputs and is not a competing delivery queue. */
  recoverySnapshot(): readonly InferenceJournalRecord[] {
    return this.journal?.recoverySnapshot() ?? [];
  }

  /** Returns false for stale configuration; equal revisions cannot change a limit. */
  configure(input: {
    providerId: string;
    maxConcurrentInference?: number;
    inferenceConfigRevision?: number;
  }): boolean {
    const configuration = providerInferenceConfigurationSchema.parse(input);
    const pool = this.pools.get(configuration.providerId);
    // Legacy commands carry no configuration authority. They can initialize a
    // default pool, but cannot overwrite even a revision-zero custom limit.
    if (
      pool &&
      input.maxConcurrentInference === undefined &&
      input.inferenceConfigRevision === undefined
    )
      return true;
    if (!pool) {
      this.pools.set(configuration.providerId, {
        configuration,
        active: new Set(),
        queue: [],
      });
      this.changed();
      return true;
    }
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
        configuration.maxConcurrentInference !==
        pool.configuration.maxConcurrentInference
      )
        throw new Error(
          "Conflicting provider inference configuration revision.",
        );
      return true;
    }
    pool.configuration = configuration;
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
      retired: false,
      prepared: !this.nativeOwnership,
      retiring: null,
      handle: {
        get generation() {
          return runtime.generation;
        },
        prepareNativeLaunch: async () => {
          const environment = await this.nativeOwnership?.prepare(
            runtime.generation,
          );
          await this.journal?.initialize();
          if (this.closing || runtime.retiring || runtime.retired)
            throw new Error("The inference runtime was retired during launch.");
          runtime.prepared = true;
          for (const pool of this.pools.values()) this.drain(pool);
          return environment ?? {};
        },
        request: (input) => this.request(runtime, input),
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
      const suspended = [...this.runtimes].flatMap((runtime) =>
        [...runtime.records.values()].filter(
          (ticket) => ticket.pool === pool && ticket.state === "suspended",
        ),
      );
      pools.push({
        ...pool.configuration,
        activeCount: pool.active.size,
        queuedCount: pool.queue.length,
        operations: [...pool.active, ...pool.queue, ...suspended].map(
          (ticket) => this.status(ticket),
        ),
      });
    }
    return { ...this.scope, revision: this.revision, pools };
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
    const previous = runtime.records.get(input.operationId);
    if (previous) {
      if (
        (previous.input.purpose ?? "helper") !== (input.purpose ?? "helper") ||
        previous.input.providerId !== input.providerId ||
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
    // Old envelopes omit configuration. They establish the default only if this
    // provider has not already received a newer authoritative configuration.
    if (!this.pools.has(input.providerId))
      this.configure({ providerId: input.providerId });
    const pool = this.pools.get(input.providerId)!;
    let resolve!: (lease: InferenceLease) => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<InferenceLease>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Admission can be cancelled before its owner starts awaiting it.
    void ready.catch(() => {});
    const ticket: Ticket = {
      runtime,
      pool,
      input: {
        ...input,
        recovery: input.recovery ? { ...input.recovery } : null,
      },
      state: "waiting",
      controller: new AbortController(),
      enqueuedAt: Date.now(),
      grantedAt: null,
      startedAt: null,
      resolve,
      reject,
      stopListening: () => {},
      observe: observeInferenceCommand(),
      journalKey:
        this.journal?.key(runtime.generation, input.operationId) ?? null,
      durableQueueReady: !this.journal,
      handle: {
        ready,
        status: () => this.status(ticket),
        cancel: (reason) => this.cancel(ticket, reason),
      },
      lease: {
        id: randomUUID(),
        get signal() {
          return ticket.controller.signal;
        },
        start: () => this.start(ticket),
        suspend: () => this.suspend(ticket),
        resume: () => this.resume(ticket),
        settle: (outcome) => this.settle(ticket, outcome),
      },
    };
    runtime.records.set(input.operationId, ticket);
    pool.queue.push(ticket);
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
          ticket.durableQueueReady = true;
          this.drain(pool);
          this.changed();
        })
        .catch((error) => {
          this.cancel(ticket, error);
          this.reportJournalError(error);
        });
    }
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
    ticket.state = "running";
    ticket.startedAt = Date.now();
    ticket.observe?.(ticket.state);
    this.changed();
  }

  private cancel(
    ticket: Ticket,
    reason = new Error("Inference operation cancelled."),
  ): void {
    if (ticket.state === "released" || ticket.state === "cancelling") return;
    const running = ticket.state === "running";
    if (running) {
      // Reserve capacity until the execution owner confirms it has stopped.
      ticket.state = "cancelling";
      ticket.observe?.(ticket.state);
      this.changed();
      ticket.controller.abort(reason);
      return;
    }
    this.release(
      ticket,
      ticket.runtime.retiring
        ? "runtime-exited"
        : ticket.startedAt === null
          ? "never-started"
          : "interrupted",
    );
    ticket.reject(reason);
    ticket.controller.abort(reason);
  }

  private suspend(ticket: Ticket): void {
    if (ticket.state === "suspended") return;
    if (ticket.state !== "running" && ticket.state !== "cancelling")
      throw new Error(
        "Only a running inference can enter a native suspension boundary.",
      );
    ticket.state = "suspended";
    ticket.observe?.(ticket.state);
    ticket.pool.active.delete(ticket);
    this.drain(ticket.pool);
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
    ticket.state = "waiting";
    ticket.enqueuedAt = Date.now();
    ticket.durableQueueReady = !this.journal;
    ticket.pool.queue.push(ticket);
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
    ticket.state = "released";
    if (this.journal && ticket.journalKey)
      void this.journal
        .release(ticket.journalKey, outcome)
        .catch((error) => this.reportJournalError(error));
    ticket.observe?.(ticket.state);
    ticket.observe = undefined;
    ticket.stopListening();
    ticket.pool.active.delete(ticket);
    const index = ticket.pool.queue.indexOf(ticket);
    if (index >= 0) ticket.pool.queue.splice(index, 1);
    this.drain(ticket.pool);
    this.changed();
    // Keep the settled record for idempotent redelivery for this runtime's
    // lifetime. Confirmed runtime retirement drops its complete record set.
  }

  private drain(pool: Pool): void {
    if (
      this.closing ||
      (this.nativeOwnership && !this.nativeOwnership.available)
    )
      return;
    while (
      pool.queue.length &&
      pool.active.size < pool.configuration.maxConcurrentInference
    ) {
      // An asynchronous metadata write cannot let a newer waiter bypass the
      // head. Install the reservation before starting its durable grant write.
      const ticket = pool.queue[0]!;
      if (!ticket.durableQueueReady) break;
      pool.queue.shift();
      if (ticket.state !== "waiting") continue;
      ticket.state = "granted";
      ticket.grantedAt = Date.now();
      pool.active.add(ticket);
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

  private status(ticket: Ticket): InferenceOperationStatus {
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
          ? ticket.pool.queue.indexOf(ticket) + 1
          : null,
      enqueuedAt: ticket.enqueuedAt,
      grantedAt: ticket.grantedAt,
      startedAt: ticket.startedAt,
    };
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
