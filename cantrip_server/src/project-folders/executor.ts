import {
  managedFolderMaterializeReadySchema,
  type ProjectFolderSetupJobSummary,
} from "@cantrip/protocol";

import {
  ProjectFolderSetupJobStaleAttemptError,
  type ClaimedProjectFolderSetupJob,
} from "../db/project-folder-setup-jobs.js";
import type { ServerRepository } from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface Logger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ProjectFolderSetupLiveChange {
  job: ProjectFolderSetupJobSummary;
  ownerId: string;
}

const MAX_CONCURRENT_FOLDER_SETUP_JOBS = 4;
const LEASE_RENEWAL_INTERVAL_MS = 30_000;
const RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const PROJECT_FOLDER_SETUP_TIMEOUT_MS = 60_000;

export class ProjectFolderSetupJobExecutor {
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
      change: ProjectFolderSetupLiveChange,
    ) => void = () => undefined,
  ) {}

  async recoverAfterRestart(force = true): Promise<number> {
    return this.repository.projectFolderSetupJobs.recoverInterrupted(force);
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.projectFolderSetupJobs
        .recoverInterrupted(false)
        .then((recovered) => {
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired folder setup job leases",
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
        this.logger.error({ err: error }, "Folder setup job dispatch failed");
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
    await this.repository.projectFolderSetupJobs.requeueRetryableForWorker(
      workerId,
    );
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
      if (this.#active.size >= MAX_CONCURRENT_FOLDER_SETUP_JOBS) {
        await Promise.race(this.#active);
        continue;
      }
      const claimed = await this.repository.projectFolderSetupJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, projectFolderSetupJobId: claimed.job.id },
            "Folder setup job failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
    }
  }

  async #execute(claimed: ClaimedProjectFolderSetupJob): Promise<void> {
    const { job } = claimed;
    let renewalInFlight = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.repository.projectFolderSetupJobs
        .renewLease(job.id, claimed.commandId, job.attempt)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              { projectFolderSetupJobId: job.id, attempt: job.attempt },
              "Folder setup job no longer owns its durable lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, projectFolderSetupJobId: job.id },
            "Could not renew folder setup job lease",
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
        const blocked = await this.repository.projectFolderSetupJobs.block(
          job.id,
          claimed.commandId,
          {
            code: "worker-offline",
            message:
              "The owning worker is offline. Folder setup will resume after it reconnects.",
            retryable: true,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      if (!worker.managedFolders.create) {
        const failed = await this.repository.projectFolderSetupJobs.fail(
          job.id,
          claimed.commandId,
          {
            code: "capability-missing",
            message:
              "The owning worker does not support managed folder creation.",
            retryable: false,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: failed });
        return;
      }
      const result = managedFolderMaterializeReadySchema.parse(
        await this.bridge.request(
          job.workerId,
          {
            type: "project.folder.materialize",
            jobId: job.id,
            attempt: job.attempt,
            projectId: job.projectId,
            displayName: claimed.projectName,
          },
          { timeoutMs: PROJECT_FOLDER_SETUP_TIMEOUT_MS },
        ),
      );
      const completed = await this.repository.projectFolderSetupJobs.complete(
        job.id,
        claimed.commandId,
        result,
      );
      this.onChanged({ ownerId: claimed.ownerId, job: completed });
    } catch (error) {
      if (error instanceof ProjectFolderSetupJobStaleAttemptError) {
        this.logger.warn(
          { err: error, projectFolderSetupJobId: job.id },
          "Ignored stale folder setup completion",
        );
        return;
      }
      try {
        const settled =
          error instanceof WorkerUnavailableError
            ? await this.repository.projectFolderSetupJobs.block(
                job.id,
                claimed.commandId,
                {
                  code: "worker-offline",
                  message:
                    "The owning worker disconnected during folder setup. Setup will resume after it reconnects.",
                  retryable: true,
                },
              )
            : await this.repository.projectFolderSetupJobs.fail(
                job.id,
                claimed.commandId,
                {
                  code: "materialization-failed",
                  message:
                    error instanceof Error
                      ? error.message.slice(0, 4_000)
                      : "The worker could not create the managed folder.",
                  retryable: false,
                },
              );
        this.onChanged({ ownerId: claimed.ownerId, job: settled });
      } catch (settleError) {
        if (!(settleError instanceof ProjectFolderSetupJobStaleAttemptError)) {
          throw settleError;
        }
      }
    } finally {
      clearInterval(renewalTimer);
    }
  }
}
