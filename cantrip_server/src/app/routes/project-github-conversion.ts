import {
  encryptedProjectGithubConversionPreflightRequestSchema,
  encryptedProjectGithubConversionStartSchema,
  projectGithubConversionJobSummarySchema,
  projectGithubConversionPreflightResultSchema,
  projectGithubConversionRetrySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";
import {
  ProjectGithubConversionJobConflictError,
  ProjectGithubConversionJobNotFoundError,
} from "../../db/project-github-conversion-jobs.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { ProjectGithubConversionLiveChange } from "../../project-github-conversions/executor.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectGithubConversionRouteDependencies {
  applicationOwnerId: () => string;
  bridge: WorkerCommandBus;
  publishProjectGithubConversionChange: (
    change: ProjectGithubConversionLiveChange,
  ) => void;
  queueProjectGithubConversionJobs: () => void;
  repository: ServerRepository;
}

export function installProjectGithubConversionRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishProjectGithubConversionChange,
    queueProjectGithubConversionJobs,
    repository,
  }: ProjectGithubConversionRouteDependencies,
): void {
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/github-conversion/preflight",
    async (request, reply) => {
      const input =
        encryptedProjectGithubConversionPreflightRequestSchema.safeParse(
          request.body,
        );
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
      if (
        project.originKind !== "managed-folder" ||
        project.setupStatus !== "ready" ||
        project.folderManagement !== "managed"
      ) {
        return reply.code(409).send({
          code: "project-not-ready",
          error:
            "Only a ready folder managed by Cantrip can be converted. Attached folders remain user-owned.",
        });
      }
      if (
        await repository.projectGithubConversionJobs.hasActiveProjectJob(
          project.id,
        )
      ) {
        return reply.code(409).send({
          code: "transition-active",
          error: "A GitHub conversion is already active for this project.",
        });
      }
      if (
        await repository.hasGithubProject(
          applicationOwnerId(),
          input.data.repositoryBlindIndex,
        )
      ) {
        return reply.code(409).send({
          code: "repository-collision",
          error:
            "This GitHub repository is already bound to another Cantrip project.",
        });
      }
      const workerId = project.preferredWorkerId;
      if (!workerId) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "The folder project no longer has an owning worker.",
        });
      }
      const worker = await repository.getWorker(applicationOwnerId(), workerId);
      const workspaceStorage =
        await repository.getProjectWorkspaceStorageContext(
          applicationOwnerId(),
          project.id,
        );
      if (!workspaceStorage) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "Project workspace storage is unavailable.",
        });
      }
      if (
        !worker?.managedFolders.convertToGithub ||
        (workspaceStorage.kind === "managed" &&
          !worker.managedFolders.workspaceScopedRoots)
      ) {
        return reply.code(409).send({
          code: "capability-missing",
          error:
            "The owning worker does not support managed folder conversion for this workspace.",
        });
      }
      if (!bridge.isConnected(workerId)) {
        return reply.code(503).send({
          code: "worker-offline",
          error: "The owning worker must be online before conversion.",
        });
      }
      try {
        return reply.send(
          projectGithubConversionPreflightResultSchema.parse(
            await bridge.request(
              workerId,
              {
                type: "project.folder-conversion.preflight",
                projectId: project.id,
                repository: input.data.repository,
                workspaceStorage,
              },
              { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
            ),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/github-conversion",
    async (request, reply) => {
      const input = encryptedProjectGithubConversionStartSchema.safeParse(
        request.body,
      );
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
      if (
        project.originKind !== "managed-folder" ||
        project.setupStatus !== "ready" ||
        project.folderManagement !== "managed"
      ) {
        return reply.code(409).send({
          code: "project-not-ready",
          error:
            "Only a ready folder managed by Cantrip can be converted. Attached folders remain user-owned.",
        });
      }
      const workerId = project.preferredWorkerId;
      if (!workerId) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "The folder project no longer has an owning worker.",
        });
      }
      const worker = await repository.getWorker(applicationOwnerId(), workerId);
      const workspaceStorage =
        await repository.getProjectWorkspaceStorageContext(
          applicationOwnerId(),
          project.id,
        );
      if (!workspaceStorage) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "Project workspace storage is unavailable.",
        });
      }
      if (
        !worker?.managedFolders.convertToGithub ||
        (workspaceStorage.kind === "managed" &&
          !worker.managedFolders.workspaceScopedRoots)
      ) {
        return reply.code(409).send({
          code: "capability-missing",
          error:
            "The owning worker does not support managed folder conversion for this workspace.",
        });
      }
      if (!bridge.isConnected(workerId)) {
        return reply.code(503).send({
          code: "worker-offline",
          error: "The owning worker must be online before conversion.",
        });
      }
      if (
        await repository.hasGithubProject(
          applicationOwnerId(),
          input.data.repositoryBlindIndex,
        )
      ) {
        return reply.code(409).send({
          code: "repository-collision",
          error:
            "This GitHub repository is already bound to another Cantrip project.",
        });
      }
      try {
        const job = await repository.projectGithubConversionJobs.create(
          applicationOwnerId(),
          project.id,
          workerId,
          input.data,
        );
        publishProjectGithubConversionChange({
          ownerId: applicationOwnerId(),
          job,
        });
        queueProjectGithubConversionJobs();
        return reply
          .code(202)
          .send(projectGithubConversionJobSummarySchema.parse(job));
      } catch (error) {
        if (error instanceof ProjectGithubConversionJobNotFoundError) {
          return reply.code(404).send({ error: "Project not found." });
        }
        if (error instanceof ProjectGithubConversionJobConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/github-conversion",
    async (request, reply) => {
      const project = await repository.getProject(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const job = await repository.projectGithubConversionJobs.get(
        applicationOwnerId(),
        project.id,
      );
      return job
        ? reply.send(projectGithubConversionJobSummarySchema.parse(job))
        : reply.code(404).send({ error: "GitHub conversion job not found." });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/github-conversion/retry",
    async (request, reply) => {
      const input = projectGithubConversionRetrySchema.safeParse(request.body);
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
          error: "The project is no longer a managed folder.",
        });
      }
      const job = await repository.projectGithubConversionJobs.retry(
        applicationOwnerId(),
        project.id,
        input.data.stateRevision,
      );
      if (!job) {
        return reply.code(409).send({
          error: "GitHub conversion changed or is not retryable.",
        });
      }
      publishProjectGithubConversionChange({
        ownerId: applicationOwnerId(),
        job,
      });
      queueProjectGithubConversionJobs();
      return reply.send(projectGithubConversionJobSummarySchema.parse(job));
    },
  );
}
