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

async function resolveConversionSource(
  repository: ServerRepository,
  bridge: WorkerCommandBus,
  ownerId: string,
  projectId: string,
  requested: { projectSourceId?: string; workerId?: string },
) {
  if (requested.projectSourceId && requested.workerId) {
    const source = await repository.getProjectReplica(
      ownerId,
      projectId,
      requested.projectSourceId,
    );
    return source?.workerId === requested.workerId ? source : null;
  }
  const selected = await repository.getProjectSource(ownerId, projectId, {
    isWorkerAvailable: (workerId) => bridge.isConnected(workerId),
  });
  return selected
    ? repository.getProjectReplica(
        ownerId,
        projectId,
        selected.projectReplicaId,
      )
    : null;
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
        project.setupStatus !== "ready"
      ) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "Only a ready folder or local Git project can be converted.",
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
      if (
        project.folderManagement === "external" &&
        (!input.data.projectSourceId || !input.data.workerId)
      ) {
        return reply.code(409).send({
          code: "source-required",
          error:
            "Refresh the project before converting so the request can bind to its exact local Git source.",
        });
      }
      const source = await resolveConversionSource(
        repository,
        bridge,
        applicationOwnerId(),
        project.id,
        input.data,
      );
      const managedFolderSource =
        project.folderManagement === "managed" &&
        source?.sourceKind === "folder" &&
        source.ownershipKind === "cantrip";
      const externalGitSource =
        project.folderManagement === "external" &&
        project.capabilities.git &&
        source?.sourceKind === "git" &&
        source.ownershipKind === "user";
      if (!source?.ready || (!managedFolderSource && !externalGitSource)) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "The project no longer has an eligible conversion source.",
        });
      }
      const workerId = source.workerId;
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
        (externalGitSource &&
          !worker.managedFolders.convertExternalGitToGithub) ||
        (managedFolderSource &&
          workspaceStorage.kind === "managed" &&
          !worker.managedFolders.workspaceScopedRoots)
      ) {
        return reply.code(409).send({
          code: "capability-missing",
          error:
            "The source worker does not support GitHub conversion for this project.",
        });
      }
      if (!bridge.isConnected(workerId)) {
        return reply.code(503).send({
          code: "worker-offline",
          error: "The owning worker must be online before conversion.",
        });
      }
      try {
        const result = projectGithubConversionPreflightResultSchema.parse(
          await bridge.request(
            workerId,
            {
              type: "project.folder-conversion.preflight",
              projectId: project.id,
              repository: input.data.repository,
              workspaceStorage,
              ...(externalGitSource
                ? {
                    sourcePath: source.path,
                    sourceDisplayPath: source.displayPath,
                  }
                : {}),
            },
            { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
          ),
        );
        return reply.send(
          result.status === "ready"
            ? projectGithubConversionPreflightResultSchema.parse({
                ...result,
                projectSourceId: source.id,
                workerId,
              })
            : result,
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
        project.setupStatus !== "ready"
      ) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "Only a ready folder or local Git project can be converted.",
        });
      }
      if (
        project.folderManagement === "external" &&
        (!input.data.projectSourceId || !input.data.workerId)
      ) {
        return reply.code(409).send({
          code: "preflight-required",
          error:
            "Run conversion preflight again to bind this request to its exact local Git source.",
        });
      }
      const source = await resolveConversionSource(
        repository,
        bridge,
        applicationOwnerId(),
        project.id,
        input.data,
      );
      const managedFolderSource =
        project.folderManagement === "managed" &&
        source?.sourceKind === "folder" &&
        source.ownershipKind === "cantrip";
      const externalGitSource =
        project.folderManagement === "external" &&
        project.capabilities.git &&
        source?.sourceKind === "git" &&
        source.ownershipKind === "user";
      if (!source?.ready || (!managedFolderSource && !externalGitSource)) {
        return reply.code(409).send({
          code: "project-not-ready",
          error: "The project no longer has an eligible conversion source.",
        });
      }
      const workerId = source.workerId;
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
        (externalGitSource &&
          !worker.managedFolders.convertExternalGitToGithub) ||
        (managedFolderSource &&
          workspaceStorage.kind === "managed" &&
          !worker.managedFolders.workspaceScopedRoots)
      ) {
        return reply.code(409).send({
          code: "capability-missing",
          error:
            "The source worker does not support GitHub conversion for this project.",
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
          source.id,
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
