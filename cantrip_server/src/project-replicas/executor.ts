import {
  projectReplicaProvisionResultSchema,
  type ProjectReplicaJobSummary,
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

export class ProjectReplicaJobExecutor {
  readonly #active = new Set<Promise<void>>();
  #drainPromise: Promise<void> | null = null;
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

  async recoverAfterRestart(): Promise<number> {
    return this.repository.projectReplicaJobs.recoverInterrupted();
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
      if (
        !worker.projectReplicas.provision ||
        !worker.projectReplicas.exactRevision
      ) {
        const blocked = await this.repository.projectReplicaJobs.block(
          job.id,
          claimed.commandId,
          {
            code: "capability-missing",
            message:
              "The target worker does not advertise exact-revision replica provisioning.",
            retryable: false,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      if (job.kind !== "provision") {
        const failed = await this.repository.projectReplicaJobs.fail(
          job.id,
          claimed.commandId,
          {
            code: "capability-missing",
            message: `Replica job kind ${job.kind} is not enabled by this server version.`,
            retryable: false,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: failed });
        return;
      }
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
          {
            timeoutMs: null,
            onEvent: async (event) => {
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
              const updated =
                await this.repository.projectReplicaJobs.updateProgress(
                  job.id,
                  claimed.commandId,
                  job.attempt,
                  event.progress,
                );
              if (updated) {
                this.onChanged({ ownerId: claimed.ownerId, job: updated });
              }
            },
          },
        ),
      );
      if (result.jobId !== job.id || result.attempt !== job.attempt) {
        throw new ProjectReplicaJobStaleAttemptError(
          "The worker response does not match the active replica job attempt.",
        );
      }
      const settled =
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
                  message:
                    "The target worker disconnected during provisioning. The job will resume after it reconnects.",
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
                      : "The worker failed to provision the replica.",
                  retryable: true,
                },
              );
        this.onChanged({ ownerId: claimed.ownerId, job: settled });
      } catch (settleError) {
        if (!(settleError instanceof ProjectReplicaJobStaleAttemptError)) {
          throw settleError;
        }
      }
    }
  }
}
