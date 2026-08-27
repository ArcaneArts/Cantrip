import {
  executionPlacementResolutionSchema,
  executionPlacementResolveRequestSchema,
  executionTargetResolutionSchema,
  executionTargetResolveRequestSchema,
  executionTargetWireCatalogSchema,
  projectWireListSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ExecutionPlacementUnavailableError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectCatalogAndPlacementRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected">;
  repository: ServerRepository;
}

export function installProjectCatalogAndPlacementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
  }: ProjectCatalogAndPlacementRouteDependencies,
): void {
  app.get("/api/projects", async (_request, reply) => {
    const projects = await repository.listProjects(applicationOwnerId());
    return reply.send(projectWireListSchema.parse(projects));
  });

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/placement/resolve",
    async (request, reply) => {
      const input = executionPlacementResolveRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const resolution = await repository.resolveProjectExecutionPlacement(
          applicationOwnerId(),
          request.params.projectId,
          input.data.surfaceKind,
          input.data.target,
          (workerId) => bridge.isConnected(workerId),
        );
        return reply.send(executionPlacementResolutionSchema.parse(resolution));
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          return reply
            .code(error.code === "project-not-found" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/execution-targets",
    async (request, reply) => {
      const catalog = await repository.listProjectExecutionTargets(
        applicationOwnerId(),
        request.params.projectId,
        (workerId) => bridge.isConnected(workerId),
      );
      return catalog
        ? reply.send(executionTargetWireCatalogSchema.parse(catalog))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/execution-targets/resolve",
    async (request, reply) => {
      const input = executionTargetResolveRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const resolution = await repository.resolveExecutionTarget(
          applicationOwnerId(),
          request.params.projectId,
          input.data.target,
          (workerId) => bridge.isConnected(workerId),
          input.data.allowUnavailable,
        );
        return reply.send(executionTargetResolutionSchema.parse(resolution));
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          return reply
            .code(error.code === "project-not-found" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
    },
  );
}
