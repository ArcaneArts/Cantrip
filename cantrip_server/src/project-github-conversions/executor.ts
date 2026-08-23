import {
  projectGithubConversionExecutionResultSchema,
  type ProjectGithubConversionJobSummary,
} from "@cantrip/protocol";

import {
  ProjectGithubConversionJobStaleAttemptError,
  type ClaimedProjectGithubConversionJob,
} from "../db/project-github-conversion-jobs.js";
import type { ServerRepository } from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface Logger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ProjectGithubConversionLiveChange {
  job: ProjectGithubConversionJobSummary;
  ownerId: string;
}

const MAX_CONCURRENT_CONVERSIONS = 2;
const LEASE_RENEWAL_INTERVAL_MS = 30_000;
const RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const PROJECT_GITHUB_CONVERSION_TIMEOUT_MS = 2 * 60 * 60_000;

export class ProjectGithubConversionJobExecutor {
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
      change: ProjectGithubConversionLiveChange,
    ) => void = () => undefined,
  ) {}

  async recoverAfterRestart(force = true): Promise<number> {
    return this.repository.projectGithubConversionJobs.recoverInterrupted(
      force,
    );
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.projectGithubConversionJobs
        .recoverInterrupted(false)
        .then((recovered) => {
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired GitHub conversion job leases",
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
          "GitHub conversion job dispatch failed",
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
    await this.repository.projectGithubConversionJobs.requeueRetryableForWorker(
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
      if (this.#active.size >= MAX_CONCURRENT_CONVERSIONS) {
        await Promise.race(this.#active);
        continue;
      }
      const claimed =
        await this.repository.projectGithubConversionJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, projectGithubConversionJobId: claimed.job.id },
            "GitHub conversion failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
    }
  }

  async #execute(claimed: ClaimedProjectGithubConversionJob): Promise<void> {
    const { job } = claimed;
    let renewalInFlight = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.repository.projectGithubConversionJobs
        .renewLease(job.id, claimed.commandId, job.attempt)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              { projectGithubConversionJobId: job.id, attempt: job.attempt },
              "GitHub conversion job no longer owns its durable lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, projectGithubConversionJobId: job.id },
            "Could not renew GitHub conversion job lease",
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
        const blocked = await this.repository.projectGithubConversionJobs.block(
          job.id,
          claimed.commandId,
          {
            code: "worker-offline",
            retryable: true,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      if (!worker.managedFolders.convertToGithub) {
        const failed = await this.repository.projectGithubConversionJobs.fail(
          job.id,
          claimed.commandId,
          {
            code: "capability-missing",
            retryable: false,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: failed });
        return;
      }
      const result = projectGithubConversionExecutionResultSchema.parse(
        await this.bridge.request(
          job.workerId,
          {
            type: "project.folder-conversion.execute",
            jobId: job.id,
            attempt: job.attempt,
            projectId: job.projectId,
            repository: job.repository,
            confirmationToken: claimed.confirmationToken,
            initialCommit: claimed.initialCommit,
          },
          { timeoutMs: PROJECT_GITHUB_CONVERSION_TIMEOUT_MS },
        ),
      );
      if (result.status === "blocked") {
        const settled = result.error.retryable
          ? await this.repository.projectGithubConversionJobs.block(
              job.id,
              claimed.commandId,
              result.error,
            )
          : await this.repository.projectGithubConversionJobs.fail(
              job.id,
              claimed.commandId,
              result.error,
            );
        this.onChanged({ ownerId: claimed.ownerId, job: settled });
        return;
      }
      const completed =
        await this.repository.projectGithubConversionJobs.complete(
          job.id,
          claimed.commandId,
          result,
        );
      this.onChanged({ ownerId: claimed.ownerId, job: completed });
    } catch (error) {
      if (error instanceof ProjectGithubConversionJobStaleAttemptError) {
        this.logger.warn(
          { err: error, projectGithubConversionJobId: job.id },
          "Ignored stale GitHub conversion completion",
        );
        return;
      }
      try {
        const settled =
          error instanceof WorkerUnavailableError
            ? await this.repository.projectGithubConversionJobs.block(
                job.id,
                claimed.commandId,
                {
                  code: "worker-offline",
                  retryable: true,
                },
              )
            : await this.repository.projectGithubConversionJobs.fail(
                job.id,
                claimed.commandId,
                {
                  code: "reconciliation-failed",
                  retryable: false,
                },
              );
        this.onChanged({ ownerId: claimed.ownerId, job: settled });
      } catch (settleError) {
        if (
          !(settleError instanceof ProjectGithubConversionJobStaleAttemptError)
        ) {
          throw settleError;
        }
      }
    } finally {
      clearInterval(renewalTimer);
    }
  }
}
