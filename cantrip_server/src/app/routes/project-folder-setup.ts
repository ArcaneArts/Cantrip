import {
  encryptedManagedFolderProjectCreateSchema,
  projectFolderSetupJobSummarySchema,
  projectFolderSetupRetrySchema,
  projectWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ProjectWorkspaceInvariantError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import type { ProjectFolderSetupLiveChange } from "../../project-folders/executor.js";

export interface ProjectFolderSetupRouteDependencies {
  applicationOwnerId: () => string;
  publishProjectFolderSetupChange: (
    change: ProjectFolderSetupLiveChange,
  ) => void;
  queueProjectFolderSetupJobs: () => void;
  repository: ServerRepository;
}

export function installProjectFolderSetupRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    publishProjectFolderSetupChange,
    queueProjectFolderSetupJobs,
    repository,
  }: ProjectFolderSetupRouteDependencies,
): void {
  app.post("/api/projects/from-folder", async (request, reply) => {
    const input = encryptedManagedFolderProjectCreateSchema.safeParse(
      request.body,
    );
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const worker = await repository.getWorker(
      applicationOwnerId(),
      input.data.workerId,
    );
    if (!worker) {
      return reply.code(404).send({ error: "Worker not found." });
    }
    if (!worker.managedFolders.create) {
      return reply.code(409).send({
        code: "managed-folder-capability-unavailable",
        error: "This worker does not support managed folder creation.",
      });
    }
    if (input.data.existingPath && !worker.managedFolders.attachExisting) {
      return reply.code(409).send({
        code: "managed-folder-capability-unavailable",
        error: "This worker does not support attaching existing folders.",
      });
    }
    try {
      const created = await repository.createManagedFolderProject(
        applicationOwnerId(),
        input.data,
      );
      publishProjectFolderSetupChange({
        ownerId: applicationOwnerId(),
        job: created.job,
      });
      queueProjectFolderSetupJobs();
      return reply
        .code(202)
        .send(projectWireSummarySchema.parse(created.project));
    } catch (error) {
      if (error instanceof ProjectWorkspaceInvariantError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/folder-setup",
    async (request, reply) => {
      const project = await repository.getProject(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (project.originKind !== "managed-folder") {
        return reply.code(409).send({
          code: "managed-folder-capability-unavailable",
          error: "Folder setup is available only for folder projects.",
        });
      }
      const job = await repository.projectFolderSetupJobs.get(
        applicationOwnerId(),
        request.params.projectId,
      );
      return job
        ? reply.send(projectFolderSetupJobSummarySchema.parse(job))
        : reply.code(404).send({ error: "Folder setup job not found." });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/folder-setup/retry",
    async (request, reply) => {
      const input = projectFolderSetupRetrySchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const project = await repository.getProject(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (project.originKind !== "managed-folder") {
        return reply.code(409).send({
          code: "managed-folder-capability-unavailable",
          error: "Folder setup retry is available only for folder projects.",
        });
      }
      const job = await repository.projectFolderSetupJobs.retry(
        applicationOwnerId(),
        request.params.projectId,
        input.data.stateRevision,
      );
      if (!job) {
        return reply.code(409).send({
          error: "Folder setup changed or is not retryable.",
        });
      }
      publishProjectFolderSetupChange({
        ownerId: applicationOwnerId(),
        job,
      });
      queueProjectFolderSetupJobs();
      return reply.send(projectFolderSetupJobSummarySchema.parse(job));
    },
  );
}
