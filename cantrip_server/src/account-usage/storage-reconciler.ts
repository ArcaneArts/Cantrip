import type { ServiceLogger } from "@cantrip/logging";

import type {
  AccountResourceUsageRepository,
  AccountStorageReconciliationResult,
} from "../db/account-resource-usage.js";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 60 * 60_000;

export interface StorageReconciliationStats {
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastErrorAt: string | null;
  lastResult: AccountStorageReconciliationResult | null;
  running: boolean;
}

export interface StorageReconciliationServiceOptions {
  intervalMs?: number;
  now?: () => Date;
  onReconciled?: (result: AccountStorageReconciliationResult) => void;
}

/** Maintains the derived storage projection and hourly history. */
export class StorageReconciliationService {
  readonly #intervalMs: number;
  readonly #now: () => Date;
  #closed = false;
  #inFlight: Promise<AccountStorageReconciliationResult | null> | null = null;
  #lastCompletedAt: string | null = null;
  #lastDurationMs: number | null = null;
  #lastErrorAt: string | null = null;
  #lastResult: AccountStorageReconciliationResult | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repository: AccountResourceUsageRepository,
    private readonly holderId: string,
    private readonly logger: ServiceLogger,
    private readonly options: StorageReconciliationServiceOptions = {},
  ) {
    this.#intervalMs =
      this.options.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.#now = this.options.now ?? (() => new Date());
  }

  start(reconcileImmediately = true): void {
    if (this.#timer || this.#closed) return;
    if (reconcileImmediately) void this.reconcile();
    this.#timer = setInterval(() => void this.reconcile(), this.#intervalMs);
    this.#timer.unref();
  }

  reconcile(): Promise<AccountStorageReconciliationResult | null> {
    if (this.#closed) return Promise.resolve(null);
    if (this.#inFlight) return this.#inFlight;
    const startedAt = this.#now();
    this.logger.event("debug", "Account storage reconciliation started", {
      event: "account-usage.storage-reconciliation.started",
      subsystem: "account-usage",
      operation: "reconcile-storage",
      status: "started",
    });
    this.#inFlight = this.repository
      .reconcileStorage(this.holderId, startedAt)
      .then((result) => {
        const completedAt = this.#now();
        this.#lastCompletedAt = completedAt.toISOString();
        this.#lastDurationMs = completedAt.getTime() - startedAt.getTime();
        this.#lastResult = result;
        if (result.acquired) this.options.onReconciled?.(result);
        this.logger.event(
          result.acquired ? "info" : "debug",
          result.acquired
            ? "Account storage reconciliation completed"
            : "Account storage reconciliation skipped",
          {
            event: result.acquired
              ? "account-usage.storage-reconciliation.completed"
              : "account-usage.storage-reconciliation.lease-unavailable",
            subsystem: "account-usage",
            operation: "reconcile-storage",
            status: result.acquired ? "completed" : "skipped",
            durationMs: this.#lastDurationMs,
            counts: {
              accounts: result.accountCount,
              categories: result.categoryCount,
            },
            logicalBytes: result.logicalBytes.toString(),
            rowCount: result.rowCount.toString(),
          },
        );
        return result;
      })
      .catch((error: unknown) => {
        const failedAt = this.#now();
        this.#lastErrorAt = failedAt.toISOString();
        this.#lastDurationMs = failedAt.getTime() - startedAt.getTime();
        this.logger.event("error", "Account storage reconciliation failed", {
          event: "account-usage.storage-reconciliation.failed",
          subsystem: "account-usage",
          operation: "reconcile-storage",
          status: "failed",
          reasonCode: "database-error",
          durationMs: this.#lastDurationMs,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return null;
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  stats(): StorageReconciliationStats {
    return {
      lastCompletedAt: this.#lastCompletedAt,
      lastDurationMs: this.#lastDurationMs,
      lastErrorAt: this.#lastErrorAt,
      lastResult: this.#lastResult,
      running: this.#inFlight !== null,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }
}
