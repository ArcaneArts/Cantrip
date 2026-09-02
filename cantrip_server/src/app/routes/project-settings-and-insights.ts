import {
  orderedIdsSchema,
  projectPreferredWorkerUpdateSchema,
  projectRepositoryStatsSchema,
  projectTokenUsageSchema,
  projectWireSummarySchema,
  projectWorktreePolicyUpdateSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ProjectPreferredWorkerConflictError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectPreferenceRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<
    ServerRepository,
    "updateProjectPreferredWorker" | "updateProjectWorktreePolicy"
  >;
}

export interface ProjectInsightRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    "getProject" | "getProjectSource" | "getProjectTokenUsage"
  >;
}

export interface ProjectOrderRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "reorderProjects">;
}

export function installProjectPreferenceRoutes(
  app: FastifyInstance,
  { applicationOwnerId, repository }: ProjectPreferenceRouteDependencies,
): void {
  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/preferred-worker",
    async (request, reply) => {
      const input = projectPreferredWorkerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const project = await repository.updateProjectPreferredWorker(
          applicationOwnerId(),
          request.params.projectId,
          input.data.workerId,
        );
        return project
          ? reply.send(projectWireSummarySchema.parse(project))
          : reply.code(404).send({ error: "Project or worker not found." });
      } catch (error) {
        if (error instanceof ProjectPreferredWorkerConflictError) {
          return reply.code(409).send({
            code: "target-mismatch",
            error: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktree-policy",
    async (request, reply) => {
      const input = projectWorktreePolicyUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const project = await repository.updateProjectWorktreePolicy(
        applicationOwnerId(),
        request.params.projectId,
        input.data,
      );
      return project
        ? reply.send(projectWireSummarySchema.parse(project))
        : reply.code(404).send({ error: "Project not found." });
    },
  );
}

export function installProjectInsightRoutes(
  app: FastifyInstance,
  { applicationOwnerId, bridge, repository }: ProjectInsightRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/repository-stats",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const [project, source] = await Promise.all([
        repository.getProject(ownerId, request.params.projectId),
        repository.getProjectSource(ownerId, request.params.projectId, {
          isWorkerAvailable: (workerId) => bridge.isConnected(workerId),
        }),
      ]);
      if (!project || !source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      try {
        const stats = await bridge.request(
          source.workerId,
          project.capabilities.git
            ? { type: "project.repository-stats", cwd: source.cwd }
            : { type: "project.folder-stats", root: source.cwd },
          { timeoutMs: 30_000 },
        );
        const parsed = projectRepositoryStatsSchema.parse(stats);
        if (project.capabilities.git !== (parsed.kind === "git")) {
          throw new Error(
            "Worker returned statistics for the wrong project kind.",
          );
        }
        return reply.send(parsed);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/token-usage",
    async (request, reply) => {
      const usage = await repository.getProjectTokenUsage(
        applicationOwnerId(),
        request.params.projectId,
      );
      return usage
        ? reply.send(projectTokenUsageSchema.parse(usage))
        : reply.code(404).send({ error: "Project not found." });
    },
  );
}

export function installProjectOrderRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository }: ProjectOrderRouteDependencies,
): void {
  app.patch("/api/projects/order", async (request, reply) => {
    const input = orderedIdsSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    return (await repository.reorderProjects(applicationOwnerId(), input.data))
      ? reply.code(204).send()
      : reply.code(400).send({ error: "Project order did not match." });
  });
}
