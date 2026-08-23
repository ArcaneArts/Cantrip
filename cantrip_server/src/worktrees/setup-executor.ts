import { randomUUID } from "node:crypto";

import {
  protectedWorkerRunSetupLookupSchema,
  protectedWorkerRunSetupStatusSchema,
  type WorktreeSetupJobSummary,
  type WorkerRunSetupPublicStatus,
} from "@cantrip/protocol";

import {
  WorktreeSetupJobStaleAttemptError,
  type ClaimedWorktreeSetupJob,
} from "../db/worktree-setup-jobs.js";
import type { ServerRepository } from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface Logger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface WorktreeSetupLiveChange {
  job: WorktreeSetupJobSummary;
  ownerId: string;
}

const MAX_CONCURRENT_SETUP_JOBS = 4;
const POLL_INTERVAL_MS = 1_000;
const SETUP_CONTROL_TIMEOUT_MS = 15_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class WorktreeSetupJobExecutor {
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
      change: WorktreeSetupLiveChange,
    ) => void = () => undefined,
    private readonly serverId: () => string = () => "server-internal",
  ) {}

  recoverAfterRestart(force = true): Promise<number> {
    return this.repository.worktreeSetupJobs.recoverInterrupted(force);
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.worktreeSetupJobs
        .recoverInterrupted(false)
        .then((recovered) => {
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired worktree setup leases",
          );
        });
    }, 30_000);
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
        this.logger.error({ err: error }, "Worktree setup dispatch failed");
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
    await this.repository.worktreeSetupJobs.requeueRetryableForWorker(workerId);
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
      if (this.#active.size >= MAX_CONCURRENT_SETUP_JOBS) {
        await Promise.race(this.#active);
        continue;
      }
      const claimed = await this.repository.worktreeSetupJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, worktreeSetupJobId: claimed.job.id },
            "Worktree setup failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
    }
  }

  async #execute(claimed: ClaimedWorktreeSetupJob): Promise<void> {
    const { job } = claimed;
    try {
      const worker = await this.repository.getWorker(
        claimed.ownerId,
        job.workerId,
      );
      if (!worker || !this.bridge.isConnected(job.workerId)) {
        await this.#blockOffline(claimed);
        return;
      }
      let status = protectedWorkerRunSetupStatusSchema.parse(
        await this.bridge.request(
          job.workerId,
          {
            type: "project.run-setup.start",
            operationId: randomUUID(),
            serverId: this.serverId(),
            jobId: job.id,
            attempt: job.attempt,
            projectId: job.projectId,
            worktreeId: job.worktreeId,
            sourcePath: claimed.sourcePath,
            worktreePath: claimed.worktreePath,
            configurationRevision: job.configurationRevision,
          },
          { timeoutMs: SETUP_CONTROL_TIMEOUT_MS },
        ),
      ).status;
      while (!this.#stopping) {
        if (status.state !== "running") {
          await this.#settle(claimed, status);
          return;
        }
        await delay(POLL_INTERVAL_MS);
        if (this.#stopping) return;
        const renewed = await this.repository.worktreeSetupJobs.renewLease(
          job.id,
          claimed.commandId,
          job.attempt,
        );
        if (!renewed) return;
        if (!this.bridge.isConnected(job.workerId)) {
          await this.#blockOffline(claimed);
          return;
        }
        const lookup = protectedWorkerRunSetupLookupSchema.parse(
          await this.bridge.request(
            job.workerId,
            {
              type: "project.run-setup.status",
              operationId: randomUUID(),
              serverId: this.serverId(),
              jobId: job.id,
              projectId: job.projectId,
              worktreeId: job.worktreeId,
            },
            { timeoutMs: SETUP_CONTROL_TIMEOUT_MS },
          ),
        );
        if (!lookup.found) {
          const failed = await this.repository.worktreeSetupJobs.fail(
            job.id,
            claimed.commandId,
            null,
            {
              code: "setup-interrupted",
              message:
                "The worker lost this setup attempt. Retry setup to prepare the worktree.",
              retryable: true,
            },
          );
          this.onChanged({ ownerId: claimed.ownerId, job: failed });
          return;
        }
        status = lookup.status;
      }
    } catch (error) {
      if (error instanceof WorktreeSetupJobStaleAttemptError) return;
      try {
        if (error instanceof WorkerUnavailableError) {
          await this.#blockOffline(claimed);
          return;
        }
        const failed = await this.repository.worktreeSetupJobs.fail(
          job.id,
          claimed.commandId,
          null,
          {
            code: "setup-start-failed",
            message:
              "The worker could not start or observe the setup process. Retry after inspecting the worker.",
            retryable: true,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: failed });
      } catch (settleError) {
        if (!(settleError instanceof WorktreeSetupJobStaleAttemptError)) {
          throw settleError;
        }
      }
    }
  }

  async #settle(
    claimed: ClaimedWorktreeSetupJob,
    status: WorkerRunSetupPublicStatus,
  ): Promise<void> {
    const completed =
      status.state === "succeeded"
        ? await this.repository.worktreeSetupJobs.complete(
            claimed.job.id,
            claimed.commandId,
            status,
          )
        : await this.repository.worktreeSetupJobs.fail(
            claimed.job.id,
            claimed.commandId,
            status,
            status.error
              ? {
                  ...status.error,
                  message:
                    "The setup script failed. Detailed diagnostics remain protected on the worker.",
                }
              : {
                  code: "setup-failed",
                  message: "The setup script failed.",
                  retryable: true,
                },
          );
    this.onChanged({ ownerId: claimed.ownerId, job: completed });
  }

  async #blockOffline(claimed: ClaimedWorktreeSetupJob): Promise<void> {
    const blocked = await this.repository.worktreeSetupJobs.block(
      claimed.job.id,
      claimed.commandId,
      {
        code: "worker-offline",
        message:
          "The owning worker is offline. Worktree setup will resume after it reconnects.",
        retryable: true,
      },
    );
    this.onChanged({ ownerId: claimed.ownerId, job: blocked });
  }
}
