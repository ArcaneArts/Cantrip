import type { ServiceLogger } from "@cantrip/logging";

import type {
  AccountResourceUsageRepository,
  AccountUsageHistoryMaintenanceOptions,
  AccountUsageHistoryMaintenanceResult,
  AccountUsageOperationalTotals,
} from "../db/account-resource-usage.js";

const DEFAULT_INTERVAL_MS = 60 * 60_000;

export interface AccountUsageHistoryMaintenanceStats {
  completionCount: number;
  failureCount: number;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastErrorAt: string | null;
  lastResult: AccountUsageHistoryMaintenanceResult | null;
  lastSuccessfulAt: string | null;
  leaseContentionCount: number;
  running: boolean;
  totals: AccountUsageOperationalTotals;
}

export interface AccountUsageHistoryMaintenanceServiceOptions extends AccountUsageHistoryMaintenanceOptions {
  intervalMs?: number;
  now?: () => Date;
}

const EMPTY_TOTALS: AccountUsageOperationalTotals = {
  accountCount: 0,
  logicalServerBytes: 0n,
  logicalWorkerManagedBytes: 0n,
  physicalDatabaseBytes: null,
};

/** Compacts and expires usage history without ever enforcing account limits. */
export class AccountUsageHistoryMaintenanceService {
  readonly #intervalMs: number;
  readonly #now: () => Date;
  #closed = false;
  #completionCount = 0;
  #failureCount = 0;
  #inFlight: Promise<AccountUsageHistoryMaintenanceResult | null> | null = null;
  #lastCompletedAt: string | null = null;
  #lastDurationMs: number | null = null;
  #lastErrorAt: string | null = null;
  #lastResult: AccountUsageHistoryMaintenanceResult | null = null;
  #lastSuccessfulAt: string | null = null;
  #leaseContentionCount = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #totals: AccountUsageOperationalTotals = EMPTY_TOTALS;

  constructor(
    private readonly repository: AccountResourceUsageRepository,
    private readonly holderId: string,
    private readonly logger: ServiceLogger,
    private readonly options: AccountUsageHistoryMaintenanceServiceOptions,
  ) {
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1) {
      throw new Error("Account usage maintenance interval is invalid.");
    }
  }

  start(runImmediately = true): void {
    if (this.#timer || this.#closed) return;
    if (runImmediately) void this.run();
    this.#timer = setInterval(() => void this.run(), this.#intervalMs);
    this.#timer.unref();
  }

  run(): Promise<AccountUsageHistoryMaintenanceResult | null> {
    if (this.#closed) return Promise.resolve(null);
    if (this.#inFlight) return this.#inFlight;
    const startedAt = this.#now();
    this.#inFlight = this.repository
      .maintainUsageHistory(this.holderId, startedAt, this.options)
      .then(async (result) => {
        const completedAt = this.#now();
        this.#lastCompletedAt = completedAt.toISOString();
        this.#lastDurationMs = completedAt.getTime() - startedAt.getTime();
        this.#lastResult = result;
        if (result.acquired) {
          this.#completionCount += 1;
          this.#lastSuccessfulAt = this.#lastCompletedAt;
        } else {
          this.#leaseContentionCount += 1;
        }
        this.#totals = await this.repository.getOperationalTotals();
        this.logger.event(
          result.acquired ? "info" : "debug",
          result.acquired
            ? "Account usage history maintenance completed"
            : "Account usage history maintenance skipped",
          {
            event: result.acquired
              ? "account-usage.history-maintenance.completed"
              : "account-usage.history-maintenance.lease-unavailable",
            subsystem: "account-usage",
            operation: "maintain-history",
            status: result.acquired ? "completed" : "skipped",
            durationMs: this.#lastDurationMs,
            counts: {
              bandwidthDaysRolled: result.bandwidthDaysRolled,
              bandwidthRowsDeleted:
                result.bandwidthHourlyRowsDeleted +
                result.bandwidthDailyRowsDeleted,
              flushRowsDeleted: result.flushRowsDeleted,
              storageDaysRolled: result.storageDaysRolled,
              storageRowsDeleted:
                result.storageHourlyRowsDeleted +
                result.storageDailyRowsDeleted,
            },
          },
        );
        return result;
      })
      .catch((error: unknown) => {
        const failedAt = this.#now();
        this.#failureCount += 1;
        this.#lastErrorAt = failedAt.toISOString();
        this.#lastDurationMs = failedAt.getTime() - startedAt.getTime();
        this.logger.event("error", "Account usage history maintenance failed", {
          event: "account-usage.history-maintenance.failed",
          subsystem: "account-usage",
          operation: "maintain-history",
          reasonCode: "database-error",
          status: "failed",
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

  stats(): AccountUsageHistoryMaintenanceStats {
    return {
      completionCount: this.#completionCount,
      failureCount: this.#failureCount,
      lastCompletedAt: this.#lastCompletedAt,
      lastDurationMs: this.#lastDurationMs,
      lastErrorAt: this.#lastErrorAt,
      lastResult: this.#lastResult,
      lastSuccessfulAt: this.#lastSuccessfulAt,
      leaseContentionCount: this.#leaseContentionCount,
      running: this.#inFlight !== null,
      totals: { ...this.#totals },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }
}
