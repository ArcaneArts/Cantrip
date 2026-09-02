import {
  workspaceRepositoryDiscoveryWorkerResultSchema,
  type WorkspaceRepositoryDiscoveryJobSummary,
  type WorkspaceRepositoryDiscoveryProgress,
} from "@cantrip/protocol";

import {
  WorkspaceRepositoryDiscoveryStaleAttemptError,
  type ClaimedWorkspaceRepositoryDiscoveryJob,
} from "../db/workspace-repository-discovery-jobs.js";
import type { ServerRepository } from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerCommandError,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface Logger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface WorkspaceRepositoryDiscoveryLiveChange {
  job: WorkspaceRepositoryDiscoveryJobSummary;
  ownerId: string;
  progress?: WorkspaceRepositoryDiscoveryProgress;
}

const LEASE_RENEWAL_INTERVAL_MS = 30_000;
const RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const WORKSPACE_REPOSITORY_DISCOVERY_TIMEOUT_MS = 60_000;

export class WorkspaceRepositoryDiscoveryJobExecutor {
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
      change: WorkspaceRepositoryDiscoveryLiveChange,
    ) => void = () => undefined,
  ) {}

  async recoverAfterRestart(force = true): Promise<number> {
    return this.repository.workspaceRepositoryDiscoveryJobs.recoverInterrupted(
      force,
    );
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.workspaceRepositoryDiscoveryJobs
        .recoverInterrupted(false)
        .then((recovered) => {
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired workspace repository discovery leases",
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
          "Workspace repository discovery dispatch failed",
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
    await this.repository.workspaceRepositoryDiscoveryJobs.requeueRetryableForWorker(
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
    // Discovery is intentionally serialized. Every scan is bounded, and
    // serial execution prevents multiple attached roots from saturating one
    // worker's filesystem with concurrent recursive walks.
    while (!this.#stopping && this.#active.size === 0) {
      const claimed =
        await this.repository.workspaceRepositoryDiscoveryJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, workspaceRepositoryDiscoveryJobId: claimed.job.id },
            "Workspace repository discovery failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
      await task;
    }
  }

  async #execute(
    claimed: ClaimedWorkspaceRepositoryDiscoveryJob,
  ): Promise<void> {
    const { job } = claimed;
    this.onChanged({ ownerId: claimed.ownerId, job });
    let renewalInFlight = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.repository.workspaceRepositoryDiscoveryJobs
        .renewLease(job.id, claimed.commandId, job.attempt)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              {
                workspaceRepositoryDiscoveryJobId: job.id,
                attempt: job.attempt,
              },
              "Workspace repository discovery no longer owns its durable lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, workspaceRepositoryDiscoveryJobId: job.id },
            "Could not renew workspace repository discovery lease",
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
        const blocked =
          await this.repository.workspaceRepositoryDiscoveryJobs.block(
            job.id,
            claimed.commandId,
            { code: "worker-offline", retryable: true },
          );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      if (!worker.managedFolders.discoverWorkspaceRepositories) {
        const failed =
          await this.repository.workspaceRepositoryDiscoveryJobs.fail(
            job.id,
            claimed.commandId,
            { code: "capability-missing", retryable: false },
          );
        this.onChanged({ ownerId: claimed.ownerId, job: failed });
        return;
      }
      const result = workspaceRepositoryDiscoveryWorkerResultSchema.parse(
        await this.bridge.request(
          job.workerId,
          {
            type: "workspace.repositories.discover",
            jobId: job.id,
            attempt: job.attempt,
            rootPath: claimed.rootPathHandle,
            depth: job.depth,
          },
          {
            ownerId: claimed.ownerId,
            timeoutMs: WORKSPACE_REPOSITORY_DISCOVERY_TIMEOUT_MS,
            onEvent: (event) => {
              if (
                event.type !== "workspace.repositories.discovery-progress" ||
                event.jobId !== job.id ||
                event.attempt !== job.attempt
              ) {
                return;
              }
              this.onChanged({
                ownerId: claimed.ownerId,
                job,
                progress: event.progress,
              });
            },
          },
        ),
      );
      if (result.jobId !== job.id || result.attempt !== job.attempt) {
        throw new WorkspaceRepositoryDiscoveryStaleAttemptError(
          "The worker returned another repository discovery attempt.",
        );
      }
      const completed =
        await this.repository.workspaceRepositoryDiscoveryJobs.complete(
          job.id,
          claimed.commandId,
          {
            attempt: result.attempt,
            candidates: result.candidates.map((candidate) => ({
              pathHandle: candidate.path,
              displayHandle: candidate.displayPath,
              originUrlHandle: candidate.originUrl,
              github: candidate.github,
              repositoryFingerprint: candidate.repositoryFingerprint,
              classification: candidate.classification,
              diagnosticCode: candidate.diagnosticCode,
            })),
            counts: result.counts,
            truncated: result.truncated,
          },
        );
      this.onChanged({ ownerId: claimed.ownerId, job: completed.job });
    } catch (error) {
      if (error instanceof WorkspaceRepositoryDiscoveryStaleAttemptError) {
        this.logger.warn(
          { err: error, workspaceRepositoryDiscoveryJobId: job.id },
          "Ignored stale workspace repository discovery completion",
        );
        return;
      }
      try {
        const settled =
          error instanceof WorkerUnavailableError
            ? await this.repository.workspaceRepositoryDiscoveryJobs.block(
                job.id,
                claimed.commandId,
                { code: "worker-offline", retryable: true },
              )
            : await this.repository.workspaceRepositoryDiscoveryJobs.fail(
                job.id,
                claimed.commandId,
                {
                  code:
                    error instanceof WorkerCommandError &&
                    error.code === "root-unavailable"
                      ? "root-unavailable"
                      : "discovery-failed",
                  retryable: false,
                },
              );
        this.onChanged({ ownerId: claimed.ownerId, job: settled });
      } catch (settleError) {
        if (
          !(
            settleError instanceof WorkspaceRepositoryDiscoveryStaleAttemptError
          )
        ) {
          throw settleError;
        }
      }
    } finally {
      clearInterval(renewalTimer);
    }
  }
}
