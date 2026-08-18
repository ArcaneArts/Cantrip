import {
  managedFolderDeleteResultSchema,
  projectReplicaProvisionResultSchema,
  projectReplicaRemoveResultSchema,
  projectReplicaSynchronizeResultSchema,
  type ProjectReplicaJobSummary,
  type WorkerEvent,
} from "@cantrip/protocol";

import {
  ProjectReplicaJobStaleAttemptError,
  type ClaimedProjectReplicaJob,
} from "../db/project-replica-jobs.js";
import type { ServerRepository } from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface ProjectReplicaJobLogger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ProjectReplicaJobLiveChange {
  job: ProjectReplicaJobSummary;
  ownerId: string;
}

const MAX_CONCURRENT_REPLICA_JOBS = 4;
const JOB_LEASE_RENEWAL_INTERVAL_MS = 30_000;
const JOB_RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const PROJECT_REPLICA_COMMAND_TIMEOUT_MS = 30 * 60_000;
const PROJECT_REPLICA_PROVISION_TIMEOUT_MS = 2 * 60 * 60_000 + 60_000;

export class ProjectReplicaJobExecutor {
  readonly #active = new Set<Promise<void>>();
  #drainPromise: Promise<void> | null = null;
  #recoveryTimer: ReturnType<typeof setInterval> | null = null;
  #rerunRequested = false;
  #stopping = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly logger: ProjectReplicaJobLogger,
    private readonly onChanged: (
      change: ProjectReplicaJobLiveChange,
    ) => void = () => undefined,
  ) {}

  async recoverAfterRestart(force = true): Promise<number> {
    return this.repository.projectReplicaJobs.recoverInterrupted(force);
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.projectReplicaJobs
        .recoverInterrupted(false)
        .then((recovered) => {
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired project replica job leases",
          );
        });
    }, JOB_RECOVERY_SWEEP_INTERVAL_MS);
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
          "Project replica job dispatch failed",
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
    await this.repository.projectReplicaJobs.requeueRetryableForWorker(
      workerId,
    );
    this.queueAvailable();
  }

  stop(): void {
    this.#stopping = true;
    if (this.#recoveryTimer) {
      clearInterval(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
  }

  async drain(): Promise<void> {
    await this.#drainPromise;
    await Promise.allSettled([...this.#active]);
  }

  async #drain(): Promise<void> {
    while (!this.#stopping) {
      if (this.#active.size >= MAX_CONCURRENT_REPLICA_JOBS) {
        await Promise.race(this.#active);
        continue;
      }
      const claimed = await this.repository.projectReplicaJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, projectReplicaJobId: claimed.job.id },
            "Project replica job failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
    }
  }

  async #execute(claimed: ClaimedProjectReplicaJob): Promise<void> {
    const { job } = claimed;
    let renewalInFlight = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.repository.projectReplicaJobs
        .renewLease(job.id, claimed.commandId, job.attempt)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              { projectReplicaJobId: job.id, attempt: job.attempt },
              "Project replica job no longer owns its durable lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, projectReplicaJobId: job.id, attempt: job.attempt },
            "Could not renew project replica job lease",
          );
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, JOB_LEASE_RENEWAL_INTERVAL_MS);
    renewalTimer.unref();
    try {
      const worker = await this.repository.getWorker(
        claimed.ownerId,
        job.workerId,
      );
      if (!worker || !this.bridge.isConnected(job.workerId)) {
        const blocked = await this.repository.projectReplicaJobs.block(
          job.id,
          claimed.commandId,
          {
            code: "worker-offline",
            message:
              "The target worker is offline. The job will resume after it reconnects.",
            retryable: true,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      const convertedManagedFolderSource =
        job.kind === "remove" && job.projectReplicaId
          ? await this.repository.projectGithubConversionJobs.isConvertedManagedFolderSource(
              claimed.ownerId,
              job.projectId,
              job.projectReplicaId,
            )
          : false;
      const capable =
        job.kind === "provision"
          ? worker.projectReplicas.provision &&
            worker.projectReplicas.exactRevision
          : job.kind === "synchronize"
            ? worker.projectReplicas.synchronize &&
              worker.projectReplicas.exactRevision
            : convertedManagedFolderSource
              ? !(job.deleteLocalFiles ?? true) || worker.managedFolders.remove
              : worker.projectReplicas.remove;
      if (!capable) {
        const blocked = await this.repository.projectReplicaJobs.block(
          job.id,
          claimed.commandId,
          {
            code: "capability-missing",
            message: `The target worker does not advertise safe replica ${job.kind} capability.`,
            retryable: false,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      const onEvent = async (event: WorkerEvent) => {
        if (event.type !== "project.replica.progress") return;
        if (event.jobId !== job.id || event.attempt !== job.attempt) {
          this.logger.warn(
            {
              projectReplicaJobId: job.id,
              reportedJobId: event.jobId,
              reportedAttempt: event.attempt,
            },
            "Ignored stale project replica job progress",
          );
          return;
        }
        const updated = await this.repository.projectReplicaJobs.updateProgress(
          job.id,
          claimed.commandId,
          job.attempt,
          event.progress,
        );
        if (updated) {
          this.onChanged({ ownerId: claimed.ownerId, job: updated });
        }
      };
      const options = {
        timeoutMs:
          job.kind === "provision"
            ? PROJECT_REPLICA_PROVISION_TIMEOUT_MS
            : PROJECT_REPLICA_COMMAND_TIMEOUT_MS,
        onEvent,
      };
      let settled: ProjectReplicaJobSummary;
      if (job.kind === "provision") {
        const result = projectReplicaProvisionResultSchema.parse(
          await this.bridge.request(
            job.workerId,
            {
              type: "project.replica.provision",
              jobId: job.id,
              attempt: job.attempt,
              repository: { nameWithOwner: job.repository },
              expectedRevision: job.expectedRevision,
            },
            options,
          ),
        );
        this.assertCurrentResult(job, result);
        settled =
          result.status === "blocked"
            ? await this.repository.projectReplicaJobs.block(
                job.id,
                claimed.commandId,
                result.error,
              )
            : await this.repository.projectReplicaJobs.completeProvision(
                job.id,
                claimed.commandId,
                result,
              );
      } else {
        const context =
          await this.repository.projectReplicaJobs.operationContext(
            job.id,
            claimed.commandId,
          );
        if (!context || !job.projectReplicaId) {
          settled = await this.repository.projectReplicaJobs.block(
            job.id,
            claimed.commandId,
            {
              code: "target-not-found",
              message: "The active replica target no longer exists.",
              retryable: false,
            },
          );
        } else if (job.kind === "synchronize") {
          if (!job.expectedRevision || !job.synchronizationPolicy) {
            throw new Error("Synchronization job payload is incomplete.");
          }
          const result = projectReplicaSynchronizeResultSchema.parse(
            await this.bridge.request(
              job.workerId,
              {
                type: "project.replica.synchronize",
                jobId: job.id,
                attempt: job.attempt,
                repository: { nameWithOwner: job.repository },
                sourcePath: context.sourcePath,
                expectedRevision: job.expectedRevision,
                policy: job.synchronizationPolicy,
              },
              options,
            ),
          );
          this.assertCurrentResult(job, result);
          settled =
            result.status === "blocked"
              ? await this.repository.projectReplicaJobs.block(
                  job.id,
                  claimed.commandId,
                  result.error,
                )
              : await this.repository.projectReplicaJobs.completeSynchronize(
                  job.id,
                  claimed.commandId,
                  result,
                );
        } else {
          const blocker =
            await this.repository.projectReplicaJobs.removalBlocker(
              job.projectReplicaId,
              job.id,
            );
          if (blocker) {
            settled = await this.repository.projectReplicaJobs.block(
              job.id,
              claimed.commandId,
              {
                code: "replica-in-use",
                message: blocker,
                retryable: false,
              },
            );
          } else {
            const marked =
              await this.repository.projectReplicaJobs.markRemovalStarted(
                job.projectReplicaId,
              );
            if (!marked) {
              settled = await this.repository.projectReplicaJobs.block(
                job.id,
                claimed.commandId,
                {
                  code: "replica-not-ready",
                  message:
                    "The replica Primary worktree is not ready for removal.",
                  retryable: false,
                },
              );
            } else {
              const deleteLocalFiles = job.deleteLocalFiles ?? true;
              let result;
              if (convertedManagedFolderSource) {
                if (deleteLocalFiles) {
                  managedFolderDeleteResultSchema.parse(
                    await this.bridge.request(job.workerId, {
                      type: "project.folder.delete",
                      projectId: job.projectId,
                    }),
                  );
                }
                result = projectReplicaRemoveResultSchema.parse({
                  status: "removed",
                  jobId: job.id,
                  attempt: job.attempt,
                  path: context.sourcePath,
                  localFilesDeleted: deleteLocalFiles,
                });
              } else {
                result = projectReplicaRemoveResultSchema.parse(
                  await this.bridge.request(
                    job.workerId,
                    {
                      type: "project.replica.remove",
                      jobId: job.id,
                      attempt: job.attempt,
                      repository: { nameWithOwner: job.repository },
                      sourcePath: context.sourcePath,
                      deleteLocalFiles,
                    },
                    options,
                  ),
                );
              }
              this.assertCurrentResult(job, result);
              if (result.status === "blocked") {
                await this.repository.projectReplicaJobs.restoreRemovalReady(
                  job.projectReplicaId,
                );
                settled = await this.repository.projectReplicaJobs.block(
                  job.id,
                  claimed.commandId,
                  result.error,
                );
              } else {
                settled =
                  await this.repository.projectReplicaJobs.completeRemove(
                    job.id,
                    claimed.commandId,
                    result,
                  );
              }
            }
          }
        }
      }
      this.onChanged({ ownerId: claimed.ownerId, job: settled });
    } catch (error) {
      if (error instanceof ProjectReplicaJobStaleAttemptError) {
        this.logger.warn(
          { err: error, projectReplicaJobId: job.id },
          "Ignored stale project replica job completion",
        );
        return;
      }
      try {
        const settled =
          error instanceof WorkerUnavailableError
            ? await this.repository.projectReplicaJobs.block(
                job.id,
                claimed.commandId,
                {
                  code: "worker-offline",
                  message: `The target worker disconnected during replica ${job.kind}. The job will resume after it reconnects.`,
                  retryable: true,
                },
              )
            : await this.repository.projectReplicaJobs.fail(
                job.id,
                claimed.commandId,
                {
                  code: "worker-error",
                  message:
                    error instanceof Error
                      ? error.message.slice(0, 4_000)
                      : `The worker failed to ${job.kind} the replica.`,
                  retryable: true,
                },
              );
        this.onChanged({ ownerId: claimed.ownerId, job: settled });
      } catch (settleError) {
        if (!(settleError instanceof ProjectReplicaJobStaleAttemptError)) {
          throw settleError;
        }
      }
    } finally {
      clearInterval(renewalTimer);
    }
  }

  private assertCurrentResult(
    job: ProjectReplicaJobSummary,
    result: { jobId: string; attempt: number },
  ): void {
    if (result.jobId !== job.id || result.attempt !== job.attempt) {
      throw new ProjectReplicaJobStaleAttemptError(
        "The worker response does not match the active replica job attempt.",
      );
    }
  }
}
