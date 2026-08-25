import {
  standaloneChatScratchDeleteResultSchema,
  standaloneChatScratchProvisionResultSchema,
  standaloneChatScratchReconciliationResultSchema,
  type StandaloneChatRootJobError,
  type StandaloneChatRootJobSummary,
} from "@cantrip/protocol";
import {
  StandaloneChatRootJobConflictError,
  StandaloneChatRootJobStaleAttemptError,
  type ClaimedStandaloneChatRootJob,
} from "../db/standalone-chat-root-jobs.js";
import type { ServerRepository } from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface Logger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface StandaloneChatRootJobLiveChange {
  job: StandaloneChatRootJobSummary;
  ownerId: string;
}

const MAX_CONCURRENT_ROOT_JOBS = 4;
const LEASE_RENEWAL_INTERVAL_MS = 30_000;
const RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const STANDALONE_CHAT_ROOT_JOB_TIMEOUT_MS = 60_000;

export class StandaloneChatRootJobExecutor {
  readonly #active = new Set<Promise<void>>();
  #drainPromise: Promise<void> | null = null;
  #recoveryTimer: ReturnType<typeof setInterval> | null = null;
  #rerunRequested = false;
  #stopping = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly logger: Logger,
    private readonly onChanged: (
      change: StandaloneChatRootJobLiveChange,
    ) => void = () => undefined,
  ) {}

  async recoverAfterRestart(force = true): Promise<number> {
    const recovered =
      await this.repository.standaloneChatRootJobs.recoverInterrupted(force);
    await this.#purgeExpiredArchives();
    return recovered;
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.standaloneChatRootJobs
        .recoverInterrupted(false)
        .then(async (recovered) => {
          await this.#purgeExpiredArchives();
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired standalone Chat scratch job leases",
          );
        });
    }, RECOVERY_SWEEP_INTERVAL_MS);
    this.#recoveryTimer.unref();
  }

  queueAvailable(): void {
    if (this.#stopping) return;
    if (this.#drainPromise) {
      this.#rerunRequested = true;
      return;
    }
    this.#drainPromise = this.#drain()
      .catch((error: unknown) => {
        this.logger.error(
          { err: error },
          "Standalone Chat scratch job dispatch failed",
        );
      })
      .finally(() => {
        this.#drainPromise = null;
        if (this.#rerunRequested) {
          this.#rerunRequested = false;
          this.queueAvailable();
        }
      });
  }

  async workerConnected(workerId: string): Promise<void> {
    await this.repository.standaloneChatRootJobs.requeueRetryableForWorker(
      workerId,
    );
    await this.#reconcile(workerId);
    this.queueAvailable();
  }

  stop(): void {
    this.#stopping = true;
    if (this.#recoveryTimer) clearInterval(this.#recoveryTimer);
    this.#recoveryTimer = null;
  }

  async drain(): Promise<void> {
    await this.#drainPromise;
    await Promise.allSettled([...this.#active]);
  }

  async #drain(): Promise<void> {
    while (!this.#stopping) {
      if (this.#active.size >= MAX_CONCURRENT_ROOT_JOBS) {
        await Promise.race(this.#active);
        continue;
      }
      const claimed = await this.repository.standaloneChatRootJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, standaloneChatRootJobId: claimed.job.id },
            "Standalone Chat scratch job failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
    }
  }

  async #execute(claimed: ClaimedStandaloneChatRootJob): Promise<void> {
    const { job } = claimed;
    let renewalInFlight = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.repository.standaloneChatRootJobs
        .renewLease(job.id, claimed.commandId, job.attempt)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              { standaloneChatRootJobId: job.id, attempt: job.attempt },
              "Standalone Chat scratch job no longer owns its durable lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, standaloneChatRootJobId: job.id },
            "Could not renew standalone Chat scratch job lease",
          );
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, LEASE_RENEWAL_INTERVAL_MS);
    renewalTimer.unref();
    try {
      const worker = await this.repository.getWorker(
        claimed.ownerId,
        job.workerId,
      );
      if (!worker || !this.bridge.isConnected(job.workerId)) {
        await this.#settle(claimed, {
          code: "worker-offline",
          retryable: true,
        });
        return;
      }
      const capabilities = worker.standaloneChat.scratch;
      const capable =
        job.kind === "provision"
          ? capabilities.provision && capabilities.routingHandles
          : capabilities.remove;
      if (!capable) {
        const failed = await this.repository.standaloneChatRootJobs.fail(
          job.id,
          claimed.commandId,
          { code: "capability-missing", retryable: false },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: failed });
        return;
      }
      if (job.kind === "provision") {
        const result = standaloneChatScratchProvisionResultSchema.parse(
          await this.bridge.request(
            job.workerId,
            {
              type: "chat.scratch.provision",
              jobId: job.id,
              attempt: job.attempt,
              rootId: job.rootId,
              chatId: job.chatId,
            },
            { timeoutMs: STANDALONE_CHAT_ROOT_JOB_TIMEOUT_MS },
          ),
        );
        const completed =
          await this.repository.standaloneChatRootJobs.completeProvision(
            job.id,
            claimed.commandId,
            result,
          );
        this.onChanged({ ownerId: claimed.ownerId, job: completed });
        return;
      }
      const result = standaloneChatScratchDeleteResultSchema.parse(
        await this.bridge.request(
          job.workerId,
          {
            type: "chat.scratch.delete",
            jobId: job.id,
            attempt: job.attempt,
            rootId: job.rootId,
            chatId: job.chatId,
          },
          { timeoutMs: STANDALONE_CHAT_ROOT_JOB_TIMEOUT_MS },
        ),
      );
      const completed =
        await this.repository.standaloneChatRootJobs.completeDelete(
          job.id,
          claimed.commandId,
          result,
        );
      this.onChanged({ ownerId: claimed.ownerId, job: completed });
    } catch (error) {
      if (error instanceof StandaloneChatRootJobStaleAttemptError) {
        this.logger.warn(
          { err: error, standaloneChatRootJobId: job.id },
          "Ignored stale standalone Chat scratch completion",
        );
        return;
      }
      const failure: StandaloneChatRootJobError =
        error instanceof WorkerUnavailableError
          ? { code: "worker-offline", retryable: true }
          : error instanceof Error && error.name === "ZodError"
            ? { code: "invalid-result", retryable: false }
            : error instanceof StandaloneChatRootJobConflictError
              ? { code: "root-conflict", retryable: false }
              : { code: "worker-error", retryable: false };
      try {
        await this.#settle(claimed, failure);
      } catch (settleError) {
        if (!(settleError instanceof StandaloneChatRootJobStaleAttemptError)) {
          throw settleError;
        }
      }
    } finally {
      clearInterval(renewalTimer);
    }
  }

  async #settle(
    claimed: ClaimedStandaloneChatRootJob,
    error: StandaloneChatRootJobError,
  ): Promise<void> {
    const settled = error.retryable
      ? await this.repository.standaloneChatRootJobs.block(
          claimed.job.id,
          claimed.commandId,
          error,
        )
      : await this.repository.standaloneChatRootJobs.fail(
          claimed.job.id,
          claimed.commandId,
          error,
        );
    this.onChanged({ ownerId: claimed.ownerId, job: settled });
  }

  async #reconcile(workerId: string): Promise<void> {
    const ownerId = await this.repository.getWorkerOwnerId(workerId);
    if (!ownerId || !this.bridge.isConnected(workerId)) return;
    const worker = await this.repository.getWorker(ownerId, workerId);
    if (!worker?.standaloneChat.scratch.reconcile) return;
    const roots =
      await this.repository.standaloneChatRootJobs.reconciliationTargets(
        workerId,
      );
    try {
      const result = standaloneChatScratchReconciliationResultSchema.parse(
        await this.bridge.request(
          workerId,
          { type: "chat.scratch.reconcile", roots },
          { timeoutMs: STANDALONE_CHAT_ROOT_JOB_TIMEOUT_MS },
        ),
      );
      const expired =
        await this.repository.standaloneChatRootJobs.purgeExpiredArchivedChats(
          ownerId,
        );
      for (const job of expired) this.onChanged({ ownerId, job });
      await this.repository.standaloneChatRootJobs.markMissingRoots(
        workerId,
        result.missingRootIds,
      );
      if (result.orphanedRootIds.length > 0) {
        this.logger.warn(
          { workerId, rootIds: result.orphanedRootIds },
          "Worker reported orphaned standalone Chat scratch roots",
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, workerId },
        "Could not reconcile standalone Chat scratch roots after reconnect",
      );
    }
  }

  async #purgeExpiredArchives(): Promise<void> {
    const changes =
      await this.repository.standaloneChatRootJobs.purgeExpiredArchivedChatsForAllOwners();
    for (const change of changes) this.onChanged(change);
    if (changes.length > 0) this.queueAvailable();
  }
}
