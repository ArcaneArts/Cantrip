import {
  encryptedProjectReplicaProvisionCreateSchema,
  encryptedProjectReplicaRemoveCreateSchema,
  encryptedProjectReplicaSynchronizeCreateSchema,
  projectReplicaJobCancelSchema,
  projectReplicaJobListSchema,
  projectReplicaJobRetrySchema,
  projectReplicaJobSummarySchema,
  projectReplicaLinkRepairResultSchema,
  projectReplicaListSchema,
  projectReplicaSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ProjectReplicaJobConflictError,
  ProjectReplicaJobNotFoundError,
} from "../../db/project-replica-jobs.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { ProjectReplicaJobLiveChange } from "../../project-replicas/executor.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectReplicaRouteDependencies {
  applicationOwnerId: () => string;
  bridge: WorkerCommandBus;
  publishProjectReplicaJobChange: (change: ProjectReplicaJobLiveChange) => void;
  queueProjectReplicaJobs: () => void;
  repository: ServerRepository;
}

export function installProjectReplicaRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishProjectReplicaJobChange,
    queueProjectReplicaJobs,
    repository,
  }: ProjectReplicaRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/replicas",
    async (request, reply) => {
      const replicas = await repository.listProjectReplicas(
        applicationOwnerId(),
        request.params.projectId,
      );
      return replicas
        ? reply.send(projectReplicaListSchema.parse(replicas))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.get<{ Params: { projectId: string; replicaId: string } }>(
    "/api/projects/:projectId/replicas/:replicaId",
    async (request, reply) => {
      const replica = await repository.getProjectReplica(
        applicationOwnerId(),
        request.params.projectId,
        request.params.replicaId,
      );
      return replica
        ? reply.send(projectReplicaSummarySchema.parse(replica))
        : reply.code(404).send({ error: "Project replica not found." });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/replicas",
    async (request, reply) => {
      const input = encryptedProjectReplicaProvisionCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const job = await repository.projectReplicaJobs.createProvision(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        publishProjectReplicaJobChange({
          ownerId: applicationOwnerId(),
          job,
        });
        queueProjectReplicaJobs();
        return reply.code(202).send(projectReplicaJobSummarySchema.parse(job));
      } catch (error) {
        if (error instanceof ProjectReplicaJobNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof ProjectReplicaJobConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string; replicaId: string } }>(
    "/api/projects/:projectId/replicas/:replicaId/repair-link",
    async (request, reply) => {
      const context = await repository.projectReplicaJobs.linkRepairContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.replicaId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Project replica not found." });
      }
      if (
        context.placementMode !== "managed-link" ||
        context.ownershipKind !== "cantrip" ||
        !context.repository ||
        !context.repositoryFingerprint ||
        !context.linkPath
      ) {
        return reply.code(409).send({
          code: "link-unsupported",
          error: "This replica does not have a repairable managed link.",
        });
      }
      if (!context.workerSupportsRepair) {
        return reply.code(409).send({
          code: "capability-missing",
          error: "The replica worker does not support managed-link repair.",
        });
      }
      try {
        const result = projectReplicaLinkRepairResultSchema.parse(
          await bridge.request(context.workerId, {
            type: "project.replica.link.repair",
            projectId: request.params.projectId,
            repository: { nameWithOwner: context.repository },
            sourcePath: context.sourcePath,
            linkPath: context.linkPath,
            repositoryFingerprint: context.repositoryFingerprint,
          }),
        );
        return result.status === "blocked"
          ? reply.code(409).send({
              code: result.error.code,
              error: "Replica link repair was blocked.",
            })
          : reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; replicaId: string } }>(
    "/api/projects/:projectId/replicas/:replicaId/synchronize",
    async (request, reply) => {
      const input = encryptedProjectReplicaSynchronizeCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const job = await repository.projectReplicaJobs.createSynchronize(
          applicationOwnerId(),
          request.params.projectId,
          request.params.replicaId,
          input.data,
        );
        publishProjectReplicaJobChange({
          ownerId: applicationOwnerId(),
          job,
        });
        queueProjectReplicaJobs();
        return reply.code(202).send(projectReplicaJobSummarySchema.parse(job));
      } catch (error) {
        if (error instanceof ProjectReplicaJobNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof ProjectReplicaJobConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string; replicaId: string } }>(
    "/api/projects/:projectId/replicas/:replicaId/remove",
    async (request, reply) => {
      const input = encryptedProjectReplicaRemoveCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const job = await repository.projectReplicaJobs.createRemove(
          applicationOwnerId(),
          request.params.projectId,
          request.params.replicaId,
          input.data,
        );
        publishProjectReplicaJobChange({
          ownerId: applicationOwnerId(),
          job,
        });
        queueProjectReplicaJobs();
        return reply.code(202).send(projectReplicaJobSummarySchema.parse(job));
      } catch (error) {
        if (error instanceof ProjectReplicaJobNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof ProjectReplicaJobConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/replica-jobs",
    async (request, reply) => {
      const jobs = await repository.projectReplicaJobs.list(
        applicationOwnerId(),
        request.params.projectId,
      );
      return jobs
        ? reply.send(projectReplicaJobListSchema.parse(jobs))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/project-replica-jobs/:jobId",
    async (request, reply) => {
      const job = await repository.projectReplicaJobs.get(
        applicationOwnerId(),
        request.params.jobId,
      );
      return job
        ? reply.send(projectReplicaJobSummarySchema.parse(job))
        : reply.code(404).send({ error: "Project replica job not found." });
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/api/project-replica-jobs/:jobId/retry",
    async (request, reply) => {
      const input = projectReplicaJobRetrySchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const existing = await repository.projectReplicaJobs.get(
        applicationOwnerId(),
        request.params.jobId,
      );
      if (!existing) {
        return reply
          .code(404)
          .send({ error: "Project replica job not found." });
      }
      const job = await repository.projectReplicaJobs.retry(
        applicationOwnerId(),
        request.params.jobId,
        input.data.stateRevision,
      );
      if (!job) {
        return reply.code(409).send({
          error: "The job changed or is not in a retryable state.",
        });
      }
      publishProjectReplicaJobChange({
        ownerId: applicationOwnerId(),
        job,
      });
      queueProjectReplicaJobs();
      return reply.send(projectReplicaJobSummarySchema.parse(job));
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/api/project-replica-jobs/:jobId/cancel",
    async (request, reply) => {
      const input = projectReplicaJobCancelSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const existing = await repository.projectReplicaJobs.get(
        applicationOwnerId(),
        request.params.jobId,
      );
      if (!existing) {
        return reply
          .code(404)
          .send({ error: "Project replica job not found." });
      }
      const job = await repository.projectReplicaJobs.cancel(
        applicationOwnerId(),
        request.params.jobId,
        input.data.stateRevision,
      );
      if (!job) {
        return reply.code(409).send({
          error:
            "The job changed or has crossed the safe cancellation boundary.",
        });
      }
      publishProjectReplicaJobChange({
        ownerId: applicationOwnerId(),
        job,
      });
      return reply.send(projectReplicaJobSummarySchema.parse(job));
    },
  );
}
